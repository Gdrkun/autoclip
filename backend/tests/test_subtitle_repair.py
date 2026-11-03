"""Short-job lifecycle and real storage/API boundaries; no downloaded or remote models."""
from types import SimpleNamespace
from pathlib import Path
import threading

import pytest
from pydantic import ValidationError

from backend.services import subtitle_repair as repair
from backend.services.studio import store
from backend.services.subtitle_waveform import source_identity
from backend.tests.test_studio import client, root, source  # noqa: F401
real_infer = repair._infer


class Queue:
    def __init__(self): self.jobs = []
    def submit(self, function, *args): self.jobs.append((function, args))
    def run(self):
        function, args = self.jobs.pop(0)
        function(*args)


@pytest.fixture
def prepared(root, tmp_path, monkeypatch):
    video = root / 'fixture.mp4'; video.write_bytes(b'isolated media identity')
    runtime = tmp_path / 'runtime'
    for name in ['venv/Scripts/python.exe', 'venv/bin/python', 'models/fsmn-vad/model.pt', 'models/sensevoice/model.pt', 'models/whisper-medium/model.bin']:
        file = runtime / name; file.parent.mkdir(parents=True, exist_ok=True); file.touch()
    queue = Queue()
    monkeypatch.setattr(repair, '_executor', queue)
    monkeypatch.setattr(repair, '_active', {})
    monkeypatch.setattr(repair, 'runtime_root', lambda: runtime)
    monkeypatch.setattr('backend.services.studio.jobs.source', lambda _: video)
    monkeypatch.setattr(repair.long_audio, 'probe', lambda _: {'duration_ms': 100000, 'video_start_seconds': 0})
    extracts = []
    monkeypatch.setattr(repair.long_audio, 'extract', lambda video, audio, part, media: extracts.append(part))
    monkeypatch.setattr(repair, '_infer', lambda *args: {'subtitles': [dict(id='local', start_ms=200, end_ms=1500, text='局部新字幕')]})
    request = repair.Request(request_id='a' * 32, start=20, end=25, backend='sensevoice', source_version=source_identity(video))
    return SimpleNamespace(video=video, request=request, queue=queue, extracts=extracts)


def test_short_recognition_offsets_candidates_without_changing_saved_documents(prepared):
    sidecar = store.directory('p1') / 'metadata/speaker_subtitles.json'
    sidecar.parent.mkdir(exist_ok=True); sidecar.write_text('{"untouched":true}', encoding='utf-8')
    job = repair.start('p1', prepared.request)
    assert job['status'] == 'queued'
    prepared.queue.run()
    result = repair.state('p1', job['job_id'])
    assert result['status'] == 'completed'
    cue = result['subtitles'][0]
    assert (cue['start_ms'], cue['end_ms']) == (20200, 21500)
    assert cue['speaker_id'] is None and cue['assignment_reason'] == 'unassigned'
    assert prepared.extracts == [{'start_ms': 20000, 'end_ms': 25000}]
    assert sidecar.read_text(encoding='utf-8') == '{"untouched":true}'


def test_idempotent_retry_and_busy_job_never_start_duplicate_work(prepared):
    first = repair.start('p1', prepared.request)
    assert repair.start('p1', prepared.request)['job_id'] == first['job_id']
    assert len(prepared.queue.jobs) == 1
    with pytest.raises(store.ConflictError):
        repair.start('p1', prepared.request.model_copy(update={'request_id': 'b' * 32}))
    assert len(prepared.queue.jobs) == 1


def test_cancel_does_not_stop_project_or_start_queued_inference(prepared, monkeypatch):
    monkeypatch.setattr('backend.core.project_cancellation.stop', lambda *args: pytest.fail('must not stop an entire project'))
    job = repair.start('p1', prepared.request)
    assert repair.cancel('p1', job['job_id'])['status'] == 'cancelled'
    prepared.queue.run()
    assert not prepared.extracts
    assert repair.state('p1', job['job_id'])['status'] == 'cancelled'
    assert not repair._active


def test_source_changes_block_start_and_applying_completed_results(prepared):
    job = repair.start('p1', prepared.request); prepared.queue.run()
    prepared.video.write_bytes(b'changed source')
    with pytest.raises(store.ConflictError): repair.state('p1', job['job_id'])
    with pytest.raises(store.ConflictError): repair.start('p1', prepared.request.model_copy(update={'request_id': 'b' * 32}))


