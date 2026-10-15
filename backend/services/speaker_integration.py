"""Project integration for local ASR and editable speaker subtitles. No model imports."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import uuid

from backend.core.path_utils import get_data_directory
from backend.services.speaker_subtitles import SpeakerDocument

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='speaker-subtitles')
_lock = threading.RLock()
_active = set()


def runtime_root():
    return Path(os.getenv('AUTOCLIP_SPEAKER_RUNTIME', str(get_data_directory() / 'speaker-runtime'))).resolve()


def status():
    root = runtime_root()
    python = root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    models = root / 'models'
    common = python.is_file() and (models / 'campplus/config.yaml').is_file() and (models / 'fsmn-vad/model.pt').is_file()
    return {'ready': bool(common), 'sensevoice': bool(common and (models / 'sensevoice/model.pt').is_file()),
            'whisper': bool(common and (models / 'whisper-medium/model.bin').is_file()),
            'whisper_model': 'medium', 'max_duration_seconds': None, 'chunk_seconds': 180, 'resumable': True}


def execute(video, *, backend='whisper', prompt='', subtitles=None, on_progress=None):
    root = runtime_root()
    from backend.services.creator_library import asr_prompt
    prompt = asr_prompt(prompt)
    ready = status()
    if not ready.get(backend):
        raise ValueError('本地说话人模型未就绪')
    from backend.services import long_audio, long_speaker
    media = long_audio.probe(video)
    if media['duration_ms'] > 600000:
        try:
            return long_speaker.execute(video, root, backend, prompt, subtitles, on_progress)
        except subprocess.TimeoutExpired:
            raise ValueError('本地字幕分段处理超时，已完成的分段已保留，可重试继续') from None
        except ValueError as error:
            name = 'SenseVoiceSmall' if backend == 'sensevoice' else 'Whisper'
            raise ValueError(name + ' 分段字幕处理未完成，已完成的分段和原字幕已保留，可重试继续') from error
    python = root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    cli = Path(__file__).resolve().parents[2] / 'scripts' / 'speaker_poc.py'
    # __file__ is backend/services: the repository is parents[2].
    runs = root / 'app-runs'
    runs.mkdir(parents=True, exist_ok=True)
    output = runs / uuid.uuid4().hex
    command = [str(python), str(cli), '--video', str(video), '--output-dir', str(output),
               '--python', str(python), '--cam-model', str(root / 'models/campplus'),
               '--vad-model', str(root / 'models/fsmn-vad'), '--speakers', '2', '--threads', '4', '--language', 'auto']
    if subtitles:
        command += ['--subtitles', str(subtitles)]
    else:
        command += ['--asr-backend', backend, '--asr-model', str(root / 'models' / ('whisper-medium' if backend == 'whisper' else 'sensevoice')),
                    '--initial-prompt', prompt]
    env = os.environ.copy()
    for key in list(env):
        if key.endswith(('_API_KEY', '_TOKEN')) or key in ('SENTRY_DSN', 'PYTHONPATH'):
            env.pop(key)
    env.update(PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1',
               TRANSFORMERS_OFFLINE='1', MODELSCOPE_OFFLINE='1', CUDA_VISIBLE_DEVICES='')
    log = runs / (output.name + '.log')
    try:
        long_audio.run_child(command, env=env, log=log, timeout=1200)
    except subprocess.TimeoutExpired:
        raise ValueError('本地字幕分段处理超时，已完成的分段已保留，可重试继续') from None
    except ValueError as error:
        name = 'SenseVoiceSmall' if backend == 'sensevoice' else 'Whisper'
        raise ValueError(name + ' 本地字幕识别失败，请检查视频音轨或重试；已有字幕已保留') from error

    document = SpeakerDocument.model_validate_json((output / 'speaker_subtitles.json').read_text(encoding='utf-8'))
    document = document.model_copy(update={'speakers': [speaker.model_copy(update={
        'color': ['#FF91BD', '#C0A5FF'][index % 2] if speaker.color == '#FFFFFF' else speaker.color})
        for index, speaker in enumerate(document.speakers)]})
    return document, output


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
        pending = Path(stream.name)
        json.dump(data, stream, ensure_ascii=False, allow_nan=False)
    try:
        os.replace(pending, path)
    finally:
        pending.unlink(missing_ok=True)


def sidecar(project_id):
    from backend.services.studio.store import directory
    return directory(project_id) / 'metadata/speaker_subtitles.json'


def load_document(project_id):
    path = sidecar(project_id)
    if not path.is_file():
        return None
    try:
        return SpeakerDocument.model_validate_json(path.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        logging.getLogger(__name__).warning('Speaker sidecar unavailable; preserving legacy subtitle mode')
        return None


def hydrate(project_id, draft):
    if draft.speaker_subtitles is None and draft.speaker_colors:
        document = load_document(project_id)
        if document:
            return draft.model_copy(update={'speaker_subtitles': document})
    return draft


def transcribe_local(video, output, selection, language='auto'):
    from backend.utils.speech_recognizer import SpeechRecognitionError
    try:
        backend = 'whisper' if selection.provider == 'whisper_local' else 'sensevoice'
        from backend.utils.transcription_progress import report
        document, folder = execute(video, backend=backend, prompt=selection.initial_prompt,
                                   on_progress=lambda done, total, reused: report(done, total))
        destination = Path(output) if output else video.with_suffix('.srt')
        destination.parent.mkdir(parents=True, exist_ok=True)
        # This path is only entered to create a missing transcript.
        with tempfile.NamedTemporaryFile(mode='wb', dir=destination.parent, delete=False) as stream:
            pending = Path(stream.name)
            stream.write((folder / 'subtitles.srt').read_bytes())
        os.replace(pending, destination)
        # raw/input.* and metadata/<name>.srt share the same project root.
        project = video.parent.parent
        atomic_json(project / 'metadata/speaker_subtitles.json', document.model_dump())
        return destination
    except (OSError, ValueError) as exc:
        raise SpeechRecognitionError(str(exc)) from exc


def job_path(project_id):
    return sidecar(project_id).with_name('speaker_job.json')


def job_state(project_id):
    path = job_path(project_id)
    if not path.is_file():
        return {'status': 'idle'}
    value = json.loads(path.read_text(encoding='utf-8'))
    if value['status'] in ('queued', 'running') and value.get('job_id') not in _active:
        value.update(status='failed', error='识别已中断，请重试')
        atomic_json(path, value)
    return value


def start(project_id, backend, prompt, reuse=True):
    from backend.services.studio import jobs
    source = jobs.source(project_id)
    if not status().get(backend):
        raise ValueError('本地说话人模型未就绪')
    with _lock:
        previous = job_state(project_id)
        if previous.get('status') in ('queued', 'running'):
            return previous
        job = {'job_id': uuid.uuid4().hex, 'status': 'queued'}
        _active.add(job['job_id'])
        atomic_json(job_path(project_id), job)
        try:
            _executor.submit(_recognize, project_id, source, backend, prompt, reuse, job)
        except Exception:
            _active.discard(job['job_id'])
            atomic_json(job_path(project_id), {**job, 'status': 'failed', 'error': '识别已中断，请重试'})
            raise
        return job


from backend.services.character_background import with_project_context


@with_project_context
def _recognize(project_id, source, backend, prompt, reuse, job):
    from backend.services.publish_export import find_source_srt
    try:
        if not source.exists():
            return
        from backend.core.project_cancellation import bind
        def progress(done, total, reused):
            atomic_json(job_path(project_id), {**job, 'status': 'running', 'completed_chunks': done,
                                               'total_chunks': total, 'reused_chunks': reused,
                                               'percent': round(done * 100 / total)})
        atomic_json(job_path(project_id), {**job, 'status': 'running'})
        with bind(project_id):
            from backend.core.project_cancellation import checkpoint, JobStopped
            try:
                cancelled = json.loads(job_path(project_id).with_name('speaker_stop.json').read_text(encoding='utf-8'))
            except (OSError, ValueError):
                cancelled = {}
            if cancelled.get('job_id') == job['job_id']:
                raise JobStopped(project_id)
            document, _ = execute(source, backend=backend, prompt=prompt,
                                  subtitles=find_source_srt(project_id) if reuse else None, on_progress=progress)
            checkpoint(project_id)
            if not source.exists():
                return
            atomic_json(sidecar(project_id), document.model_dump())
            atomic_json(job_path(project_id), {**job, 'status': 'completed'})
    except Exception as exc:
        from backend.core.project_cancellation import JobStopped, ProjectDeleted
        if isinstance(exc, ProjectDeleted):
            return
        if isinstance(exc, JobStopped):
            if source.exists():
                atomic_json(job_path(project_id), {**job, 'status': 'cancelled', 'error': '识别已暂停，重试会复用已完成分段'})
            return
        if source.exists():
            atomic_json(job_path(project_id), {**job, 'status': 'failed', 'error': str(exc) if isinstance(exc, ValueError) else '本地字幕识别失败，请重试'})
    finally:
        _active.discard(job['job_id'])
