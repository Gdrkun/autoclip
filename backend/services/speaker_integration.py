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
from backend.services import child_guard
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
            'whisper_model': 'medium', 'max_duration_seconds': 600}


def execute(video, *, backend='whisper', prompt='', subtitles=None):
    root = runtime_root()
    from backend.services.creator_library import asr_prompt
    prompt = asr_prompt(prompt)
    ready = status()
    if not ready.get(backend):
        raise ValueError('本地说话人模型未就绪')
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
    with log.open('w', encoding='utf-8') as stream:
        process = subprocess.Popen(command, env=env, stdout=stream, stderr=subprocess.STDOUT)
        child_guard.track(process, 'speaker-' + output.name)
        try:
            code = process.wait(timeout=1200)
        except subprocess.TimeoutExpired:
            child_guard.kill('speaker-' + output.name)
            raise ValueError('说话人识别超时，请缩短视频后重试') from None
    if code:
        raise ValueError('本地字幕识别失败，请确认视频有声音且不超过十分钟')
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
        document, folder = execute(video, backend=backend, prompt=selection.initial_prompt)
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
        atomic_json(job_path(project_id), {**job, 'status': 'running'})
        document, _ = execute(source, backend=backend, prompt=prompt,
                               subtitles=find_source_srt(project_id) if reuse else None)
        if not source.exists():
            return
        atomic_json(sidecar(project_id), document.model_dump())
        atomic_json(job_path(project_id), {**job, 'status': 'completed'})
    except Exception as exc:
        if source.exists():
            atomic_json(job_path(project_id), {**job, 'status': 'failed', 'error': str(exc) if isinstance(exc, ValueError) else '本地字幕识别失败，请重试'})
    finally:
        _active.discard(job['job_id'])
