"""Configuration, multipart disk spooling and safe cross-volume delivery."""
import errno
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import pytest
from fastapi import FastAPI, UploadFile, File
from fastapi.testclient import TestClient

from backend.core import temp_storage
from backend.core.path_utils import get_temp_directory


@pytest.fixture(autouse=True)
def storage(tmp_path, monkeypatch):
    monkeypatch.setenv('AUTOCLIP_DATA_DIR', str(tmp_path / 'data'))
    from starlette import formparsers
    monkeypatch.setattr(formparsers, 'SpooledTemporaryFile', temp_storage.upload_spool)
    return tmp_path


def save(path):
    return temp_storage.save_settings(temp_storage.TempStorageSettings(directory=str(path)))


def test_default_uses_data_disk_not_system_temp(storage):
    original = tempfile.gettempdir()
    assert get_temp_directory() == storage / 'data' / 'temp'
    assert tempfile.gettempdir() == original
    assert temp_storage.status()['free_bytes'] > 0


def test_unicode_spaces_persist_and_worker_reads_without_restart(storage):
    root = storage / '媒体 缓存'
    result = save(root)
    assert result['effective_directory'] == str(root / 'AutoClipTemp')
    assert result['available']
    process = subprocess.run([sys.executable, '-c', 'from backend.core.path_utils import get_temp_directory; print(get_temp_directory())'],
                             capture_output=True, text=True, encoding='utf-8', check=True)
    assert process.stdout.strip() == str(root / 'AutoClipTemp')
    assert not temp_storage.settings_path().read_bytes().startswith(b'\xef\xbb\xbf')


@pytest.mark.parametrize('invalid', ['relative/folder', 'C:relative' if os.name == 'nt' else 'relative', 'bad\x00path'])
def test_bad_path_keeps_previous_setting(storage, invalid):
    save(storage / 'valid')
    previous = temp_storage.settings_path().read_bytes()
    with pytest.raises(temp_storage.TempStorageError, match='invalid_path'):
        save(invalid)
    assert temp_storage.settings_path().read_bytes() == previous


def test_file_instead_of_folder_keeps_setting(storage):
    save(storage / 'valid')
    blocker = storage / 'file'
    blocker.write_text('preserve', encoding='utf-8')
    with pytest.raises(temp_storage.TempStorageError, match='directory_not_writable'):
        save(blocker)
    assert temp_storage.load_settings().directory == str(storage / 'valid')
    assert blocker.read_text() == 'preserve'


def test_unwritable_directory_keeps_setting(storage, monkeypatch):
    save(storage / 'valid')
    def denied(*args, **kwargs):
        raise PermissionError('denied')
    monkeypatch.setattr(tempfile, 'TemporaryFile', denied)
    with pytest.raises(temp_storage.TempStorageError, match='directory_not_writable'):
        save(storage / 'denied')
    assert temp_storage.load_settings().directory == str(storage / 'valid')


def test_atomic_config_save_failure_keeps_previous_and_removes_own_partial(storage, monkeypatch):
    save(storage / 'valid')
    previous = temp_storage.settings_path().read_bytes()
    def denied(*args):
        raise PermissionError('denied')
    monkeypatch.setattr(temp_storage.os, 'replace', denied)
    with pytest.raises(PermissionError):
        save(storage / 'other')
    assert temp_storage.settings_path().read_bytes() == previous
    assert not list(temp_storage.settings_path().parent.glob('.temporary-storage.*.tmp'))


def test_switch_and_reset_preserve_active_files_and_unrelated_content(storage):
    selected = storage / 'selected'
    selected.mkdir()
    unrelated = selected / 'keep.txt'
    unrelated.write_text('keep')
    save(selected)
    with tempfile.TemporaryDirectory(dir=get_temp_directory()) as old:
        active = Path(old) / 'processing.wav'
        active.write_bytes(b'active')
        save(storage / 'new')
        assert get_temp_directory() == storage / 'new' / 'AutoClipTemp'
        assert active.read_bytes() == b'active'
        save('')
        assert get_temp_directory() == storage / 'data' / 'temp'
        assert active.read_bytes() == b'active'
    assert unrelated.read_text() == 'keep'


