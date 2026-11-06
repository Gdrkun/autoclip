"""Offline Whisper adapter used inside the isolated speaker worker."""
import math
from functools import lru_cache
from pathlib import Path


def local_model(path):
    root = Path(path).expanduser().resolve()
    if not all((root / name).is_file() for name in ('model.bin', 'config.json', 'tokenizer.json')):
        raise ValueError('Local Whisper model is not ready')
    return root


@lru_cache(maxsize=2)
def _model(model_path, threads):
    from faster_whisper import WhisperModel
    return WhisperModel(str(local_model(model_path)), device='cpu', compute_type='int8',
                        cpu_threads=threads, num_workers=1, local_files_only=True)


def transcribe(samples, model_path, duration_ms, language, threads, prompt='', turns=()):
    from speaker_subtitles import Cue
    model = _model(str(Path(model_path).resolve()), threads)
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


def align(samples, model_path, duration_ms, cues, language='auto', threads=4):
    """Force the supplied tokens against the audio; never decode replacement words."""
    from faster_whisper.audio import pad_or_trim
    from faster_whisper.tokenizer import Tokenizer
    from speaker_subtitles import Cue
    if not 100 <= duration_ms <= 30000 or not cues or len(cues) > 40:
        raise ValueError('自动对齐支持最多 30 秒、40 句字幕')
    model = _model(str(Path(model_path).resolve()), threads)
    features = model.feature_extractor(samples)[..., :-1]
    frames = features.shape[-1]
    encoded = model.encode(pad_or_trim(features))
    if language == 'auto':
        language = model.model.detect_language(encoded)[0][0][0].removeprefix('<|').removesuffix('|>')
    tokenizer = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task='transcribe', language=language)
    tokens, spans = [], []
    for item in cues:
        cue = Cue.model_validate(item)
        if not any(character.isalnum() for character in cue.text):
            raise ValueError('待对齐字幕需要包含实际台词')
        if tokens:
            tokens.extend(tokenizer.encode(' '))
        begin = len(tokens)
        part = tokenizer.encode(cue.text)
        if not part:
            raise ValueError('待对齐字幕无法编码')
        tokens.extend(part)
        spans.append((begin, len(tokens), cue))
    if len(tokens) > 400:
        raise ValueError('待对齐文字过长，请缩短选区')
    words = model.find_alignment(tokenizer, [tokens], encoded, frames)[0]
    cursor, aligned = 0, []
    for word in words:
        count = len(word['tokens'])
        if tokens[cursor:cursor + count] != word['tokens']:
            raise ValueError('对齐词序与校正文字不一致')
        start, end = float(word['start']), float(word['end'])
        if not all(math.isfinite(value) for value in (start, end)) or start < 0 or end < start:
            raise ValueError('自动对齐返回无效时间')
        if end > start and any(character.isalnum() for character in word['word']):
            aligned.append((cursor, cursor + count, round(start * 1000), min(duration_ms, round(end * 1000))))
        cursor += count
    if cursor != len(tokens):
        raise ValueError('校正文字未完整对齐，请缩短选区或逐句对齐')
    results = []
    for begin, stop, cue in spans:
        selected = [word for word in aligned if word[0] < stop and word[1] > begin]
        if not selected:
            raise ValueError('部分台词没有可用对齐时间，请逐句核对')
        left, right = min(word[2] for word in selected), max(word[3] for word in selected)
        if right - left < 100:
            raise ValueError('对齐区间过短，请缩短选区或逐句对齐')
        results.append(cue.model_copy(update={'start_ms': left, 'end_ms': right}).model_dump())
    return results
