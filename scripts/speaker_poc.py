#!/usr/bin/env python3
"""Offline clip -> anonymous speaker JSON. No server, project writes or paid APIs."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import wave

# Import the contract directly: backend.services.__init__ imports application services.
SERVICES = Path(__file__).resolve().parents[1] / 'backend' / 'services'
sys.path.insert(0, str(SERVICES))
from speaker_subtitles import Cue, Speaker, SpeakerDocument, Turn, associate_cues


def load_cues(path, duration_ms):
    if path.suffix.lower() == '.json':
        data = json.loads(path.read_text(encoding='utf-8-sig'))
        if not isinstance(data, dict) or data.get('schema_version') != 1 or data.get('time_base') != 'clip':
            raise ValueError('JSON needs schema_version=1 and explicit time_base=clip; ASR units are not guessed')
        document = SpeakerDocument.model_validate(data)
        if document.duration_ms != duration_ms:
            raise ValueError('JSON duration does not match extracted clip audio')
        return document.subtitles
    if path.suffix.lower() != '.srt':
        raise ValueError('Use a clip-relative SRT or speaker schema JSON')
    import pysrt
    body = path.read_text(encoding='utf-8-sig')
    rows = pysrt.from_string(body, error_handling=pysrt.ERROR_RAISE)
    cues = [Cue(id=f'cue_{i + 1:04d}', start_ms=row.start.ordinal, end_ms=row.end.ordinal, text=row.text)
            for i, row in enumerate(rows)]
    if not cues:
        raise ValueError('SRT has no subtitle cues')
    SpeakerDocument(duration_ms=duration_ms, subtitles=cues)
    return cues


def stop_process_tree(process):
    import psutil
    try:
        parent = psutil.Process(process.pid)
        children = parent.children(recursive=True)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        children = []
    for child in reversed(children):
        try:
            child.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    # The Popen handle can terminate our own worker even in restricted Windows
    # sessions that deny psutil's process inspection.
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)


def run_monitored(command, *, env, log, timeout):
    """Sample tree RSS; the metric is a sampled peak, not an OS high-water mark."""
    import psutil
    peak, samples = 0, 0
    with log.open('w', encoding='utf-8') as stream:
        process = subprocess.Popen(command, env=env, stdout=stream, stderr=subprocess.STDOUT)
        started = time.monotonic()
        try:
            while process.poll() is None:
                try:
                    parent = psutil.Process(process.pid)
                    rss = sum(p.memory_info().rss for p in [parent, *parent.children(recursive=True)])
                    peak = max(peak, rss)
                    samples += 1
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
                if time.monotonic() - started >= timeout:
                    raise TimeoutError('Local process exceeded the configured timeout')
                time.sleep(.05)
        except BaseException:
            if process.poll() is None:
                stop_process_tree(process)
            raise
    if process.returncode:
        raise RuntimeError(f'Local process failed (exit {process.returncode}); inspect the private run log')
    return {'sampled_peak_tree_rss_mib': round(peak / 1024**2, 2) if samples else None,
            'memory_samples': samples}


def isolated_env(cache):
    env = os.environ.copy()
    for key in list(env):
        if key.endswith(('_API_KEY', '_TOKEN')) or key in {'SENTRY_DSN', 'VITE_PUBLIC_POSTHOG_KEY', 'PYTHONPATH'}:
            env.pop(key)
    env.update(PYTHONDONTWRITEBYTECODE='1', CUDA_VISIBLE_DEVICES='', HF_HOME=str(cache),
               MODELSCOPE_CACHE=str(cache), HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
               MODELSCOPE_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    return env


def probe_clip(video, ffprobe, env):
    result = subprocess.run([str(ffprobe), '-v', 'error', '-show_entries',
                             'format=duration,start_time:stream=codec_type,duration,start_time',
                             '-of', 'json', str(video)], env=env, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError('ffprobe could not read the input clip')
    data = json.loads(result.stdout)
    videos = [s for s in data.get('streams', []) if s.get('codec_type') == 'video']
    if not videos or not any(s.get('codec_type') == 'audio' for s in data.get('streams', [])):
        raise ValueError('Input must contain a video stream and an audio stream')
    info = data.get('format', {})
    duration = float(videos[0].get('duration', info.get('duration', 'nan')))
    start = float(videos[0].get('start_time', info.get('start_time', 'nan')))
    if not math.isfinite(duration) or not 0 < duration <= 600 or not math.isfinite(start):
        raise ValueError('Clip needs finite video duration/start timestamps, at most ten minutes')
    return {'duration_ms': math.floor(duration * 1000), 'video_start_seconds': start}


def extraction_command(ffmpeg, video, audio, media):
    # Preserve input PTS, then anchor audio to the first video PTS. first_pts=0
    # inserts delayed audio's leading silence or trims audio before the video.
    return [str(ffmpeg), '-nostdin', '-v', 'error', '-y', '-copyts', '-i', str(video),
            '-map', '0:a:0', '-vn', '-af',
            f"asetpts=PTS-({media['video_start_seconds']})/TB,aresample=async=1:first_pts=0",
            '-t', str(media['duration_ms'] / 1000), '-ac', '1', '-ar', '16000',
            '-c:a', 'pcm_s16le', str(audio)]


def subtitle_srt(document):
    def timestamp(value):
        return f'{value // 3600000:02}:{value // 60000 % 60:02}:{value // 1000 % 60:02},{value % 1000:03}'
    return '\n'.join(f'{index + 1}\n{timestamp(cue.start_ms)} --> {timestamp(cue.end_ms)}\n{cue.text}\n'
                     for index, cue in enumerate(document.subtitles))


def run(args):
    video = args.video.expanduser().resolve()
    if not video.is_file():
        raise ValueError('Input video does not exist')
    from importlib.util import spec_from_file_location, module_from_spec
    spec = spec_from_file_location('speaker_worker_validation', SERVICES / 'speaker_worker.py')
    worker = module_from_spec(spec)
    spec.loader.exec_module(worker)
    cam, vad = worker.local_model(args.cam_model), worker.local_model(args.vad_model)
    if len(args.initial_prompt) > 500:
        raise ValueError('Transcription prompt is limited to 500 characters')
    from speaker_whisper import local_model as whisper_model
    asr = (whisper_model(args.asr_model) if args.asr_backend == 'whisper' else worker.local_model(args.asr_model)) if args.asr_model else None
    if args.subtitles and asr:
        raise ValueError('Choose existing subtitles OR ASR, to avoid repeating transcription')
    if args.subtitles and not args.subtitles.is_file():
        raise ValueError('Subtitle input does not exist')
    if not math.isfinite(args.threshold) or not 0 < args.threshold < 2 or args.timeout <= 0:
        raise ValueError('Invalid threshold or timeout')
    ffmpeg = args.ffmpeg or shutil.which('ffmpeg')
    ffprobe = args.ffprobe or shutil.which('ffprobe')
    if not ffmpeg or not ffprobe:
        raise ValueError('ffmpeg and ffprobe are required')
    output = args.output_dir.expanduser().resolve()
    # An existing directory is always refused, including existing project outputs.
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    report = {'schema_version': 1, 'status': 'running', 'device': 'cpu', 'speaker_limit': args.speakers,
              'cosine_threshold': args.threshold, 'quality': 'not_evaluated',
              'overlap_separation': False, 'memory_measurement': '50ms process-tree RSS sampling'}
    try:
        with tempfile.TemporaryDirectory(prefix='audio-', dir=output) as temp:
            temp = Path(temp)
            env = isolated_env(temp / 'cache')
            audio, raw = temp / 'audio.wav', temp / 'worker.json'
            media = probe_clip(video, ffprobe, env)
            duration_ms = media['duration_ms']
            report.update(media)
            extract_started = time.monotonic()
            report['extraction_memory'] = run_monitored(
                extraction_command(ffmpeg, video, audio, media),
                env=env, log=output / 'ffmpeg.log', timeout=min(args.timeout, 300))
            report['extraction_seconds'] = round(time.monotonic() - extract_started, 3)
            with wave.open(str(audio), 'rb') as source:
                audio_duration_ms = source.getnframes() * 1000 // source.getframerate()
            if not 0 < audio_duration_ms <= duration_ms:
                raise ValueError('Extracted audio must stay within the video timeline')
            report['audio_duration_ms'] = audio_duration_ms
            cues = load_cues(args.subtitles, duration_ms) if args.subtitles else []
            command = [str(args.python), '-I', str(SERVICES / 'speaker_worker.py'), '--audio', str(audio),
                       '--result', str(raw), '--diagnostics', str(output / 'asr_diagnostics.json'),
                       '--cam-model', str(cam), '--vad-model', str(vad),
                       '--threads', str(args.threads), '--threshold', str(args.threshold), '--language', args.language]
            if args.speakers:
                command += ['--speakers', str(args.speakers)]
            if asr:
                command += ['--asr-model', str(asr), '--asr-backend', args.asr_backend,
                            '--initial-prompt', args.initial_prompt]
            report['inference_memory'] = run_monitored(command, env=env, log=output / 'worker.log', timeout=args.timeout)
            result = json.loads(raw.read_text(encoding='utf-8'))
            if result['duration_ms'] != audio_duration_ms:
                raise ValueError('Worker duration disagrees with extracted audio')
            turns = [Turn.model_validate(t) for t in result['turns']]
            if asr:
                cues = [Cue.model_validate(c) for c in result['subtitles']]
            labels = sorted({t.speaker_id for t in turns}, key=lambda label: int(label[4:]))
            document = SpeakerDocument(duration_ms=duration_ms, speakers=[Speaker(speaker_id=s) for s in labels],
                                       turns=turns, subtitles=associate_cues(cues, turns))
            report.update(result['metrics'], status='completed', speaker_count=len(labels),
                          subtitle_count=len(cues), unknown_cue_count=sum(c.speaker_id is None for c in document.subtitles),
                          transcript_source='existing' if args.subtitles else args.asr_backend if asr else 'none')
            report['warnings'] = ['Anonymous IDs require human identity confirmation; quality is not evaluated.']
            if not cues:
                report['warnings'].append('No subtitle text: output contains speaker turns only.')
            (output / 'speaker_subtitles.json').write_text(document.model_dump_json(indent=2), encoding='utf-8')
            (output / 'subtitles.srt').write_text(subtitle_srt(document), encoding='utf-8')
    except BaseException as error:
        report.update(status='failed', error_type=type(error).__name__)
        raise
    finally:
        report['elapsed_seconds'] = round(time.monotonic() - started, 3)
        (output / 'metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True, help='New, private directory; existing directories are refused')
    parser.add_argument('--cam-model', type=Path, required=True)
    parser.add_argument('--vad-model', type=Path, required=True)
    parser.add_argument('--asr-model', type=Path, help='Optional local SenseVoiceSmall; never uses cloud ASR')
    parser.add_argument('--asr-backend', choices=['sensevoice', 'whisper'], default='sensevoice')
    parser.add_argument('--initial-prompt', default='')
    parser.add_argument('--subtitles', type=Path, help='Existing clip-relative SRT or speaker schema JSON')
    parser.add_argument('--python', type=Path, default=Path(sys.executable), help='Isolated speaker venv interpreter')
    parser.add_argument('--ffmpeg', type=Path)
    parser.add_argument('--ffprobe', type=Path)
    parser.add_argument('--speakers', type=int, choices=range(1, 9), help='Maximum count, not a forced split')
    parser.add_argument('--threads', type=int, choices=range(1, 9), default=4)
    parser.add_argument('--language', choices=['auto', 'zh', 'en', 'ja', 'ko', 'yue'], default='zh')
    parser.add_argument('--threshold', type=float, default=.25)
    parser.add_argument('--timeout', type=int, default=900)
    args = parser.parse_args(argv)
    try:
        output = run(args)
    except (OSError, ValueError, RuntimeError, TimeoutError) as error:
        print(f'POC failed: {error}', file=sys.stderr)
        return 1
    print(f'Output: {output / "speaker_subtitles.json"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