def test_saved_drive_unavailable_still_returns_editable_status(storage):
    save(storage / 'selected')
    directory = get_temp_directory()
    directory.rmdir()
    directory.write_text('unavailable')
    result = temp_storage.status()
    assert result['directory'] == str(storage / 'selected')
    assert not result['available'] and result['free_bytes'] is None


def test_multipart_rollover_uses_selected_disk_and_next_upload_sees_change(storage, monkeypatch):
    from backend.api.v1.settings import router
    app = FastAPI()
    app.include_router(router)
    allocations = []
    real_temporary_file = tempfile.TemporaryFile
    def record(*args, **kwargs):
        allocations.append(Path(kwargs['dir']))
        return real_temporary_file(*args, **kwargs)
    monkeypatch.setattr(tempfile, 'TemporaryFile', record)
    @app.post('/upload')
    async def upload(file: UploadFile = File(...)):
        assert file.file._rolled
        # A setting change after rollover must not relocate/close this upload.
        save(storage / 'next')
        return {'bytes': len(await file.read())}
    with TestClient(app) as client:
        response = client.put('/settings/temporary-storage', json={'directory': str(storage / 'first')})
        assert response.status_code == 200
        allocations.clear()
        body = b'x' * (2 * 1024 * 1024)
        assert client.post('/upload', files={'file': ('large.flv', body, 'video/x-flv')}).json() == {'bytes': len(body)}
        assert allocations[0] == storage / 'first' / 'AutoClipTemp'
        allocations.clear()
        assert client.post('/upload', files={'file': ('large.mp4', body, 'video/mp4')}).status_code == 200
        assert allocations[0] == storage / 'next' / 'AutoClipTemp'
        assert client.get('/settings/temporary-storage').json()['directory'] == str(storage / 'next')
        assert client.put('/settings/temporary-storage', json={'directory': 'relative'}).status_code == 422
        assert client.get('/settings/temporary-storage').json()['directory'] == str(storage / 'next')


def test_app_factory_installs_spool_factory(storage, monkeypatch):
    from starlette import formparsers
    from backend.app_factory import create_app
    monkeypatch.setattr(formparsers, 'SpooledTemporaryFile', tempfile.SpooledTemporaryFile)
    create_app()
    assert formparsers.SpooledTemporaryFile is temp_storage.upload_spool


def test_legacy_settings_show_current_path_without_blocking_other_settings(storage, monkeypatch):
    from types import SimpleNamespace
    from backend.api.v1 import settings as api
    data = storage / 'data'
    data.mkdir(exist_ok=True)
    monkeypatch.setattr(api, 'get_desktop_config', lambda: SimpleNamespace(paths=SimpleNamespace(data_dir=data)))
    legacy = api.DesktopSettings(paths=api.PathSettings(data_directory=str(data), cache_directory=str(data / 'cache'), temp_directory='old-temp'))
    (data / 'settings.json').write_text(legacy.model_dump_json(), encoding='utf-8')
    save(storage / 'custom')
    current = get_temp_directory()
    current.rmdir()
    current.write_text('unavailable')
    app = FastAPI()
    app.include_router(api.router)
    with TestClient(app) as client:
        response = client.get('/settings/')
        assert response.status_code == 200
        assert response.json()['paths']['temp_directory'] == str(current)
        assert response.json()['api'] == legacy.api.model_dump()


@pytest.mark.parametrize('enabled', [False, True])
def test_cross_volume_output_keeps_content_when_branding_disabled_or_fails(storage, monkeypatch, enabled):
    from backend.services import output_branding as branding
    source, destination = storage / 'source.mp4', storage / 'output.mp4'
    source.write_bytes(b'new-video')
    destination.write_bytes(b'old-video')
    real_replace = os.replace
    def cross_disk(src, dst):
        if Path(src) == source:
            raise OSError(errno.EXDEV, 'different drives')
        return real_replace(src, dst)
    def broken(*args):
        raise OSError('outro failed')
    monkeypatch.setattr(branding.os, 'replace', cross_disk)
    monkeypatch.setattr(branding, '_append', broken)
    assert branding.append_outro(source, destination, width=640, height=360, enabled=enabled) is False
    assert destination.read_bytes() == b'new-video' and not source.exists()
    assert not list(storage.glob('*.part'))


