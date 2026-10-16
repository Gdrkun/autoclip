"""Small CPU-only picture/audio measurements. A change is a clue, never a highlight."""
from array import array
import math
import sys

from backend.core import project_cancellation as cancellation
from backend.utils.ffmpeg_utils import get_ffmpeg_path

WIDTH, HEIGHT, FPS = 96, 54, 2
CHUNK_SECONDS = 180


def _decode(video, start, length, audio=False):
    command = [get_ffmpeg_path(), '-nostdin', '-v', 'error', '-threads', '1', '-ss', str(start),
               '-i', str(video), '-t', str(length)]
    if audio:
        command += ['-map', '0:a:0', '-vn', '-af', 'aresample=async=1:first_pts=0',
                    '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']
    else:
        command += ['-an', '-vf', f'fps={FPS},scale={WIDTH}:{HEIGHT}', '-pix_fmt', 'gray',
                    '-threads', '1', '-filter_threads', '1', '-f', 'rawvideo', 'pipe:1']
    return cancellation.run(command, check=True, capture_output=True, timeout=180).stdout


def picture_clues(raw, offset):
    size = WIDTH * HEIGHT
    if len(raw) % size:
        raise ValueError('画面扫描结果不完整')
    frames = [raw[index:index+size] for index in range(0, len(raw), size)]
    output = []
    for index in range(1, len(frames)):
        # Whole-frame variation, including animated characters; no assumed face location.
        difference = sum(abs(a-b) for a, b in zip(frames[index-1], frames[index])) / (size * 255)
        if difference >= .035:
            output.append({'at': round(offset + index/FPS, 3), 'picture': round(difference, 4),
                           'scene_change': difference >= .22})
    return output


def sound_clues(raw, offset):
    samples = array('h')
    samples.frombytes(raw[:len(raw)//2*2])
    if sys.byteorder != 'little':
        samples.byteswap()
    values = []
    for index in range(0, len(samples), 4000):
        block = samples[index:index+4000]
        if block:
            values.append(math.sqrt(sum(value*value for value in block)/len(block))/32768)
    if not values:
        return []
    baseline = sorted(values)[len(values)//2]
    return [{'at': round(offset + index*.5, 3), 'sound': round(value, 4)}
            for index, value in enumerate(values) if value > max(.025, baseline*1.6)]


def scan(video, duration, folder, *, audio=True, progress=None):
    """Per-chunk cache, bounded decode memory, cancellation between and during decodes."""
    from backend.services.speaker_integration import atomic_json
    import json
    folder.mkdir(parents=True, exist_ok=True)
    clues = []
    total = max(1, math.ceil(duration/CHUNK_SECONDS))
    for index in range(total):
        cancellation.checkpoint()
        start, length = index*CHUNK_SECONDS, min(CHUNK_SECONDS, duration-index*CHUNK_SECONDS)
        target = folder / f'scan-{index}.json'
        try:
            chunk = json.loads(target.read_text(encoding='utf-8'))
            if not isinstance(chunk, list) or any(not isinstance(row, dict) or not start <= float(row['at']) < start+length for row in chunk):
                raise ValueError('Invalid scan cache')
        except (OSError, ValueError, KeyError, TypeError):
            chunk = picture_clues(_decode(video, start, length), start)
            if audio:
                chunk += sound_clues(_decode(video, start, length, audio=True), start)
            chunk = [row for row in chunk if start <= row['at'] < start+length]
            cancellation.checkpoint()
            atomic_json(target, chunk)
        clues.extend(chunk)
        if progress:
            progress(index+1, total)
    return clues


def candidate_windows(clues, duration, budget, transcript=()):
    """Reserve temporal coverage; rank within regions, never equate cuts or loudness with jokes."""
    hints = []
    for row in transcript:
        if any(word in row['text'] for word in ('哈哈', '什么', '啊', '笑', '救命', '绷不住', '忘词')):
            hints.append({'at': (row['start']+row['end'])/2, 'dialogue': 1})
    values = [*clues, *hints]
    buckets = {}
    for row in values:
        bucket = buckets.setdefault(int(row['at']), {})
        for field in ('picture', 'sound', 'dialogue'):
            bucket[field] = max(bucket.get(field, 0), row.get(field, 0))
    count = min(budget, max(1, math.ceil(duration/14)))
    ranked = []
    for index in range(count):
        lo, hi = duration*index/count, duration*(index+1)/count
        candidates = [row for row in values if lo <= row['at'] < hi]
        def score(row):
            nearby = [buckets.get(second, {}) for second in range(int(row['at'])-2, int(row['at'])+3)]
            return (min(float(row.get('picture', 0)), .2) +
                    .12*any(other.get('sound') for other in nearby) +
                    .1*any(other.get('dialogue') for other in nearby))
        anchor = max(candidates, key=score)['at'] if candidates else (lo+hi)/2
        start = max(0, min(anchor-6, duration-14))
        end = min(duration, start+14)
        # Scene changes add before/after samples; they do not generate semantic events.
        times = {round(start+(end-start)*i/11, 3) for i in range(12)}
        for cut in (row['at'] for row in clues if row.get('scene_change') and start < row['at'] < end):
            times.update(round(max(start, min(end-.05, cut+delta)), 3) for delta in (-.4, .4))
            if len(times) >= 16:
                break
        ordered = sorted(times)
        if len(ordered) > 16:
            ordered = [ordered[round(i*(len(ordered)-1)/15)] for i in range(16)]
        ranked.append({'id': index, 'start': round(start, 3), 'end': round(end, 3), 'times': ordered})
    return ranked
