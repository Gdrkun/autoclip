"""Local FLV import, source resolution, preview and export without provider calls."""
import hashlib
import json
import subprocess
from types import SimpleNamespace

import pytest

from backend.tests.test_studio import client, root, source  # noqa: F401
from backend.tests.test_cli import data_dir, isolated_db  # noqa: F401
from backend.services.studio import jobs, preview, store
from backend.services.studio.models import Draft, Scene


def make_flv(source, target):
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(source), '-c', 'copy',
                    '-f', 'flv', '-y', str(target)], check=True)
    return target


def media_info(path):
    return json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path),
    ]))


@pytest.mark.parametrize('filename,mime', [('recording.flv', 'video/x-flv'),
                                          ('recording.FLV', 'application/octet-stream')])
def test_studio_flv_upload_preview_audio_and_export(client, source, tmp_path, monkeypatch, filename, mime):
    original = make_flv(source, tmp_path / filename)
    content = original.read_bytes()
    captured = []
    monkeypatch.setattr(jobs, 'inspect_project', lambda *args, **kwargs: captured.append(args))
    response = client.post('/studio/import', data={'name': 'FLV local', 'auto_start': 'false'},
                           files={'video': (filename, content, mime),
                                  'subtitle': ('captions.srt', b'1\n00:00:00,000 --> 00:00:02,000\nHello\n', 'text/plain')})
    assert response.status_code == 200, response.text
    pid = response.json()['project_id']
    raw = store.directory(pid) / 'raw'
    # An unrelated subtitle must not be resolved as the source video.
    (raw / 'input.ass').write_text('subtitle', encoding='utf-8')
    video = jobs.source(pid)
    assert video == raw / 'input.flv' and video.read_bytes() == content
    assert captured[0][0] == pid
    from backend.core.database import SessionLocal
    from backend.models import Project
    with SessionLocal() as db:
        assert db.get(Project, pid).video_path == str(video)
    assert {'video', 'audio'} <= {s['codec_type'] for s in media_info(video)['streams']}

    class Immediate:
        def submit(self, function, *args, **kwargs):
            function(*args, **kwargs)

    monkeypatch.setattr(preview, '_executor', Immediate())
    assert preview.start(pid)['status'] == 'completed'
    preview_info = media_info(preview.ready_file(pid))
    assert next(s for s in preview_info['streams'] if s['codec_type'] == 'video')['codec_name'] == 'h264'
    assert any(s['codec_type'] == 'audio' for s in preview_info['streams'])
    wav = tmp_path / 'audio.wav'
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(video), '-vn', '-ar', '16000', '-ac', '1', str(wav)], check=True)
    assert wav.stat().st_size > 1000

    from backend.services.studio.render import render_draft
    draft = Draft(id='flv-draft', title='FLV export', subtitles=False,
                  scenes=[Scene(id='flv-scene', start=.2, end=2.2)])
    result = render_draft(pid, video, draft, 'flv-export', lambda _: None)
    output = store.directory(pid) / 'output/studio/flv-export.mp4'
    assert abs(result['duration'] - 2) < .15
    assert {'video', 'audio'} <= {s['codec_type'] for s in media_info(output)['streams']}
    subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], check=True)
    assert hashlib.sha256(video.read_bytes()).digest() == hashlib.sha256(content).digest()


@pytest.mark.parametrize('filename,content', [('empty.flv', b''), ('unsupported.exe', b'not-video')])
def test_invalid_upload_does_not_create_project(client, filename, content, monkeypatch):
    monkeypatch.setattr(jobs, 'inspect_project', lambda *a, **k: pytest.fail('must not start processing'))
    from backend.core.database import SessionLocal
    from backend.models import Project
    with SessionLocal() as db:
        before = db.query(Project).count()
    response = client.post('/studio/import', files={'video': (filename, content, 'application/octet-stream')})
    assert response.status_code == 422
    with SessionLocal() as db:
        assert db.query(Project).count() == before


def test_legacy_upload_accepts_flv_and_preserves_extension(client, source, tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.api.v1.projects import router
    from backend.core import database
    from backend.tasks.import_processing import process_import_task
    import backend.utils.thumbnail_generator as thumbnail
    captured = []
    monkeypatch.setattr(thumbnail, 'generate_project_thumbnail', lambda *a, **k: None)
    monkeypatch.setattr(process_import_task, 'delay', lambda **kwargs: captured.append(kwargs) or SimpleNamespace(id='local-fixture'))
    app = FastAPI()
    app.include_router(router, prefix='/projects')
    def get_db():
        with database.SessionLocal() as db:
            yield db
    app.dependency_overrides[database.get_db] = get_db
    content = make_flv(source, tmp_path / 'legacy.flv').read_bytes()
    with TestClient(app) as legacy:
        response = legacy.post('/projects/upload', data={'project_name': 'Legacy FLV'},
                               files={'video_file': ('recording.FLV', content, 'video/x-flv')})
    assert response.status_code == 200, response.text
    from pathlib import Path
    video = Path(response.json()['video_path'])
    assert video.name == 'input.flv' and video.read_bytes() == content
    assert captured[0]['video_path'] == str(video)


def test_quick_output_accepts_flv(data_dir, isolated_db, tmp_path, monkeypatch):
    from backend.services import quick_output_runner as quick
    import backend.utils.thumbnail_generator as thumbnail
    monkeypatch.setattr(thumbnail, 'generate_project_thumbnail', lambda *a, **k: None)
    captured = []
    monkeypatch.setattr(jobs, 'inspect_project', lambda *args, **kwargs: captured.append(args))
    video = tmp_path / 'recording.FLV'
    video.write_bytes(b'FLV-local-import-fixture')
    pid = quick.start(str(video), ['original'])
    assert jobs.source(pid).name == 'input.flv'
    assert jobs.source(pid).read_bytes() == video.read_bytes()
    assert captured[0][0] == pid