def test_cross_volume_copy_failure_preserves_old_output_and_source(storage, monkeypatch):
    from backend.services import output_branding as branding
    source, destination = storage / 'source.mp4', storage / 'output.mp4'
    source.write_bytes(b'new-video')
    destination.write_bytes(b'old-video')
    def cross_disk(*args):
        raise OSError(errno.EXDEV, 'different drives')
    def broken(src, dst):
        Path(dst).write_bytes(b'partial')
        raise OSError('disk full')
    monkeypatch.setattr(branding.os, 'replace', cross_disk)
    monkeypatch.setattr(branding.shutil, 'copy2', broken)
    with pytest.raises(OSError, match='disk full'):
        branding.append_outro(source, destination, width=640, height=360, enabled=False)
    assert destination.read_bytes() == b'old-video' and source.read_bytes() == b'new-video'
    assert not list(storage.glob('*.part'))


def test_real_ffmpeg_speaker_render_and_zip_use_custom_scratch(storage, monkeypatch):
    from backend.core.path_utils import get_project_directory
    from backend.services.studio import render, publish_kit
    from backend.services.studio.models import Draft, Scene
    from backend.tests.test_speaker_platform_rendering import document, no_models
    no_models(monkeypatch)
    save(storage / '渲染 工作区')
    scratch = get_temp_directory()
    project = get_project_directory('temp-test')
    video = project / 'input.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=2:r=25',
                    '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', str(video)], check=True, timeout=30)
    allocations = []
    real_directory = tempfile.TemporaryDirectory
    def record(*args, **kwargs):
        folder = real_directory(*args, **kwargs)
        allocations.append(Path(folder.name))
        return folder
    monkeypatch.setattr(tempfile, 'TemporaryDirectory', record)
    draft = Draft(id='temp-render', title='自定义目录', scenes=[Scene(id='s', start=0, end=1.5)],
                  aspect='original', speaker_subtitles=document())
    result = render.render_draft('temp-test', video, draft, 'render', lambda _: None)
    output = project / 'output' / 'studio' / 'render.mp4'
    assert result['duration'] == pytest.approx(1.5, abs=.1)
    assert allocations and all(path.is_relative_to(scratch) for path in allocations)
    assert all(not path.exists() for path in allocations)
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(output), '-f', 'null', '-'], check=True, timeout=30)
    archive, name = publish_kit.kit_file(output, None, {'title': '中文 成片'}, 'B站')
    try:
        assert archive.parent == scratch and archive.stat().st_size > 0
        import zipfile
        with zipfile.ZipFile(archive) as package:
            assert package.testzip() is None
            assert any(item.endswith('.mp4') for item in package.namelist())
        assert name.endswith('.zip')
    finally:
        archive.unlink()


def test_long_audio_work_moves_but_checkpoints_remain_resumable(storage, monkeypatch):
    from backend.services import long_audio
    save(storage / '音频 暂存')
    folder = storage / 'project-checkpoints'
    folder.mkdir()
    calls = []
    monkeypatch.setattr(long_audio, 'extract', lambda video, path, *args: path.write_bytes(b'audio'))
    def infer(audio, work, part):
        assert audio.parent == work and work.parent == get_temp_directory()
        calls.append(part['index'])
        return {'chunk': part['index']}
    validate = lambda value, part: value
    result = long_audio.process_chunks(storage / 'video.mp4', {'duration_ms': 1000}, folder, 'key', infer, validate)
    assert (folder / 'chunk-00000.json').exists()
    save(storage / 'another')
    assert long_audio.process_chunks(storage / 'video.mp4', {'duration_ms': 1000}, folder, 'key', infer, validate) == result
    assert calls == [0]
