"""Short, offline subtitle repair jobs. Candidates never modify a saved subtitle document."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import uuid

from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Literal

from backend.core.path_utils import get_temp_directory
from backend.services import long_audio
from backend.services.speaker_integration import atomic_json, runtime_root
from backend.services.speaker_process import SpeakerProcess
from backend.services.speaker_subtitles import Cue
from backend.services.studio import store
from backend.services.subtitle_waveform import bounds, source_identity

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='subtitle-repair')
_lock = threading.RLock()
_active = {}
_instance = uuid.uuid4().hex
_engine_lock = threading.RLock()
_engine = None
IDLE_SECONDS = 120


def _close_engine(expected=None, token=None):
    global _engine
    with _engine_lock:
        if (_engine is None or (expected is not None and _engine is not expected)
                or (token is not None and _engine.get('timer_id') != token)):
            return
        engine, _engine = _engine, None
        if engine.get('timer'):
            engine['timer'].cancel()
        engine['process'].__exit__(None, None, None)
        engine['log'].unlink(missing_ok=True)


class Request(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(gt=0, allow_inf_nan=False)
    backend: Literal['whisper', 'sensevoice'] = 'whisper'
    prompt: str = Field(default='', max_length=500)
    source_version: str = Field(pattern=r'^[a-f0-9]{64}$')

    @model_validator(mode='after')
    def interval(self):
        if not .1 <= self.end - self.start <= 60:
            raise ValueError('请圈选 0.1 至 60 秒的音频')
        return self


class State(BaseModel):
    job_id: str
    status: Literal['queued', 'running', 'completed', 'failed', 'cancelled']
    stage: Literal['queued', 'extracting', 'recognizing', 'completed', 'failed', 'cancelled']
    start_ms: int
    end_ms: int
    source_version: str
    backend: Literal['whisper', 'sensevoice']
    subtitles: list[Cue] = Field(default_factory=list)
    error: str = ''
    created_at: str


class Cancelled(Exception):
    pass


def _path(project_id, job_id):
    if not re.fullmatch(r'[a-f0-9]{32}', job_id):
        raise ValueError('字幕修复任务编号无效')
    return store.directory(project_id) / 'metadata/subtitle-repairs' / (job_id + '.json')


def _read(project_id, job_id):
    return json.loads(_path(project_id, job_id).read_text(encoding='utf-8'))


def state(project_id, job_id):
    with _lock:
        value = _read(project_id, job_id)
        if value['status'] in ('queued', 'running') and value.get('instance') != _instance:
            value.update(status='failed', stage='failed', error='上次局部识别已中断，请重新识别；原字幕未改动')
        if value['status'] == 'completed':
            from backend.services.studio.jobs import source
            if source_identity(source(project_id)) != value['source_version']:
                raise store.ConflictError('原素材已变化，请重新圈选识别；原字幕未改动')
        return State.model_validate(value).model_dump()


def _write(project_id, value):
    from backend.core.project_cancellation import checkpoint
    checkpoint(project_id)
    if not store.directory(project_id).is_dir():
        raise FileNotFoundError('项目已删除')
    atomic_json(_path(project_id, value['job_id']), value)


def start(project_id, request):
    from backend.services.studio.jobs import source
    from backend.services.studio.store import ConflictError
    video = source(project_id)
    identity = source_identity(video)
    if request.source_version != identity:
        raise ConflictError('原素材已变化，请刷新波形后重新圈选')
    root = runtime_root()
    python = root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    model = root / 'models' / ('whisper-medium' if request.backend == 'whisper' else 'sensevoice')
    weights = 'model.bin' if request.backend == 'whisper' else 'model.pt'
    if not python.is_file() or not (model / weights).is_file() or not (root / 'models/fsmn-vad/model.pt').is_file():
        raise ValueError('所选本地转写模型未就绪，请在模型设置中准备后重试')
    signature = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
    with _lock:
        target = _path(project_id, request.request_id)
        if target.is_file():
            previous = _read(project_id, request.request_id)
            if previous.get('signature') != signature:
                raise ConflictError('同一请求编号不能用于不同选区')
            return state(project_id, request.request_id)
        if project_id in _active or len(_active) >= 4:
            raise ConflictError('局部识别正在进行，请等待或取消后重试')
        value = dict(job_id=request.request_id, status='queued', stage='queued',
                     start_ms=round(request.start * 1000), end_ms=round(request.end * 1000),
                     source_version=identity, backend=request.backend, subtitles=[], error='',
                     created_at=datetime.now(timezone.utc).isoformat(), instance=_instance, signature=signature)
        event = threading.Event()
        _active[project_id] = (request.request_id, event)
        try:
            _write(project_id, value)
            # Retain a bounded recent history without discarding the current task.
            files = sorted(target.parent.glob('*.json'), key=lambda item: item.stat().st_mtime)
            for previous in files[:-20]:
                previous.unlink(missing_ok=True)
            _executor.submit(_run, project_id, video, request, value.copy(), event)
        except BaseException:
            _active.pop(project_id, None)
            raise
        return state(project_id, request.request_id)


def cancel(project_id, job_id):
    with _lock:
        value = _read(project_id, job_id)
        if value['status'] in ('queued', 'running'):
            active = _active.get(project_id)
            if active and active[0] == job_id:
                active[1].set()
                _active.pop(project_id, None)
            value.update(status='cancelled', stage='cancelled', subtitles=[])
            _write(project_id, value)
        return state(project_id, job_id)


def _infer(audio, folder, request):
    global _engine
    root = runtime_root()
    python = root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    result = folder / 'result.json'
    command = [str(python), '-I', str(Path(__file__).with_name('speaker_worker.py')),
               '--asr-only', '--session',
               '--vad-model', str(root / 'models/fsmn-vad'), '--asr-backend', request.backend,
               '--asr-model', str(root / 'models' / ('whisper-medium' if request.backend == 'whisper' else 'sensevoice')),
               '--initial-prompt', request.prompt, '--language', 'auto', '--threads', '4']
    env = os.environ.copy()
    for key in list(env):
        if key.endswith(('_API_KEY', '_TOKEN')) or key in ('SENTRY_DSN', 'PYTHONPATH'):
            env.pop(key)
    env.update(PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1',
               TRANSFORMERS_OFFLINE='1', MODELSCOPE_OFFLINE='1', CUDA_VISIBLE_DEVICES='')
    weights = root / 'models' / ('whisper-medium/model.bin' if request.backend == 'whisper' else 'sensevoice/model.pt')
    vad = root / 'models/fsmn-vad/model.pt'
    key = (tuple(command), tuple((file.stat().st_size, file.stat().st_mtime_ns) for file in (weights, vad)))
    with _engine_lock:
        if _engine is not None and _engine['key'] != key:
            _close_engine()
        if _engine is None:
            log = get_temp_directory() / ('subtitle-repair-worker-' + uuid.uuid4().hex + '.log')
            process = SpeakerProcess(command, env=env, log=log, timeout=300)
            process.__enter__()
            _engine = {'key': key, 'process': process, 'log': log, 'timer': None}
        engine = _engine
        if engine['timer']:
            engine['timer'].cancel()
        try:
            value = engine['process'].infer(audio, result)
        except BaseException as error:
            _engine = None
            try:
                engine['process'].__exit__(type(error), error, error.__traceback__)
            finally:
                engine['log'].unlink(missing_ok=True)
            raise
        token = uuid.uuid4().hex
        timer = threading.Timer(IDLE_SECONDS, _close_engine, args=(engine, token))
        timer.daemon = True
        engine['timer'] = timer
        engine['timer_id'] = token
        timer.start()
        return value


def _run(project_id, video, request, value, event):
    from backend.core.project_cancellation import checkpoint

    def check():
        checkpoint(project_id)
        if event.is_set():
            raise Cancelled()
        if not store.directory(project_id).is_dir():
            raise FileNotFoundError('项目已删除')

    def progress(stage):
        with _lock:
            check()
            value.update(status='running', stage=stage)
            _write(project_id, value)

    try:
        with long_audio.cancellation(check):
            check()
            media = long_audio.probe(video)
            left, right = bounds(request.start, request.end, media['duration_ms'] / 1000, 60)
            if right - left < 100 or right != round(request.end * 1000):
                raise ValueError('选区超出原片范围，请重新圈选')
            progress('extracting')
            with tempfile.TemporaryDirectory(prefix='subtitle-repair-', dir=get_temp_directory()) as temporary:
                folder = Path(temporary)
                audio = folder / 'selection.wav'
                long_audio.extract(video, audio, {'start_ms': left, 'end_ms': right}, media)
                progress('recognizing')
                from backend.services.creator_library import asr_prompt, project_query
                options = request.model_copy(update={'prompt': asr_prompt(request.prompt, query=project_query(project_id))})
                raw = _infer(audio, folder, options)
                subtitles = []
                for index, item in enumerate(raw['subtitles']):
                    cue = Cue.model_validate(item)
                    if cue.end_ms > right - left:
                        raise ValueError('局部识别返回的时间超出选区，请重试')
                    subtitles.append(cue.model_copy(update={
                        'id': f'repair_{request.request_id}_{index}', 'start_ms': left + cue.start_ms,
                        'end_ms': left + cue.end_ms, 'speaker_id': None, 'assignment_reason': 'unassigned'}).model_dump())
            with _lock:
                check()
                if source_identity(video) != request.source_version:
                    raise ValueError('原素材已变化，请重新圈选识别；原字幕未改动')
                value.update(status='completed', stage='completed', subtitles=subtitles)
                _write(project_id, value)
    except Cancelled:
        pass  # Cancellation already wrote its terminal state.
    except Exception as error:
        with _lock:
            if not event.is_set() and store.directory(project_id).is_dir():
                value.update(status='failed', stage='failed', subtitles=[], error=(
                    '局部识别超时，请缩短选区后重试；原字幕未改动' if isinstance(error, subprocess.TimeoutExpired)
                    else '局部识别失败，请检查音轨和本地模型后重试；原字幕未改动'))
                try:
                    _write(project_id, value)
                except FileNotFoundError:
                    pass
    finally:
        with _lock:
            if _active.get(project_id, (None,))[0] == request.request_id:
                _active.pop(project_id, None)
