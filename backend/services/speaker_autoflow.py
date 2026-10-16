"""Complete local speaker metadata before selecting or rendering new clips."""
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import uuid


def owner():
    import psutil
    return {'owner_pid': os.getpid(), 'owner_created_at': psutil.Process().create_time()}


def owner_alive(job):
    pid = job.get('owner_pid')
    if not pid or pid == os.getpid():
        return False  # The local _active set is authoritative for this process.
    try:
        import psutil
        return abs(psutil.Process(pid).create_time() - job['owner_created_at']) < .01
    except Exception as error:
        return type(error).__name__ == 'AccessDenied'


@contextmanager
def operation(project_id):
    from backend.services.speaker_integration import sidecar
    from backend.services.long_audio import exclusive
    from backend.core.project_cancellation import checkpoint
    metadata = sidecar(project_id).parent
    metadata.mkdir(exist_ok=True)  # Never recreate a deleted project root.
    folder = metadata / 'speaker-operation'
    folder.mkdir(exist_ok=True)
    while True:
        checkpoint(project_id)
        stack = ExitStack()
        try:
            stack.enter_context(exclusive(folder))
            break
        except ValueError:
            stack.close()
            time.sleep(.2)
    with stack:
        yield


def _fingerprint(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _publish_new_srt(source, target):
    """Publish complete text without overwriting a transcript created during inference."""
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
        pending = Path(stream.name)
        stream.write(source.read_bytes())
    try:
        os.link(pending, target)  # Same-volume atomic create; fails if target already exists.
    finally:
        pending.unlink(missing_ok=True)


def _was_stopped(project_id, job):
    from backend.services.speaker_integration import job_path
    try:
        value = json.loads(job_path(project_id).with_name('speaker_stop.json').read_text(encoding='utf-8'))
        return value.get('job_id') == job['job_id']
    except (OSError, ValueError, AttributeError):
        return False


def ensure(project_id, video, subtitles=None, on_progress=None, queued_job=None):
    from backend.services import speaker_integration as integration
    from backend.services.ai_model_settings import load
    from backend.services.publish_export import find_source_srt
    from backend.pipeline.media_precheck import has_audio
    from backend.core.project_cancellation import bind, checkpoint, JobStopped, ProjectDeleted
    from backend.utils.text_processor import TextProcessor
    settings = load()
    selection = settings.transcription if settings else None
    if not selection or not getattr(selection, 'speaker_diarization', False):
        return None
    cached = integration.load_document(project_id)
    if cached:
        return cached
    video = Path(video)
    sibling = video.with_suffix('.srt')
    conventional = video.parent / 'input.srt'
    subtitles = Path(subtitles) if subtitles else sibling if sibling.is_file() else conventional if conventional.is_file() else find_source_srt(project_id)
    if subtitles and (subtitles.name == 'singing-selection.srt' and subtitles.parent.name == 'analysis-only'):
        return None  # Song labels are analysis evidence, not spoken transcript text.
    if not subtitles and selection.provider == 'cloud':
        return None  # The normal ASR route controls cloud calls; this helper never adds one.
    if has_audio(video) is False:
        return None
    backend = 'whisper' if selection.provider == 'whisper_local' else 'sensevoice'
    with bind(project_id), operation(project_id):
        if queued_job and _was_stopped(project_id, queued_job):
            raise JobStopped(project_id)
        cached = integration.load_document(project_id)
        if cached:
            return cached
        if subtitles and not TextProcessor.parse_srt(subtitles):
            raise ValueError('已有字幕内容无效，请检查字幕后重试')
        fingerprint = _fingerprint(subtitles) if subtitles else None
        source_identity = (video.stat().st_size, video.stat().st_mtime_ns)
        job = {**(queued_job or {'job_id': uuid.uuid4().hex}), 'status': 'running', 'automatic': True, **owner()}
        integration._active.add(job['job_id'])
        def progress(done, total, reused):
            checkpoint(project_id)
            integration.atomic_json(integration.job_path(project_id), {**job, 'completed_chunks': done,
                'total_chunks': total, 'reused_chunks': reused, 'percent': round(done * 100 / total)})
            if on_progress:
                on_progress(done, total, reused)
        try:
            progress(0, 1, 0)
            document, folder = integration.execute(video, backend=backend, prompt=selection.initial_prompt,
                                                  subtitles=subtitles, on_progress=progress)
            checkpoint(project_id)
            if not video.exists():
                raise ProjectDeleted(project_id)
            if (video.stat().st_size, video.stat().st_mtime_ns) != source_identity:
                raise ValueError('原视频在识别期间发生变化，请重试')
            if subtitles and _fingerprint(subtitles) != fingerprint:
                raise ValueError('字幕在识别期间发生变化，请重试；已有修改已保留')
            if not subtitles:
                _publish_new_srt(Path(folder) / 'subtitles.srt', video.with_suffix('.srt'))
            checkpoint(project_id)
            integration.atomic_json(integration.sidecar(project_id), document.model_dump())
            progress(1, 1, 0)
            integration.atomic_json(integration.job_path(project_id), {**job, 'status': 'completed', 'percent': 100})
            return document
        except Exception as error:
            if video.exists() and not isinstance(error, ProjectDeleted):
                integration.atomic_json(integration.job_path(project_id), {**job,
                    'status': 'cancelled' if isinstance(error, JobStopped) else 'failed',
                    'error': str(error) if isinstance(error, (ValueError, JobStopped)) else '自动说话人识别失败，请重试；已有字幕已保留'})
            raise
        finally:
            integration._active.discard(job['job_id'])


def enqueue(project_id):
    """Explicit POST from an old draft editor; never launch inference on a GET."""
    from backend.services import speaker_integration as integration
    from backend.services.ai_model_settings import load
    from backend.services.studio.jobs import source
    settings = load()
    selection = settings.transcription if settings else None
    if not selection or not getattr(selection, 'speaker_diarization', False):
        return {'status': 'disabled'}
    with integration._lock:
        previous = integration.job_state(project_id)
        if integration.load_document(project_id) or previous['status'] in ('queued', 'running', 'cancelled'):
            return previous
        video = source(project_id)
        job = {'job_id': uuid.uuid4().hex, 'status': 'queued', 'automatic': True, **owner()}
        integration._active.add(job['job_id'])
        integration.atomic_json(integration.job_path(project_id), job)
        try:
            integration._executor.submit(_queued, project_id, video, job)
        except Exception:
            integration._active.discard(job['job_id'])
            integration.atomic_json(integration.job_path(project_id), {**job, 'status': 'failed',
                'error': '自动说话人识别失败，请重试；已有字幕已保留'})
            raise
        return integration.job_state(project_id)


def _queued(project_id, video, job):
    from backend.services import speaker_integration as integration
    from backend.core.project_cancellation import JobStopped
    try:
        if _was_stopped(project_id, job):
            raise JobStopped(project_id)
        document = ensure(project_id, video, queued_job=job)
        current = integration.job_state(project_id)
        if current.get('job_id') == job['job_id'] and video.exists():
            integration.atomic_json(integration.job_path(project_id), {**job,
                'status': 'completed' if document else 'skipped'})
    except Exception as error:
        if video.exists():
            current = integration.job_state(project_id)
            if current.get('job_id') == job['job_id'] and current['status'] in ('queued', 'running'):
                integration.atomic_json(integration.job_path(project_id), {**job,
                    'status': 'cancelled' if isinstance(error, JobStopped) else 'failed',
                    'error': str(error) if isinstance(error, (ValueError, JobStopped)) else '自动说话人识别失败，请重试；已有字幕已保留'})
    finally:
        integration._active.discard(job['job_id'])
