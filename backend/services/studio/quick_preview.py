"""Candidate-first production and selected-range speakers; no global settings mutation."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import json
import math
from pathlib import Path
import tempfile

from backend.core.path_utils import get_temp_directory
from backend.services.studio import store

_screening = ContextVar('quick_preview_screening', default=False)


def screening():
    return _screening.get()


def enabled(project_id):
    return (store.read(project_id).get('generation') or {}).get('quick_preview') is True


@contextmanager
def context(active=True):
    token = _screening.set(active)
    try:
        yield
    finally:
        _screening.reset(token)


def defer_for_project(function):
    @wraps(function)
    def run(project_id, *args, **kwargs):
        with context(enabled(project_id)):
            return function(project_id, *args, **kwargs)
    return run


def transcribe_plain(video, output, selection, language='auto'):
    """Prepare missing text with the chosen speaker runtime, skipping CAM++ entirely."""
    import os
    from backend.services import long_audio, long_speaker, speaker_autoflow, speaker_integration
    from backend.services.speaker_process import SpeakerProcess
    from backend.services.creator_library import asr_prompt
    root = speaker_integration.runtime_root()
    backend = 'whisper' if selection.provider == 'whisper_local' else 'sensevoice'
    worker = Path(__file__).parents[1] / 'speaker_worker.py'
    models = root / 'models'
    asr = models / ('whisper-medium' if backend == 'whisper' else 'sensevoice')
    python = root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    weights = asr / ('model.bin' if backend == 'whisper' else 'model.pt')
    if not python.is_file() or not weights.is_file():
        raise ValueError('所选本地转写模型未就绪')
    media = long_audio.probe(video)
    prompt = asr_prompt(selection.initial_prompt)
    files = [worker, Path(__file__), weights, models / 'fsmn-vad/model.pt']
    key = long_audio.identity(video, {'mode': 'plain-asr', 'backend': backend, 'prompt': prompt, 'language': language}, files)
    folder = long_audio.cache_directory(video, key, 'plain-asr')
    env = {key: value for key, value in os.environ.items() if not key.endswith(('_API_KEY', '_TOKEN')) and key not in ('SENTRY_DSN', 'PYTHONPATH')}
    env.update(PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', MODELSCOPE_OFFLINE='1', CUDA_VISIBLE_DEVICES='')
    command = [str(python), '-I', str(worker), '--session', '--asr-only', '--asr-model', str(asr),
               '--asr-backend', backend, '--vad-model', str(models / 'fsmn-vad'), '--language', language,
               '--threads', '4', '--initial-prompt', prompt]
    with SpeakerProcess(command, env=env, log=folder / 'plain-session.log') as session:
        def infer(audio, temporary, part):
            value = session.infer(audio, temporary / 'result.json')
            return {**value, 'windows': [], 'embeddings': []}
        results = long_audio.process_chunks(video, media, folder, key, infer, long_speaker.validate_chunk)
    document = long_speaker.combine(results, media['duration_ms'])
    text = '\n\n'.join(f'{index}\n{long_speaker.timestamp(cue.start_ms)} --> {long_speaker.timestamp(cue.end_ms)}\n{cue.text}'
                       for index, cue in enumerate(document.subtitles, 1)) + '\n'
    if not document.subtitles:
        raise ValueError('未识别到可用于预选的台词，请提供字幕或调整制作方式')
    target = Path(output) if output else Path(video).with_suffix('.srt')
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = folder / 'plain-subtitles.srt'
    temporary.write_text(text, encoding='utf-8')
    long_audio.checkpoint()
    speaker_autoflow._publish_new_srt(temporary, target)
    return target


def caption_document(project_id, draft):
    """Give candidate previews editable source text without starting a model."""
    from backend.services.speaker_integration import load_document
    from backend.services.publish_export import _load_srt_entries, to_seconds
    from backend.services.speaker_subtitles import Cue, SpeakerDocument
    cached = load_document(project_id)
    if cached:
        subtitles = [cue for cue in cached.subtitles if any(cue.start_ms < scene['end'] * 1000 and cue.end_ms > scene['start'] * 1000 for scene in draft['scenes'])]
        return cached.model_copy(update={'subtitles': subtitles}).model_dump()
    duration = (store.read(project_id).get('plan') or {}).get('source_duration')
    if not duration:
        return None
    try:
        rows = _load_srt_entries(project_id)
    except (OSError, ValueError, FileNotFoundError):
        return None
    cues = []
    for index, row in enumerate(rows):
        left, right = round(to_seconds(row['start_time']) * 1000), round(to_seconds(row['end_time']) * 1000)
        if any(left < scene['end'] * 1000 and right > scene['start'] * 1000 for scene in draft['scenes']):
            cues.append(Cue(id=f'cue_{index + 1:05d}', start_ms=left, end_ms=min(right, round(duration * 1000)), text=row['text']))
    return SpeakerDocument(duration_ms=round(duration * 1000), subtitles=cues).model_dump() if cues else None


def _labels(project_id, version, embeddings):
    """Keep anonymous IDs stable between selections from this same source."""
    from backend.services.speaker_integration import atomic_json
    target = store.directory(project_id) / 'metadata/selected-speaker-anchors.json'
    try:
        value = json.loads(target.read_text(encoding='utf-8'))
        anchors = value['anchors'] if value['source_version'] == version else []
    except (OSError, ValueError, KeyError):
        anchors = []
    if not isinstance(anchors, list) or len(anchors) > 2:
        raise ValueError('所选片段的人物缓存无效，请检查项目数据')
    labels = []
    for vector in embeddings:
        norm = math.sqrt(sum(value * value for value in vector))
        vector = [value / norm for value in vector]
        if any(len(anchor) != len(vector) or any(type(value) not in (int, float) or not math.isfinite(value) for value in anchor) for anchor in anchors):
            raise ValueError('所选片段的人物缓存维度无效')
        similarities = [sum(a * b for a, b in zip(vector, anchor)) for anchor in anchors]
        if not anchors or max(similarities) < .75 and len(anchors) < 2:
            anchors.append(vector)
            labels.append(f'spk_{len(anchors) - 1}')
        else:
            labels.append(f'spk_{max(range(len(anchors)), key=lambda index: similarities[index])}')
    atomic_json(target, {'source_version': version, 'anchors': anchors})
    return labels


def prepare_selected(project_id, video, draft):
    from backend.services import long_speaker, speaker_autoflow, speaker_integration
    from backend.services.ai_model_settings import load
    from backend.services.speaker_subtitles import Cue, SpeakerDocument
    from backend.services.subtitle_waveform import source_identity
    from backend.core.project_cancellation import checkpoint
    settings = load()
    selection = settings.transcription if settings else None
    if not selection or not getattr(selection, 'speaker_diarization', False):
        return draft.get('speaker_subtitles')
    from backend.pipeline.media_precheck import has_audio
    if has_audio(video) is False:
        return draft.get('speaker_subtitles')
    current = SpeakerDocument.model_validate(draft['speaker_subtitles']) if draft.get('speaker_subtitles') else None
    cached = speaker_integration.load_document(project_id)
    if cached:
        return {**cached.model_dump(), 'subtitles': current.model_dump()['subtitles'] if current else cached.model_dump()['subtitles']}
    ready = speaker_integration.status()
    if not ready.get('ready'):
        raise ValueError('本地说话人模型未就绪')
    ranges = [[round(scene['start'] * 1000), round(scene['end'] * 1000)] for scene in draft['scenes']]
    version = source_identity(video)
    with speaker_autoflow.operation(project_id), tempfile.TemporaryDirectory(prefix='selected-captions-', dir=get_temp_directory()) as temporary:
        subtitles = None
        if current and current.subtitles:
            subtitles = Path(temporary) / 'corrected.srt'
            text = '\n\n'.join(f'{index}\n{long_speaker.timestamp(cue.start_ms)} --> {long_speaker.timestamp(cue.end_ms)}\n{cue.text}' for index, cue in enumerate(current.subtitles, 1))+'\n'
            subtitles.write_text(text, encoding='utf-8')
        backend = 'whisper' if selection.provider == 'whisper_local' else 'sensevoice'
        document, _folder = long_speaker.execute(video, speaker_integration.runtime_root(), backend, selection.initial_prompt,
            subtitles, ranges=ranges, labeler=lambda vectors: _labels(project_id, version, vectors))
        checkpoint(project_id)
        if source_identity(video) != version:
            raise ValueError('原素材已变化，请重新生成所选片段')
        if current:
            # Association only: preserve the exact IDs, text and times from the candidate/editor.
            from backend.services.speaker_subtitles import associate_cues
            cues = associate_cues(current.subtitles, document.turns)
            people = {speaker.speaker_id: speaker for speaker in document.speakers}
            people.update({speaker.speaker_id: speaker for speaker in current.speakers})
            for index, cue in enumerate(current.subtitles):
                if cue.assignment_reason == 'manual':
                    cues[index] = Cue.model_validate(cue.model_dump())
            document = document.model_copy(update={'subtitles': cues, 'speakers': list(people.values())})
        return document.model_dump()
