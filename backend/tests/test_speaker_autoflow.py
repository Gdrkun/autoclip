"""Automatic diarization of existing transcripts, without paid calls or rewriting text."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.services import speaker_integration as integration
from backend.services.ai_model_settings import Transcription
from backend.services.studio import jobs, store
from backend.tests.test_speaker_integration import document, project  # noqa: F401


def test_editor_ensure_is_queued_once_and_completes_without_retranscription(project, prepared, monkeypatch):
    from backend.services import speaker_autoflow
    submitted = []
    monkeypatch.setattr(integration._executor, 'submit', lambda *args: submitted.append(args))
    calls = []
    def infer(video, **kwargs):
        calls.append(kwargs)
        assert kwargs['subtitles'] == prepared[1]
        return document(), project
    monkeypatch.setattr(integration, 'execute', infer)
    first = speaker_autoflow.enqueue('speaker-test')
    assert first['status'] == 'queued' and first['automatic']
    assert speaker_autoflow.enqueue('speaker-test')['job_id'] == first['job_id']
    assert len(submitted) == 1
    submitted[0][0](*submitted[0][1:])
    assert len(calls) == 1
    assert integration.job_state('speaker-test')['status'] == 'completed'
    assert integration.load_document('speaker-test') == document()
    speaker_autoflow.enqueue('speaker-test')
    assert len(submitted) == 1


def test_editor_ensure_does_not_start_when_disabled_or_paused(project, prepared, monkeypatch):
    from backend.services import speaker_autoflow
    monkeypatch.setattr(integration._executor, 'submit', lambda *a: pytest.fail('do not restart'))
    prepared[2].speaker_diarization = False
    assert speaker_autoflow.enqueue('speaker-test') == {'status': 'disabled'}
    prepared[2].speaker_diarization = True
    integration.atomic_json(integration.job_path('speaker-test'), {'status': 'cancelled', 'job_id': 'paused'})
    assert speaker_autoflow.enqueue('speaker-test')['status'] == 'cancelled'


@pytest.mark.parametrize('pause', [True, False])
def test_editor_queued_pause_and_failure_preserve_transcript(project, prepared, monkeypatch, pause):
    from backend.services import speaker_autoflow
    submitted = []
    monkeypatch.setattr(integration._executor, 'submit', lambda *args: submitted.append(args))
    job = speaker_autoflow.enqueue('speaker-test')
    before = prepared[1].read_bytes()
    def infer(*args, **kwargs):
        if pause:
            pytest.fail('paused queued work must not run')
        raise ValueError('specific recognition failure')
    monkeypatch.setattr(integration, 'execute', infer)
    if pause:
        integration.atomic_json(integration.job_path('speaker-test').with_name('speaker_stop.json'), {'job_id': job['job_id']})
    submitted[0][0](*submitted[0][1:])
    state = integration.job_state('speaker-test')
    assert state['status'] == ('cancelled' if pause else 'failed')
    if not pause:
        assert state['error'] == 'specific recognition failure'
    assert prepared[1].read_bytes() == before
    assert not integration.sidecar('speaker-test').exists()


def test_editor_get_only_reads_and_post_queues_automatically(project, prepared, monkeypatch):
    from backend.api.v1 import studio
    from backend.services import speaker_autoflow
    monkeypatch.setattr(studio, 'project_or_404', lambda *a: None)
    called = []
    monkeypatch.setattr(speaker_autoflow, 'enqueue', lambda pid: called.append(pid) or {'status': 'queued'})
    assert studio.speaker_subtitle_state('speaker-test', db=None)['document'] is None
    assert called == []
    assert studio.ensure_speaker_subtitles('speaker-test', db=None) == {'status': 'queued'}
    assert called == ['speaker-test']


@pytest.fixture
def prepared(project, monkeypatch):
    from backend.services import ai_model_settings
    from backend.pipeline import media_precheck
    video = project / 'raw/input.mp4'
    video.parent.mkdir()
    video.write_bytes(b'synthetic video')
    srt = video.with_suffix('.srt')
    srt.write_text('1\n00:00:00,100 --> 00:00:01,200\nAlready corrected A\n\n2\n00:00:00,500 --> 00:00:01,500\nAlready corrected B\n', encoding='utf-8')
    selection = Transcription(provider='sensevoice_local', model='SenseVoiceSmall', speaker_diarization=True)
    monkeypatch.setattr(ai_model_settings, 'load', lambda: SimpleNamespace(transcription=selection))
    monkeypatch.setattr(media_precheck, 'has_audio', lambda *_: True)
    return video, srt, selection


def test_studio_fills_missing_voices_before_selecting_clips(project, prepared, monkeypatch):
    video, srt, _ = prepared
    events = []
    def ensure(*args, **kwargs):
        events.append('voices')
        integration.atomic_json(integration.sidecar('speaker-test'), document().model_dump())
        return document()
    monkeypatch.setattr(integration, 'ensure_for_project', ensure, raising=False)
    def select(*args, **kwargs):
        events.append('select')
        return [{'start_time_seconds': 0, 'end_time_seconds': 2, 'generated_title': 'Clip'}]
    monkeypatch.setattr(jobs, 'run_content', select)
    monkeypatch.setattr(jobs, '_complete_thought_bounds', lambda pid, values: values)
    monkeypatch.setattr(jobs.intelligence, '_probe', lambda _: {'duration': 20})
    result = jobs._content_drafts('speaker-test', {'preferences': {'goal': 'content'}}, video)
    assert events == ['voices', 'select']
    assert result


def test_existing_srt_is_not_retranscribed_and_result_is_reused(project, prepared, monkeypatch):
    video, srt, _ = prepared
    original = srt.read_bytes()
    calls = []
    def execute(source, **kwargs):
        calls.append(kwargs)
        assert kwargs['subtitles'] == srt
        return document(), project / 'runtime-result'
    monkeypatch.setattr(integration, 'execute', execute)
    monkeypatch.setattr(integration, 'status', lambda: {'ready': True, 'sensevoice': False, 'whisper': False})
    first = integration.ensure_for_project('speaker-test', video, srt)
    second = integration.ensure_for_project('speaker-test', video, srt)
    assert first == second == document()
    assert len(calls) == 1 and srt.read_bytes() == original
    assert integration.job_state('speaker-test')['status'] == 'completed'


def test_disabled_setting_keeps_original_pipeline(project, prepared, monkeypatch):
    video, srt, selection = prepared
    selection.speaker_diarization = False
    monkeypatch.setattr(integration, 'execute', lambda *a, **k: pytest.fail('disabled'))
    assert integration.ensure_for_project('speaker-test', video, srt) is None
    assert not integration.sidecar('speaker-test').exists()


def test_existing_project_result_and_draft_corrections_are_preserved(project, prepared, monkeypatch):
    video, srt, _ = prepared
    saved = document()
    saved.speakers[0].display_name = 'Confirmed'
    saved.subtitles[0].text = 'Corrected text'
    integration.atomic_json(integration.sidecar('speaker-test'), saved.model_dump())
    monkeypatch.setattr(integration, 'execute', lambda *a, **k: pytest.fail('already recognized'))
    assert integration.ensure_for_project('speaker-test', video, srt) == saved


def test_failure_keeps_srt_and_old_drafts(project, prepared, monkeypatch):
    video, srt, _ = prepared
    state = {'drafts': [{'id': 'old', 'title': 'Keep me'}], 'jobs': [], 'events': [], 'analysis': None}
    store.write('speaker-test', copy.deepcopy(state))
    before = (project / 'metadata/studio.json').read_bytes()
    old_srt = srt.read_bytes()
    def fail(*a, **k): raise ValueError('synthetic recognition failure')
    monkeypatch.setattr(integration, 'execute', fail)
    with pytest.raises(ValueError): integration.ensure_for_project('speaker-test', video, srt)
    assert srt.read_bytes() == old_srt and (project / 'metadata/studio.json').read_bytes() == before
    assert not integration.sidecar('speaker-test').exists()


def test_srt_changed_during_inference_is_not_overwritten(project, prepared, monkeypatch):
    video, srt, _ = prepared
    def changed(*a, **k):
        srt.write_text('new manual text', encoding='utf-8')
        return document(), project
    monkeypatch.setattr(integration, 'execute', changed)
    with pytest.raises(ValueError): integration.ensure_for_project('speaker-test', video, srt)
    assert srt.read_text() == 'new manual text' and not integration.sidecar('speaker-test').exists()


def test_no_audio_skips_diarization_without_losing_supplied_subtitles(project, prepared, monkeypatch):
    from backend.pipeline import media_precheck
    video, srt, _ = prepared
    monkeypatch.setattr(media_precheck, 'has_audio', lambda *_: False)
    monkeypatch.setattr(integration, 'execute', lambda *a, **k: pytest.fail('silent video'))
    assert integration.ensure_for_project('speaker-test', video, srt) is None


def test_two_draft_snapshots_keep_independent_corrections(project):
    from backend.services.studio.models import Draft, Scene
    integration.atomic_json(integration.sidecar('speaker-test'), document().model_dump())
    a = store.save_draft('speaker-test', Draft(id='a', title='First', scenes=[Scene(id='sa', start=0, end=1)]), create=True)
    b = store.save_draft('speaker-test', Draft(id='b', title='Second', scenes=[Scene(id='sb', start=1, end=2)]), create=True)
    edited = copy.deepcopy(a)
    edited['speaker_subtitles']['subtitles'][0]['text'] = 'Only in A'
    store.save_draft('speaker-test', Draft.model_validate(edited))
    state = store.read('speaker-test')
    assert next(d for d in state['drafts'] if d['id'] == 'b')['speaker_subtitles'] == b['speaker_subtitles']
    assert integration.load_document('speaker-test') == document()


def test_new_transcript_is_published_once_and_not_written_over(project, prepared, monkeypatch):
    video, srt, _ = prepared
    original = srt.read_bytes()
    srt.unlink()
    result_folder = project / 'runtime'
    result_folder.mkdir()
    (result_folder / 'subtitles.srt').write_bytes(original)
    monkeypatch.setattr(integration, 'execute', lambda *a, **k: (document(), result_folder))
    assert integration.ensure_for_project('speaker-test', video) == document()
    assert srt.read_bytes() == original


def test_concurrent_requests_only_infer_once(project, prepared, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    video, srt, _ = prepared
    entered, release = threading.Event(), threading.Event()
    calls = []
    def execute(*a, **k):
        calls.append(1); entered.set()
        assert release.wait(10)
        return document(), project
    monkeypatch.setattr(integration, 'execute', execute)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(integration.ensure_for_project, 'speaker-test', video, srt)
        assert entered.wait(10)
        second = pool.submit(integration.ensure_for_project, 'speaker-test', video, srt)
        release.set()
        assert first.result(timeout=10) == second.result(timeout=10) == document()
    assert calls == [1]


def test_api_in_another_process_does_not_mistake_live_worker_for_interruption(project, prepared, monkeypatch):
    import subprocess, sys
    video, srt, _ = prepared
    def execute(*a, **k):
        status = subprocess.check_output([sys.executable, '-c',
            "from backend.services.speaker_integration import job_state; print(job_state('speaker-test')['status'])"], text=True)
        assert status.strip() == 'running'
        return document(), project
    monkeypatch.setattr(integration, 'execute', execute)
    integration.ensure_for_project('speaker-test', video, srt)


def test_reuse_needs_cam_and_vad_but_not_a_second_asr_model(project, prepared, monkeypatch):
    from backend.services import long_audio
    video, srt, _ = prepared
    monkeypatch.setattr(integration, 'runtime_root', lambda: project / 'runtime')
    monkeypatch.setattr(integration, 'status', lambda: {'ready': True, 'whisper': False, 'sensevoice': False})
    monkeypatch.setattr(long_audio, 'probe', lambda _: {'duration_ms': 2000})
    commands = []
    def worker(command, **kwargs):
        commands.append(command)
        target = Path(command[command.index('--output-dir') + 1]); target.mkdir(parents=True)
        (target / 'speaker_subtitles.json').write_text(document().model_dump_json(), encoding='utf-8')
    monkeypatch.setattr(long_audio, 'run_child', worker)
    integration.execute(video, backend='whisper', subtitles=srt)
    assert '--asr-model' not in commands[0] and '--asr-backend' not in commands[0]


def test_failure_stops_before_clip_selection(project, prepared, monkeypatch):
    video, _, _ = prepared
    def failed(*a, **k): raise ValueError('speaker component unavailable')
    monkeypatch.setattr(integration, 'ensure_for_project', failed)
    monkeypatch.setattr(jobs, 'run_content', lambda *a, **k: pytest.fail('must not call analysis'))
    with pytest.raises(ValueError): jobs._content_drafts('speaker-test', {'preferences': {'goal': 'content'}}, video)


def test_cached_metadata_srt_is_passed_to_content_pipeline(project, prepared, monkeypatch):
    from backend.tasks.processing import process_video_pipeline
    video, srt, _ = prepared
    target = project / 'metadata/input.srt'
    target.parent.mkdir(exist_ok=True); srt.rename(target)
    called = []
    def apply(**kwargs):
        called.append(kwargs['kwargs'])
        return SimpleNamespace(get=lambda: {'success': True, 'result': {'result': {'titled_clips': [{'id': 'c'}]}}})
    monkeypatch.setattr(process_video_pipeline, 'apply', apply)
    assert jobs.run_content('speaker-test', video) == [{'id': 'c'}]
    assert called[0]['input_srt_path'] == str(target)


@pytest.mark.parametrize('location', ['raw', 'metadata'])
def test_full_subtitle_stage_adds_voices_before_analysis_without_asr(project, prepared, monkeypatch, location):
    import asyncio
    from backend.services import simple_pipeline_adapter as adapter
    from backend.services.data_sync_service import DataSyncService
    from backend.pipeline import media_precheck
    video, srt, _ = prepared
    if location == 'metadata':
        target = project / 'metadata/input.srt'; target.parent.mkdir(exist_ok=True); srt.rename(target); srt = target
    old = srt.read_bytes()
    events = []
    def execute(*args, **kwargs):
        assert kwargs['subtitles'] == srt
        events.append('voices')
        return document(), project
    monkeypatch.setattr(integration, 'execute', execute)
    monkeypatch.setattr(adapter.SimplePipelineAdapter, '_preflight_llm', lambda *a: None)
    monkeypatch.setattr(adapter.SimplePipelineAdapter, '_prompt_files', lambda *a: {})
    monkeypatch.setattr(media_precheck, 'subtitle_route_failure', lambda *a, **k: None)
    monkeypatch.setattr(adapter, 'emit_progress', lambda *a, **k: None)
    monkeypatch.setattr(adapter, 'clear_progress', lambda *a, **k: None)
    async def forbidden(*a, **k): pytest.fail('existing SRT must skip ASR')
    monkeypatch.setattr(adapter.SimplePipelineAdapter, '_generate_subtitle_automatically', forbidden)
    def select(*a, **k):
        events.append('select')
        assert integration.load_document('speaker-test') is not None
        return [{'id': 'c1', 'generated_title': 'Fixture', 'final_score': .9}]
    monkeypatch.setattr(adapter.SimplePipelineAdapter, '_find_clips_in_one_pass', select)
    monkeypatch.setattr(DataSyncService, 'sync_project_from_filesystem', lambda *a: {'success': True})
    result = asyncio.run(adapter.SimplePipelineAdapter('speaker-test', 'task').process_project_sync(str(video),
        str(srt) if location == 'raw' else None, clips_only=True))
    assert result['status'] == 'succeeded', result
    assert events == ['voices', 'select'] and srt.read_bytes() == old


def test_visual_drafts_enable_reused_speaker_captions(project, prepared, monkeypatch):
    from backend.services.studio.models import Scene
    video, _, _ = prepared
    monkeypatch.setattr(integration, 'execute', lambda *a, **k: (document(), project))
    monkeypatch.setattr(jobs.intelligence, 'ready', lambda: True)
    monkeypatch.setattr(jobs.intelligence, '_probe', lambda _: {'duration': 20})
    monkeypatch.setattr(jobs, 'analyze', lambda *a, **k: ([Scene(id='s1', label='Moment', start=0, end=2)], {}))
    drafts, _, _ = jobs._content_drafts('speaker-test', {'recommended_analysis': 'visual', 'preferences': {'goal': 'highlight'}}, video)
    assert drafts and all(d['subtitles'] for d in drafts)
