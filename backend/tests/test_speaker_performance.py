"""Recovery and performance boundaries without external providers or user data."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from types import SimpleNamespace

import pytest


def test_transient_windows_sharing_violation_retries_and_preserves_old_file(tmp_path, monkeypatch):
    from backend.services.speaker_integration import atomic_json
    destination = tmp_path / 'captions.json'
    destination.write_text('{"old":true}', encoding='utf-8')
    real_replace, calls = os.replace, []

    def replace(source, target):
        calls.append(target)
        if len(calls) == 1:
            error = PermissionError('sharing violation')
            error.winerror = 32
            raise error
        real_replace(source, target)

    monkeypatch.setattr(os, 'replace', replace)
    atomic_json(destination, {'new': True})
    assert len(calls) == 2 and json.loads(destination.read_text()) == {'new': True}
    assert list(tmp_path.iterdir()) == [destination]


def test_permanent_write_denial_is_bounded_and_keeps_previous_document(tmp_path, monkeypatch):
    from backend.services.speaker_integration import atomic_json
    destination = tmp_path / 'captions.json'
    destination.write_text('{"old":true}', encoding='utf-8')
    calls = []

    def denied(*args):
        calls.append(args)
        error = PermissionError('denied')
        error.winerror = 5
        raise error

    monkeypatch.setattr(os, 'replace', denied)
    with pytest.raises(PermissionError):
        atomic_json(destination, {'new': True})
    assert len(calls) == 5 and json.loads(destination.read_text()) == {'old': True}
    assert list(tmp_path.iterdir()) == [destination]


FAKE_WORKER = '''import json,os,sys,time
from pathlib import Path
for line in sys.stdin:
    request=json.loads(line)
    if request['audio']=='slow': time.sleep(30)
    target=Path(request['result']); pending=target.with_suffix('.tmp')
    pending.write_text(json.dumps({'pid':os.getpid(),'audio':request['audio']}))
    pending.replace(target)
'''


def test_one_worker_serves_two_chunks_and_exits_without_orphans(tmp_path):
    from backend.services.speaker_process import SpeakerProcess
    with SpeakerProcess([sys.executable, '-u', '-c', FAKE_WORKER], env=None, log=tmp_path / 'worker.log') as session:
        a = session.infer('first', tmp_path / 'a.json')
        b = session.infer('second', tmp_path / 'b.json')
        process = session.process
        assert a['pid'] == b['pid'] and b['audio'] == 'second'
    assert process.poll() == 0


def test_all_cached_chunks_need_no_model_process(tmp_path):
    from backend.services.speaker_process import SpeakerProcess
    with SpeakerProcess(['does-not-exist'], env=None, log=tmp_path / 'worker.log') as session:
        assert session.process is None
    assert not (tmp_path / 'worker.log').exists()


def test_cancelling_inference_kills_persistent_process(tmp_path):
    from backend.services.speaker_process import SpeakerProcess
    from backend.core import project_cancellation as cancel
    from backend.services import long_audio
    stopped = threading.Event()

    def checkpoint():
        if stopped.is_set():
            raise cancel.JobStopped('fixture')

    original = long_audio.checkpoint
    long_audio.checkpoint = checkpoint
    timer = threading.Timer(.5, stopped.set)
    timer.start()
    try:
        with pytest.raises(cancel.JobStopped):
            with SpeakerProcess([sys.executable, '-u', '-c', FAKE_WORKER], env=None, log=tmp_path / 'cancel.log') as session:
                session.infer('slow', tmp_path / 'result.json')
        assert session.process.poll() is not None
    finally:
        timer.cancel()
        long_audio.checkpoint = original


def test_timeout_stops_worker_and_leaves_no_partial_result(tmp_path):
    from backend.services.speaker_process import SpeakerProcess
    with pytest.raises(subprocess.TimeoutExpired):
        with SpeakerProcess([sys.executable, '-u', '-c', FAKE_WORKER], env=None, log=tmp_path / 'timeout.log', timeout=.2) as session:
            session.infer('slow', tmp_path / 'result.json')
    assert session.process.poll() is not None and not (tmp_path / 'result.json').exists()










def test_hour_voice_cache_survives_transcript_prompt_and_asr_choice_changes(tmp_path, monkeypatch):
    from backend.services import long_audio, long_speaker, speaker_process
    video = tmp_path / 'source.mp4'
    video.write_bytes(b'isolated synthetic source')
    transcript = tmp_path / 'source.srt'
    transcript.write_text('1\n00:00:00,100 --> 00:00:00,900\nfirst text\n', encoding='utf-8')
    models = tmp_path / 'runtime/models'
    for name in ('campplus/config.yaml', 'campplus/campplus_cn_common.bin', 'campplus/configuration.json', 'fsmn-vad/model.pt'):
        target = models / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b'fixture')
    calls = []

    def extract(video, output, part, media):
        output.write_text(json.dumps(part), encoding='utf-8')

    class Worker:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def infer(self, audio, result):
            part = json.loads(audio.read_text(encoding='utf-8'))
            calls.append(part['index'])
            return {'duration_ms': part['end_ms'] - part['start_ms'], 'windows': [
                {'start_ms': 0, 'owned_start_ms': 0, 'owned_end_ms': 1000, 'end_ms': 1000}],
                'embeddings': [[1., 0.]], 'subtitles': []}

    monkeypatch.setattr(long_audio, 'probe', lambda _: {'duration_ms': 3600000})
    monkeypatch.setattr(long_audio, 'extract', extract)
    monkeypatch.setattr(speaker_process, 'SpeakerProcess', Worker)
    first, folder = long_speaker.execute(video, tmp_path / 'runtime', 'whisper', 'old prompt', transcript)
    assert len(calls) == 20 and first.subtitles[0].text == 'first text'
    transcript.write_text('1\n00:00:00,100 --> 00:00:00,900\ncorrected text\n', encoding='utf-8')
    second, reused = long_speaker.execute(video, tmp_path / 'runtime', 'sensevoice', 'new prompt', transcript)
    assert reused == folder and len(calls) == 20
    assert second.subtitles[0].text == 'corrected text'
    assert first.subtitles[0].speaker_id == second.subtitles[0].speaker_id
