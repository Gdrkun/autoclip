"""Long-video local transcription with global CAM++ identities and bounded audio memory."""
import json
import math
from pathlib import Path

from backend.services import long_audio
from backend.services.speaker_subtitles import Cue, Speaker, SpeakerDocument, associate_cues, cluster_embeddings, windows_to_turns


def validate_chunk(value, part):
    length = part['end_ms'] - part['start_ms']
    if not isinstance(value, dict) or abs(value.get('duration_ms', -1) - length) > 2:
        raise ValueError('分段音频时间与原视频不一致')
    windows, embeddings = value.get('windows'), value.get('embeddings')
    if not isinstance(windows, list) or not isinstance(embeddings, list) or len(windows) != len(embeddings) or len(windows) > 400:
        raise ValueError('分段声纹结果不完整')
    dimension = None
    for window, vector in zip(windows, embeddings):
        if not isinstance(window, dict):
            raise ValueError('分段声纹窗口无效')
        times = [window.get(k) for k in ('start_ms', 'owned_start_ms', 'owned_end_ms', 'end_ms')]
        if any(type(t) is not int for t in times) or not 0 <= times[0] <= times[1] < times[2] <= times[3] <= length:
            raise ValueError('分段声纹时间无效')
        if not isinstance(vector, list) or not 1 <= len(vector) <= 1024 or any(type(v) not in (float, int) or not math.isfinite(v) for v in vector):
            raise ValueError('分段声纹向量无效')
        if sum(v * v for v in vector) <= 1e-12 or dimension not in (None, len(vector)):
            raise ValueError('分段声纹维度无效')
        dimension = len(vector)
    cues = value.get('subtitles')
    if not isinstance(cues, list) or len(cues) > 2000:
        raise ValueError('分段字幕结果无效')
    for item in cues:
        cue = Cue.model_validate(item)
        if cue.end_ms > length:
            raise ValueError('分段字幕越界')
    return value


def global_labels(embeddings, maximum=2, threshold=.25):
    """Cluster a bounded, evenly sampled set; assign all windows to global centroids.

    Memory and pairwise work are bounded by 256 anchors, independently of video length.
    The cluster cap does not force a second speaker. IDs follow first full-video occurrence.
    """
    if not embeddings:
        return []
    dimensions = len(embeddings[0])
    vectors = []
    for values in embeddings:
        if len(values) != dimensions:
            raise ValueError('不同分段的声纹维度不一致')
        norm = math.sqrt(sum(v * v for v in values))
        vectors.append([v / norm for v in values])
    count = min(256, len(vectors))
    indices = [round(i * (len(vectors) - 1) / (count - 1)) for i in range(count)] if count > 1 else [0]
    anchor_labels = cluster_embeddings([vectors[i] for i in indices], max_speakers=maximum, threshold=threshold)
    labels = sorted(set(anchor_labels))
    centroids = []
    for label in labels:
        selected = [vectors[index] for index, assigned in zip(indices, anchor_labels) if assigned == label]
        centre = [sum(values) / len(selected) for values in zip(*selected)]
        norm = math.sqrt(sum(v * v for v in centre))
        centroids.append([v / norm for v in centre])
    assigned = []
    for _ in range(4):
        long_audio.checkpoint()
        assigned = [max(range(len(centroids)), key=lambda i: sum(a * b for a, b in zip(vector, centroids[i]))) for vector in vectors]
        for index in range(len(centroids)):
            selected = [vector for vector, label in zip(vectors, assigned) if label == index]
            if selected:
                centre = [sum(values) for values in zip(*selected)]
                norm = math.sqrt(sum(v * v for v in centre))
                centroids[index] = [v / norm for v in centre]
    remap = {}
    return [remap.setdefault(label, f'spk_{len(remap)}') for label in assigned]