def test_bad_timestamps_and_missing_output_fail_without_touching_subtitles(prepared, monkeypatch):
    monkeypatch.setattr(repair, '_infer', lambda *args: {'subtitles': [dict(id='bad', start_ms=0, end_ms=99999, text='越界')]})
    job = repair.start('p1', prepared.request); prepared.queue.run()
    assert repair.state('p1', job['job_id'])['status'] == 'failed'
    assert not (store.directory('p1') / 'metadata/speaker_subtitles.json').exists()


def test_task_survives_ui_reload_but_backend_restart_reports_interruption(prepared, monkeypatch):
    job = repair.start('p1', prepared.request)
    assert repair.state('p1', job['job_id'])['status'] == 'queued'
    monkeypatch.setattr(repair, '_instance', 'another-backend')
    assert repair.state('p1', job['job_id'])['status'] == 'failed'


def test_project_deletion_never_recreates_project(prepared):
    import shutil
    repair.start('p1', prepared.request)
    shutil.rmtree(store.directory('p1'))
    prepared.queue.run()
    assert not store.directory('p1').exists()


@pytest.mark.parametrize('start,end', [(0, 61), (2, 2), (-1, 1), (0, float('nan')), (1, 1.05)])
def test_invalid_selection_is_rejected(start, end):
    with pytest.raises(ValidationError):
        repair.Request(request_id='a' * 32, start=start, end=end, source_version='0' * 64)


def test_http_contract_and_project_scoping(client, prepared):
    payload = prepared.request.model_dump()
    response = client.post('/studio/p1/subtitle-repairs', json=payload)
    assert response.status_code == 200
    identity = response.json()['job_id']
    prepared.queue.run()
    result = client.get('/studio/p1/subtitle-repairs/' + identity)
    assert result.status_code == 200 and result.json()['status'] == 'completed'
    assert client.get('/studio/missing/subtitle-repairs/' + identity).status_code == 404
    assert client.get('/studio/p1/subtitle-repairs/not-an-id').status_code == 422
    assert client.post('/studio/p1/subtitle-repairs', json={**payload, 'end': 200}).status_code == 422


def test_task_cancellation_checkpoint_is_context_local_and_restored():
    observed = []
    def stop(): raise repair.Cancelled()
    with repair.long_audio.cancellation(stop):
        thread = threading.Thread(target=lambda: (repair.long_audio.checkpoint(), observed.append('other worker unaffected')))
        thread.start(); thread.join()
        with pytest.raises(repair.Cancelled): repair.long_audio.checkpoint()
    repair.long_audio.checkpoint()
    assert observed == ['other worker unaffected']


def test_continuous_repairs_reuse_model_and_stale_idle_timer_cannot_close_current_worker(prepared, tmp_path, monkeypatch):
    processes = []
    class Process:
        def __init__(self, command, **kwargs): self.command = command; self.closed = 0; processes.append(self)
        def __enter__(self): return self
        def __exit__(self, *args): self.closed += 1
        def infer(self, *args): return {'subtitles': []}
    class Timer:
        def __init__(self, *args, **kwargs): pass
        def cancel(self): pass
        def start(self): pass
    monkeypatch.setattr(repair, 'SpeakerProcess', Process)
    monkeypatch.setattr(repair.threading, 'Timer', Timer)
    monkeypatch.setattr(repair, '_engine', None)
    real_infer(tmp_path / 'a.wav', tmp_path, prepared.request)
    engine = repair._engine; stale_token = engine['timer_id']
    real_infer(tmp_path / 'b.wav', tmp_path, prepared.request)
    assert len(processes) == 1 and '--asr-only' in processes[0].command and '--session' in processes[0].command
    repair._close_engine(engine, stale_token)
    assert processes[0].closed == 0
    real_infer(tmp_path / 'c.wav', tmp_path, prepared.request.model_copy(update={'prompt': 'changed'}))
    assert len(processes) == 2 and processes[0].closed == 1
    repair._close_engine()
    assert processes[1].closed == 1


def test_cancelled_inference_discards_its_worker(prepared, tmp_path, monkeypatch):
    closed = []
    class Process:
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, kind, *args): closed.append(kind)
        def infer(self, *args): raise repair.Cancelled()
    monkeypatch.setattr(repair, 'SpeakerProcess', Process)
    monkeypatch.setattr(repair, '_engine', None)
    with pytest.raises(repair.Cancelled): real_infer(tmp_path / 'a.wav', tmp_path, prepared.request)
    assert repair._engine is None and closed == [repair.Cancelled]
