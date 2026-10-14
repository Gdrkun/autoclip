"""Offline Whisper adapter used inside the isolated speaker worker."""
import math
from pathlib import Path


def local_model(path):
    root = Path(path).expanduser().resolve()
    if not all((root / name).is_file() for name in ('model.bin', 'config.json', 'tokenizer.json')):
        raise ValueError('Local Whisper model is not ready')
    return root


def transcribe(samples, model_path, duration_ms, language, threads, prompt='', turns=()):
    from faster_whisper import WhisperModel
    from speaker_subtitles import Cue
    model = WhisperModel(str(local_model(model_path)), device='cpu', compute_type='int8',
                         cpu_threads=threads, num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(samples, language=None if language == 'auto' else language,
                                   beam_size=5, temperature=0, word_timestamps=True, vad_filter=False,
                                   condition_on_previous_text=False, initial_prompt=prompt or None,
                                   hotwords=prompt or None)
    cues, raw = [], []
    for segment in segments:
        if not segment.text.strip():
            continue
        start, end = segment.start * 1000, segment.end * 1000
        if not all(math.isfinite(v) for v in (start, end)) or not 0 <= start < end:
            raise ValueError('Whisper returned invalid timestamps')
        if start >= duration_ms:
            continue
        words = getattr(segment, 'words', None) or []
        usable = bool(words) and ''.join(w.word for w in words).strip() == segment.text.strip()
        usable = usable and all(math.isfinite(w.start) and math.isfinite(w.end) and 0 <= w.start < w.end for w in words)
        if usable:
            group, speaker = [], None
            def flush():
                if group:
                    left, right = round(group[0].start * 1000), min(duration_ms, round(max(w.end for w in group) * 1000))
                    if left < right:
                        cues.append(Cue(id=f'cue_{len(cues) + 1:04d}', start_ms=left, end_ms=right,
                                        text=''.join(w.word for w in group).strip()))
                    group.clear()
            for word in words:
                if word.start * 1000 >= duration_ms:
                    continue
                middle = (word.start + word.end) * 500
                identity = next((turn.speaker_id for turn in turns if turn.start_ms <= middle < turn.end_ms), None)
                if group and (identity != speaker or word.end - group[0].start > 6
                              or len(''.join(w.word for w in group) + word.word) > 42):
                    flush()
                group.append(word)
                speaker = identity
                if word.word.rstrip().endswith(('。', '！', '？', '.', '!', '?')):
                    flush()
            flush()
        else:
            left, right = round(start), min(duration_ms, round(end))
            if left < right:
                cues.append(Cue(id=f'cue_{len(cues) + 1:04d}', start_ms=left, end_ms=right, text=segment.text.strip()))
        raw.append({'start': segment.start, 'end': segment.end, 'text': segment.text})
    return cues, raw
