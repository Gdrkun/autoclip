"""Bounded, project-local waveform peaks. No models or provider calls."""
from array import array
import hashlib
import json
import math
from pathlib import Path
import sys
import tempfile
import threading
import wave

from backend.core.path_utils import get_temp_directory
from backend.services import long_audio
from backend.services.speaker_integration import atomic_json
from backend.services.studio import store

_lock = threading.Lock()
MAX_WINDOW_SECONDS = 120


def source_identity(video):
    video = Path(video)
    info = video.stat()
    return hashlib.sha256(f'{video.resolve()}:{info.st_size}:{info.st_mtime_ns}'.encode()).hexdigest()


def bounds(start, end, duration, maximum=MAX_WINDOW_SECONDS):
    if not all(math.isfinite(value) for value in (start, end, duration)):
        raise ValueError('字幕区间必须是有效时间')
    if start < 0 or end <= start or end - start > maximum or start >= duration:
        raise ValueError('字幕区间超出允许范围')
    return round(start * 1000), min(round(end * 1000), math.floor(duration * 1000))


def waveform(project_id, start, end, points=800):
    from backend.services.studio.jobs import source
    from backend.core.project_cancellation import checkpoint
    if not isinstance(points, int) or not 64 <= points <= 1600:
        raise ValueError('波形采样数量无效')
    if not all(math.isfinite(value) for value in (start, end)) or start < 0 or not 0 < end - start <= MAX_WINDOW_SECONDS:
        raise ValueError('波形区间最多 120 秒')
    video = source(project_id)
    identity = source_identity(video)
    key = hashlib.sha256(f'wave-v1:{identity}:{start:.3f}:{end:.3f}:{points}'.encode()).hexdigest()
    folder = store.directory(project_id) / 'metadata/subtitle-waveforms'
    target = folder / (key + '.json')
    with _lock:
        try:
            cached = json.loads(target.read_text(encoding='utf-8'))
            if (isinstance(cached, dict) and cached.get('source_version') == identity
                    and isinstance(cached.get('peaks'), list) and len(cached['peaks']) == points
                    and all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1 for value in cached['peaks'])):
                return cached
        except (OSError, ValueError, TypeError):
            pass
        media = long_audio.probe(video)
        left, right = bounds(start, end, media['duration_ms'] / 1000)
        if right <= left:
            raise ValueError('当前区间没有可用音频')
        with tempfile.TemporaryDirectory(prefix='subtitle-wave-', dir=get_temp_directory()) as temporary:
            audio = Path(temporary) / 'audio.wav'
            long_audio.extract(video, audio, {'start_ms': left, 'end_ms': right}, media)
            with wave.open(str(audio), 'rb') as stream:
                samples = array('h', stream.readframes(stream.getnframes()))
            if sys.byteorder != 'little':
                samples.byteswap()
        peaks = []
        for index in range(points):
            chunk = samples[len(samples) * index // points:len(samples) * (index + 1) // points]
            peaks.append(round(max((abs(value) for value in chunk), default=0) / 32768, 4))
        checkpoint(project_id)
        if source_identity(video) != identity:
            raise ValueError('原素材已变化，请重新加载波形')
        result = {'start_ms': left, 'end_ms': right, 'peaks': peaks, 'source_version': identity}
        # Project deletion must never be undone by a waveform cache write.
        if not store.directory(project_id).is_dir():
            raise FileNotFoundError('项目已删除')
        folder.parent.mkdir(exist_ok=True)
        folder.mkdir(exist_ok=True)
        atomic_json(target, result)
        cached_files = sorted(folder.glob('*.json'), key=lambda path: path.stat().st_mtime)
        for stale in cached_files[:-64]:
            try:
                stale.unlink()
            except OSError:
                pass
        return result
