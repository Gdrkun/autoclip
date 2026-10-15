"""Singing analysis of arbitrarily long sources using restartable three-minute chunks."""
import json
import math
from pathlib import Path

from backend.services import long_audio
from backend.services.singing_worker import merge_windows


def validate_chunk(value, part):
    length = (part['end_ms'] - part['start_ms']) / 1000
    if not isinstance(value, dict):
        raise ValueError('歌声分段结果无效')
    duration = value.get('duration')
    if value.get('status') != 'completed' or type(duration) not in (float, int) or not math.isfinite(duration) or abs(duration - length) > .002:
        raise ValueError('歌声分段音轨时长无效')
    windows = value.get('windows')
    if not isinstance(windows, list) or len(windows) > 100:
        raise ValueError('歌声分段结果不完整')
    for item in windows:
        if not isinstance(item, dict):
            raise ValueError('歌声候选结果无效')
        for key in ('start', 'end', 'singing', 'music', 'speech'):
            if type(item.get(key)) not in (int, float) or not math.isfinite(item[key]):
                raise ValueError('歌声候选数值无效')
        if not 0 <= item['start'] < item['end'] <= length + .002 or any(not 0 <= item[key] <= 1 for key in ('singing', 'music', 'speech')):
            raise ValueError('歌声候选范围无效')
    return value


def analyze(video, model_root, worker, on_progress=None):
    from backend.services.singing_detection import Report
    media = long_audio.probe(video)
    key = long_audio.identity(video, {'kind': 'singing', 'chunk_ms': long_audio.CHUNK_MS},
                              [model_root / 'model.safetensors', model_root / 'config.json',
                               Path(__file__), Path(__file__).with_name('long_audio.py'),
                               Path(__file__).with_name('singing_worker.py')])
    folder = long_audio.cache_directory(video, key, 'singing')
    def infer(audio, temp, part):
        result = temp / 'result.json'
        worker('analyze', result, audio)
        return json.loads(result.read_text(encoding='utf-8'))
    results = long_audio.process_chunks(video, media, folder, key, infer, validate_chunk, on_progress)
    windows = []
    for part, value in results:
        for item in value['windows']:
            start, end = item['start'] + part['start_ms'] / 1000, item['end'] + part['start_ms'] / 1000
            if part['owned_start_ms'] <= (start + end) * 500 < part['owned_end_ms']:
                windows.append({**item, 'start': start, 'end': end})
    duration = media['duration_ms'] / 1000
    segments = merge_windows(sorted(windows, key=lambda w: w['start']), duration)
    return Report(status='completed', model='MIT/ast-finetuned-audioset-10-10-0.4593', duration=duration, segments=segments)
