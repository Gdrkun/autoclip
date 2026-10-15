"""Optional offline singing candidates; no ML imports in the API process."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

from pydantic import BaseModel, ConfigDict, Field, model_validator
from backend.services.speaker_integration import atomic_json, runtime_root
from backend.services import child_guard

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='singing-cpu')
_lock = threading.RLock()
_inference_lock = threading.Lock()
_preparing = False
_current = ContextVar('singing_candidates', default=None)


class Segment(BaseModel):
    model_config = ConfigDict(extra='ignore', allow_inf_nan=False)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    score: float = Field(ge=0, le=1)

    @model_validator(mode='after')
    def ordered(self):
        if self.end <= self.start:
            raise ValueError('Invalid singing interval')
        return self


class Report(BaseModel):
    model_config = ConfigDict(extra='ignore', allow_inf_nan=False)
    status: str
    model: str = ''
    device: str = 'cpu'
    duration: float = Field(default=0, ge=0, le=7200)
    quality: str = 'candidate_requires_review'
    segments: list[Segment] = Field(default_factory=list, max_length=1500)
    fingerprint: str = ''
    error: str = ''

    @model_validator(mode='after')
    def bounded(self):
        if any(s.end > self.duration for s in self.segments):
            raise ValueError('Singing interval outside source')
        return self


def model_root():
    return runtime_root() / 'models/singing-ast'


def python():
    return runtime_root() / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def status():
    root = model_root()
    state = {'status': 'not_ready', 'runtime_ready': python().is_file(), 'device': 'cpu', 'download_mib': 330}
    if _preparing:
        return {**state, 'status': 'preparing'}
    try:
        ready = json.loads((root / 'ready.json').read_text(encoding='utf-8'))
        if ready.get('status') == 'ready' and all((root / name).is_file() for name in ['config.json', 'preprocessor_config.json', 'model.safetensors']):
            return {**state, 'status': 'ready'}
        if ready.get('status') in ('failed', 'preparing'):
            return {**state, 'status': 'failed', 'error': '模型准备未完成，可以重试'}
    except (OSError, ValueError):
        pass
    return state


def _worker(action, result, audio=None):
    command = [str(python()), str(Path(__file__).with_name('singing_worker.py')), action,
               '--model', str(model_root()), '--result', str(result)]
    if audio:
        command += ['--audio', str(audio)]
    env = {k: v for k, v in os.environ.items() if not k.endswith(('_API_KEY', '_TOKEN'))
           and k not in ('SENTRY_DSN', 'PYTHONPATH')}
    env.update(PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', CUDA_VISIBLE_DEVICES='')
    if action == 'analyze':
        env.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', MODELSCOPE_OFFLINE='1')
    log = result.with_suffix('.log')
    with log.open('w', encoding='utf-8') as stream:
        process = subprocess.Popen(command, env=env, stdout=stream, stderr=subprocess.STDOUT)
        owner = 'singing-' + str(process.pid)
        child_guard.track(process, owner)
        try:
            code = process.wait(timeout=1800)
        except subprocess.TimeoutExpired:
            child_guard.kill(owner)
            raise ValueError('歌声检测超时，请缩短视频后重试') from None
    if code:
        raise ValueError('歌声模型未完成处理，请检查本地运行时和模型后重试')


def prepare():
    global _preparing
    with _lock:
        if status()['status'] in ('ready', 'preparing'):
            return status()
        if not python().is_file():
            raise ValueError('请先准备本地说话人运行时，再下载歌声模型')
        model_root().mkdir(parents=True, exist_ok=True)
        atomic_json(model_root() / 'ready.json', {'status': 'preparing'})
        _preparing = True
        try:
            _executor.submit(_prepare)
        except Exception:
            _preparing = False
            raise
        return status()


def _prepare():
    global _preparing
    try:
        with _inference_lock:
            _worker('prepare', model_root() / 'ready.json')
    except Exception:
        atomic_json(model_root() / 'ready.json', {'status': 'failed'})
    finally:
        _preparing = False


def report_path(project_id):
    from backend.services.studio import store
    return store.directory(project_id) / 'metadata/singing-analysis.json'


def fingerprint(video):
    info = Path(video).stat()
    return hashlib.sha256(f'{info.st_size}:{info.st_mtime_ns}'.encode()).hexdigest()


def analyze(project_id, video, enabled):
    if not enabled:
        if report_path(project_id).exists():
            atomic_json(report_path(project_id), Report(status='disabled').model_dump())
        return None
    from backend.core.project_cancellation import checkpoint
    checkpoint(project_id)
    previous = load_project(project_id)
    if previous and previous.fingerprint == fingerprint(video):
        return previous
    if status()['status'] != 'ready':
        result = Report(status='unavailable', error='歌声模型尚未就绪，本次按字幕和制作要求选片')
    else:
        try:
            from backend.utils.ffmpeg_utils import get_ffmpeg_path
            from backend.services.studio.intelligence import _probe
            duration = float(_probe(video).get('duration') or 0)
            if not 1 <= duration <= 7200:
                raise ValueError('歌声检测支持 1 秒至 2 小时的视频')
            with _inference_lock, tempfile.TemporaryDirectory(prefix='autoclip-singing-') as temp:
                audio, output = Path(temp) / 'audio.wav', Path(temp) / 'result.json'
                extracted = subprocess.run([get_ffmpeg_path(), '-nostdin', '-v', 'error', '-y', '-i', str(video),
                                            '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(audio)],
                                           capture_output=True, timeout=300)
                if extracted.returncode:
                    raise ValueError('无法读取音轨，歌声检测未完成')
                checkpoint(project_id)
                _worker('analyze', output, audio)
                result = Report.model_validate_json(output.read_text(encoding='utf-8'))
                result.fingerprint = fingerprint(video)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            result = Report(status='failed', error=str(error) if isinstance(error, ValueError) else '歌声检测未完成，本次按字幕选片')
    checkpoint(project_id)
    if not report_path(project_id).parent.parent.exists():
        raise FileNotFoundError('项目已删除')
    atomic_json(report_path(project_id), result.model_dump())
    return result


def load_project(project_id):
    try:
        report = Report.model_validate_json(report_path(project_id).read_text(encoding='utf-8'))
        if report.status != 'completed':
            return None
        from backend.services.studio.jobs import source
        return report if report.fingerprint == fingerprint(source(project_id)) else None
    except (OSError, ValueError):
        return None


@contextmanager
def project_context(project_id):
    token = _current.set(load_project(project_id))
    try:
        yield
    finally:
        _current.reset(token)


def context_prompt():
    report = _current.get()
    if not report or not report.segments:
        return ''
    return ('\n## 本地 CPU 音频模型检测到的歌声候选\n'
            '以下区间来自实际音轨分类，不是歌词转写。分数不是准确率；可能混入伴奏或哼唱，请结合字幕核实。'
            '用户偏好唱歌时优先考察，保留完整乐句和必要前后铺垫；字幕缺失不表示没有歌声。'
            '不得编造歌词、歌名或人物身份；区间边界粗略，最终必须人工试听。\n'
            + json.dumps([s.model_dump() for s in report.segments[:80]], ensure_ascii=False) + '\n')


def context_key():
    return hashlib.sha256(context_prompt().encode()).hexdigest() if context_prompt() else ''


def preserve_song_bounds(clips, refined):
    report = _current.get()
    if not report or not report.segments:
        return refined
    output = []
    for original, boundary in zip(clips, refined):
        start, end = original
        covered = sum(max(0, min(end, segment.end) - max(start, segment.start)) for segment in report.segments)
        # Sentence-only polishing has no evidence for missing lyrics. Keep the selected audio range.
        output.append(original if covered >= (end - start) * .4 else boundary)
    return output


def selection_entries(entries):
    report = _current.get()
    if not report or not report.segments:
        return entries
    from backend.pipeline.quality import to_srt_time, to_seconds
    result = list(entries)
    for segment in report.segments[:80]:
        start = segment.start
        while start < segment.end:
            end = min(start + 8, segment.end)
            if end - start >= .1:
                result.append({'start_time': to_srt_time(start), 'end_time': to_srt_time(end),
                               'text': '[音频模型歌声候选，非歌词；须试听核实]，保留自然乐句，不编造转写。'})
            start = end
    return sorted(result, key=lambda row: to_seconds(row['start_time']))


def selection_srt(srt_path, metadata_dir):
    """Analysis-only markers live in a subdirectory and never become burned-in subtitles."""
    from backend.utils.text_processor import TextProcessor
    if srt_path and Path(srt_path).name == 'singing-selection.srt' and Path(srt_path).parent.name == 'analysis-only':
        return srt_path
    entries = TextProcessor.parse_srt(Path(srt_path)) if srt_path and Path(srt_path).is_file() else []
    combined = selection_entries(entries)
    if combined is entries or len(combined) == len(entries):
        return srt_path
    output = Path(metadata_dir) / 'analysis-only/singing-selection.srt'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n\n'.join(f"{i}\n{row['start_time']} --> {row['end_time']}\n{row['text']}" for i, row in enumerate(combined, 1)) + '\n', encoding='utf-8')
    return output
