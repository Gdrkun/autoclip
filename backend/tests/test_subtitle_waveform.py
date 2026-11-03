"""Bounded real media waveform and cache contracts; no external models."""
import json
import math
from pathlib import Path
import subprocess

import pytest

from backend.tests.test_studio import root, source, client  # noqa: F401


def test_waveform_api_returns_real_peaks_and_reuses_source_cache(client, root, monkeypatch):
    response = client.get('/studio/p1/subtitle-waveform', params={'start': 0, 'end': 2, 'points': 64})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['start_ms'] == 0 and body['end_ms'] == 2000
    assert len(body['peaks']) == 64 and max(body['peaks']) > .01
    assert all(0 <= value <= 1 for value in body['peaks'])
    assert len(body['source_version']) == 64
    from backend.services import long_audio
    monkeypatch.setattr(long_audio, 'extract', lambda *args: pytest.fail('unchanged waveform must use the cache'))
    assert client.get('/studio/p1/subtitle-waveform', params={'start': 0, 'end': 2, 'points': 64}).json() == body


@pytest.mark.parametrize('params', [
    {'start': -1, 'end': 2}, {'start': 2, 'end': 1}, {'start': 0, 'end': 121},
    {'start': 0, 'end': 1, 'points': 63}, {'start': 0, 'end': 1, 'points': 1601},
    {'start': 'NaN', 'end': 1}, {'start': 0, 'end': 'Infinity'},
])
def test_waveform_rejects_unbounded_or_invalid_requests_before_extract(client, monkeypatch, params):
    from backend.services import long_audio
    monkeypatch.setattr(long_audio, 'extract', lambda *args: pytest.fail('invalid requests must not extract media'))
    assert client.get('/studio/p1/subtitle-waveform', params=params).status_code == 422


def test_waveform_missing_project_is_404(client):
    assert client.get('/studio/missing/subtitle-waveform', params={'start': 0, 'end': 1}).status_code == 404


def test_waveform_padding_respects_delayed_audio_clock(root, monkeypatch):
    from backend.services.subtitle_waveform import waveform
    from backend.services.studio import jobs
    from backend.utils.ffmpeg_utils import get_ffmpeg_path
    video = root / 'delayed.mkv'
    subprocess.run([get_ffmpeg_path(), '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=32x32:rate=10:duration=5',
                    '-itsoffset', '2', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=16000:duration=3',
                    '-c:v', 'libx264', '-c:a', 'pcm_s16le', str(video)], check=True, timeout=30)
    monkeypatch.setattr(jobs, 'source', lambda _: video)
    result = waveform('p1', 0, 4, 80)
    assert max(result['peaks'][:35]) < .001
    assert max(result['peaks'][45:]) > .05


def test_waveform_cache_changes_when_source_changes(root, source, monkeypatch):
    from backend.services.subtitle_waveform import waveform
    original = waveform('p1', 0, 1, 64)
    from backend.services import long_audio
    calls = []
    extract = long_audio.extract
    monkeypatch.setattr(long_audio, 'extract', lambda *args: calls.append(True) or extract(*args))
    import os
    stat = source.stat()
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000000))
    changed = waveform('p1', 0, 1, 64)
    assert calls and changed['source_version'] != original['source_version']


def test_waveform_does_not_modify_existing_subtitle_or_studio_state(root, source):
    from backend.services.subtitle_waveform import waveform
    metadata = root / 'metadata'
    metadata.mkdir(exist_ok=True)
    state = metadata / 'studio.json'
    state.write_text('{"schema_version":2,"drafts":[],"jobs":[]}', encoding='utf-8')
    subtitles = metadata / 'speaker_subtitles.json'
    subtitles.write_text('private original content', encoding='utf-8')
    before = {path: path.read_bytes() for path in (source, state, subtitles)}
    waveform('p1', 0, 1, 64)
    assert all(path.read_bytes() == content for path, content in before.items())


def test_bad_peak_cache_is_recomputed_instead_of_returned(root, source, monkeypatch):
    from backend.services.subtitle_waveform import waveform
    from backend.services import long_audio
    original = waveform('p1', 0, 1, 64)
    cache = next((root / 'metadata/subtitle-waveforms').glob('*.json'))
    cache.write_text(json.dumps({**original, 'peaks': [None] * 64}), encoding='utf-8')
    calls = []
    extract = long_audio.extract
    monkeypatch.setattr(long_audio, 'extract', lambda *args: calls.append(True) or extract(*args))
    assert waveform('p1', 0, 1, 64) == original
    assert len(calls) == 1