def combine(results, duration_ms, existing=None):
    windows, embeddings, cues = [], [], []
    for part, value in results:
        offset = part['start_ms']
        for window, vector in zip(value['windows'], value['embeddings']):
            left = max(part['owned_start_ms'], offset + window['owned_start_ms'])
            right = min(part['owned_end_ms'], offset + window['owned_end_ms'])
            if left < right:
                windows.append({**window, 'owned_start_ms': left, 'owned_end_ms': right})
                embeddings.append(vector)
        if existing is None:
            for item in value['subtitles']:
                cue = Cue.model_validate(item)
                start, end = offset + cue.start_ms, min(duration_ms, offset + cue.end_ms)
                if part['owned_start_ms'] <= (start + end) / 2 < part['owned_end_ms']:
                    cues.append(cue.model_copy(update={'start_ms': start, 'end_ms': end, 'speaker_id': None}))
    turns = windows_to_turns(windows, global_labels(embeddings))
    if existing is not None:
        cues = existing
    else:
        unique = []
        for cue in sorted(cues, key=lambda c: (c.start_ms, c.end_ms)):
            repeated = any(cue.text.strip() == previous.text.strip() and cue.start_ms < previous.end_ms
                           for previous in unique[-5:])
            if not repeated:
                unique.append(cue)
        cues = [cue.model_copy(update={'id': f'cue_{i + 1:05d}'}) for i, cue in enumerate(unique)]
    speakers = [Speaker(speaker_id=label, color=['#FF91BD', '#C0A5FF'][i % 2])
                for i, label in enumerate(dict.fromkeys(t.speaker_id for t in turns))]
    return SpeakerDocument(duration_ms=duration_ms, speakers=speakers, turns=turns,
                           subtitles=associate_cues(cues, turns))


def execute(video, root, backend, prompt, subtitles=None, on_progress=None):
    import os
    from backend.services.speaker_integration import atomic_json
    media = long_audio.probe(video)
    services = Path(__file__).parent
    models = root / 'models'
    asr = models / ('whisper-medium' if backend == 'whisper' else 'sensevoice')
    worker = services / 'speaker_worker.py'
    files = [worker, services / 'long_speaker.py', services / 'long_audio.py', services / 'speaker_subtitles.py',
             services / 'speaker_whisper.py', services / 'sensevoice_alignment.py', models / 'campplus/config.yaml',
             models / 'campplus/campplus_cn_common.bin', models / 'campplus/configuration.json', models / 'fsmn-vad/model.pt']
    if subtitles:
        files.append(subtitles)
    else:
        files.extend([asr / ('model.bin' if backend == 'whisper' else 'model.pt'), asr / 'config.json' if backend == 'whisper' else asr / 'config.yaml'])
    key = long_audio.identity(video, {'backend': backend, 'prompt': prompt, 'reuse': bool(subtitles), 'chunk_ms': long_audio.CHUNK_MS}, files)
    folder = long_audio.cache_directory(video, key, 'speaker')
    python = root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    env = {k: v for k, v in os.environ.items() if not k.endswith(('_API_KEY', '_TOKEN')) and k not in ('SENTRY_DSN', 'PYTHONPATH')}
    env.update(PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', CUDA_VISIBLE_DEVICES='', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', MODELSCOPE_OFFLINE='1')
    def infer(audio, temp, part):
        output = temp / 'worker.json'
        command = [str(python), '-I', str(worker), '--audio', str(audio), '--result', str(output),
                   '--cam-model', str(models / 'campplus'), '--vad-model', str(models / 'fsmn-vad'),
                   '--speakers', '2', '--threads', '4', '--language', 'auto', '--include-embeddings']
        if not subtitles:
            command += ['--asr-backend', backend, '--asr-model', str(asr), '--initial-prompt', prompt]
        long_audio.run_child(command, env=env, log=folder / f"worker-{part['index']:05d}.log", timeout=1800)
        return json.loads(output.read_text(encoding='utf-8'))
    results = long_audio.process_chunks(video, media, folder, key, infer, validate_chunk, on_progress)
    existing = None
    if subtitles:
        from backend.utils.text_processor import TextProcessor
        existing = [Cue(id=f'cue_{i:05d}', start_ms=round(TextProcessor.time_to_seconds(c['start_time']) * 1000),
                        end_ms=round(TextProcessor.time_to_seconds(c['end_time']) * 1000), text=c['text'])
                    for i, c in enumerate(TextProcessor.parse_srt(Path(subtitles)), 1)]
    long_audio.checkpoint()
    document = combine(results, media['duration_ms'], existing)
    # Write the compatible final contract only after every validated chunk has completed.
    atomic_json(folder / 'speaker_subtitles.json', document.model_dump())
    text = '\n\n'.join(f"{i}\n{timestamp(c.start_ms)} --> {timestamp(c.end_ms)}\n{c.text}" for i, c in enumerate(document.subtitles, 1)) + '\n'
    pending = folder / 'subtitles.srt.part'
    pending.write_text(text, encoding='utf-8'); os.replace(pending, folder / 'subtitles.srt')
    return document, folder


def timestamp(value):
    return f'{value // 3600000:02}:{value // 60000 % 60:02}:{value // 1000 % 60:02},{value % 1000:03}'
