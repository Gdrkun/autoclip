"""Bounded audio chunks, durable checkpoints and cancellable local children. No ML imports."""
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

CHUNK_MS = 180000
OVERLAP_MS = 4000
VERSION = 1


def probe(video):
    from backend.utils.ffmpeg_utils import get_ffprobe_path
    from backend.core.project_cancellation import run
    result = run([get_ffprobe_path(), '-v', 'error', '-show_entries',
                  'format=duration,start_time:stream=codec_type,duration,start_time', '-of', 'json', str(video)],
                 capture_output=True, text=True, timeout=30, check=True)
    value = json.loads(result.stdout)
    streams = value.get('streams', [])
    videos = [s for s in streams if s.get('codec_type') == 'video']
    if not videos or not any(s.get('codec_type') == 'audio' for s in streams):
        raise ValueError('原视频需要包含可读取的视频轨和音轨')
    info = value.get('format', {})
    duration = float(videos[0].get('duration', info.get('duration', 'nan')))
    start = float(videos[0].get('start_time', info.get('start_time', 0)))
    if not math.isfinite(duration) or duration <= 0 or not math.isfinite(start):
        raise ValueError('无法读取原视频的有效时长或起始时间')
    return {'duration_ms': math.floor(duration * 1000), 'video_start_seconds': start}


def chunks(duration_ms, chunk_ms=CHUNK_MS, overlap_ms=OVERLAP_MS):
    if type(duration_ms) is not int or duration_ms <= 0 or not 1000 <= chunk_ms <= 300000 or not 0 <= overlap_ms < chunk_ms / 2:
        raise ValueError('Invalid audio chunk bounds')
    for index, start in enumerate(range(0, duration_ms, chunk_ms)):
        end = min(duration_ms, start + chunk_ms)
        yield {'index': index, 'start_ms': max(0, start - overlap_ms),
               'end_ms': min(duration_ms, end + overlap_ms), 'owned_start_ms': start, 'owned_end_ms': end}


def identity(video, options, files=()):
    path = Path(video).resolve()
    stat = path.stat()
    value = {'version': VERSION, 'video': str(path), 'size': stat.st_size, 'mtime': stat.st_mtime_ns,
             'options': options, 'files': []}
    for file in files:
        file = Path(file)
        stat = file.stat()
        value['files'].append([str(file.resolve()), stat.st_size, stat.st_mtime_ns])
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def cache_directory(video, key, kind):
    # Raw/input.* is the normal project layout. Reuse only within this material/config identity.
    path = Path(video).resolve()
    base = path.parent.parent / 'metadata/audio-chunks' if path.parent.name == 'raw' else path.parent / '.autoclip-audio-chunks'
    result = base / kind / key
    result.mkdir(parents=True, exist_ok=True)
    return result


@contextmanager
def exclusive(folder):
    """Cross-process lock: retries cannot race over the same chunk files."""
    lock = folder / 'run.lock'
    with lock.open('a+b') as stream:
        stream.seek(0)
        if not stream.read(1):
            stream.write(b'0'); stream.flush()
        stream.seek(0)
        try:
            if __import__('os').name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError('同一音轨正在处理，请等待当前任务完成后再试') from None
        try:
            yield
        finally:
            stream.seek(0)
            if __import__('os').name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def checkpoint():
    from backend.core.project_cancellation import checkpoint as check, current
    check(current())


def run_child(command, *, env, log, timeout=1200):
    from backend.services import child_guard
    import os
    checkpoint()
    with Path(log).open('w', encoding='utf-8') as stream:
        process = subprocess.Popen(command, env=env, stdout=stream, stderr=subprocess.STDOUT,
                                   **({'start_new_session': True} if os.name != 'nt' else {'creationflags': subprocess.CREATE_NO_WINDOW}))
        owner = 'audio-' + uuid.uuid4().hex
        child_guard.track(process, owner)
        started = time.monotonic()
        try:
            while process.poll() is None:
                checkpoint()
                if time.monotonic() - started >= timeout:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    process.wait(timeout=.25)
                except subprocess.TimeoutExpired:
                    pass
        except BaseException:
            child_guard.kill(owner)
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
            raise
        finally:
            child_guard.untrack(process)
    checkpoint()
    if process.returncode:
        raise ValueError('本地音轨分段处理失败；已完成的分段已保留，可重试继续')


def extract(video, output, part, media):
    from backend.utils.ffmpeg_utils import get_ffmpeg_path
    offset = part['start_ms'] / 1000
    command = [get_ffmpeg_path(), '-nostdin', '-v', 'error', '-y', '-copyts', '-ss', str(offset), '-i', str(video),
               '-map', '0:a:0', '-vn', '-af',
               f"asetpts=PTS-({media['video_start_seconds'] + offset})/TB,aresample=async=1:first_pts=0,apad",
               '-t', str((part['end_ms'] - part['start_ms']) / 1000), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(output)]
    run_child(command, env=None, log=Path(output).with_suffix('.log'), timeout=300)


def read_chunk(path, key, part, validate):
    try:
        record = json.loads(path.read_text(encoding='utf-8'))
        if record['identity'] != key or record['part'] != part:
            return None
        return validate(record['result'], part)
    except (OSError, ValueError, KeyError, TypeError):
        return None


def process_chunks(video, media, folder, key, infer, validate, on_progress=None, *, chunk_ms=CHUNK_MS):
    from backend.services.speaker_integration import atomic_json
    parts = list(chunks(media['duration_ms'], chunk_ms))
    results = []
    with exclusive(folder):
        started = time.monotonic()
        reused = 0
        for part in parts:
            checkpoint()
            record = folder / f"chunk-{part['index']:05d}.json"
            value = read_chunk(record, key, part, validate)
            if value is None:
                if on_progress:
                    on_progress(part['index'], len(parts), reused)
                with tempfile.TemporaryDirectory(prefix='work-', dir=folder) as temp:
                    audio = Path(temp) / 'audio.wav'
                    extract(video, audio, part, media)
                    value = validate(infer(audio, Path(temp), part), part)
                    checkpoint()
                    atomic_json(record, {'identity': key, 'part': part, 'result': value})
            else:
                reused += 1
            results.append((part, value))
            if on_progress:
                on_progress(part['index'] + 1, len(parts), reused)
            atomic_json(folder / 'progress.json', {'completed': len(results), 'total': len(parts), 'reused': reused,
                                                   'elapsed_seconds': round(time.monotonic() - started, 3)})
        return results
