"""Standalone local CAM++ worker. Never import the application or read .env."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import socket
import sys
import time
import wave

# -I excludes the script directory from sys.path. Add only these local adapters.
sys.path.insert(0, str(Path(__file__).resolve().parent))

ASR_SEGMENT_MS = 6000


def deny_network():
    def denied(*args, **kwargs):
        raise RuntimeError('Speaker inference is offline; prepare local models separately')
    socket.socket.connect = denied
    socket.socket.connect_ex = denied
    socket.create_connection = denied
    socket.getaddrinfo = denied


def local_model(path):
    path = path.expanduser().resolve()
    if not path.is_dir() or not (path / 'config.yaml').is_file():
        raise ValueError('Model directory must contain config.yaml')
    checkpoint = 'model.pt'
    metadata = path / 'configuration.json'
    if metadata.is_file():
        config = json.loads(metadata.read_text(encoding='utf-8'))
        files = config.get('file_path_metas', {}) if isinstance(config, dict) else None
        if not isinstance(files, dict):
            raise ValueError('Invalid model file_path_metas')
        checkpoint = files.get('init_param', checkpoint)
    if not isinstance(checkpoint, str):
        raise ValueError('Invalid local model checkpoint name')
    weights = (path / checkpoint).resolve()
    if not weights.is_relative_to(path) or not weights.is_file():
        raise ValueError('Model checkpoint must exist inside its local directory')
    return path


def embedding_values(result):
    if not isinstance(result, list) or len(result) != 1 or 'spk_embedding' not in result[0]:
        raise ValueError('CAM++ must return one spk_embedding per window')
    value = result[0]['spk_embedding']
    if hasattr(value, 'detach'):
        value = value.detach().cpu().tolist()
    elif hasattr(value, 'tolist'):
        value = value.tolist()
    while isinstance(value, list) and len(value) == 1 and isinstance(value[0], list):
        value = value[0]
    if not isinstance(value, list) or not value or any(isinstance(v, (list, dict)) for v in value):
        raise ValueError('CAM++ returned an unsupported embedding shape')
    return value


def infer(args):
    # Resolve only explicit directories; model aliases would trigger downloads.
    cam, vad = local_model(args.cam_model), local_model(args.vad_model)
    from speaker_whisper import local_model as whisper_model
    asr = (whisper_model(args.asr_model) if args.asr_backend == 'whisper' else local_model(args.asr_model)) if args.asr_model else None
    os.environ.update(CUDA_VISIBLE_DEVICES='', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      MODELSCOPE_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                      OMP_NUM_THREADS=str(args.threads), MKL_NUM_THREADS=str(args.threads),
                      NUMBA_NUM_THREADS=str(args.threads))
    deny_network()
    from speaker_subtitles import (Cue, cluster_embeddings, embedding_windows,
                                   vad_intervals, windows_to_turns, attach_punctuation)
    import numpy as np
    import torch
    from funasr import AutoModel

    torch.set_num_threads(args.threads)
    with wave.open(str(args.audio), 'rb') as source:
        if (source.getnchannels(), source.getframerate(), source.getsampwidth()) != (1, 16000, 2):
            raise ValueError('Worker audio must be mono 16kHz PCM16')
        duration_ms = source.getnframes() * 1000 // 16000
        if not 0 < duration_ms <= 600000:
            raise ValueError('Phase 1 supports clips up to ten minutes')
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype='<i2').astype(np.float32) / 32768
    options = dict(device='cpu', ncpu=args.threads, disable_update=True,
                   disable_pbar=True, trust_remote_code=False, log_level='ERROR')
    started = time.monotonic()
    with torch.inference_mode():
        vad_engine = AutoModel(model=str(vad), **options)
        ranges = vad_intervals(vad_engine.generate(input=samples, cache={}, disable_pbar=True), duration_ms)
        windows = embedding_windows(ranges)
        if len(windows) > 400:
            raise ValueError('Too many windows for Phase 1; use a shorter clip')
        embeddings = []
        if windows:
            cam_engine = AutoModel(model=str(cam), **options)
            for window in windows:
                audio = samples[window['start_ms'] * 16:window['end_ms'] * 16]
                embeddings.append(embedding_values(cam_engine.generate(input=audio, disable_pbar=True)))
            del cam_engine
        labels = cluster_embeddings(embeddings, max_speakers=args.speakers, threshold=args.threshold)
        turns = windows_to_turns(windows, labels)
        cues, raw = [], None
        diagnostics = {'schema_version': 1, 'time_base': 'clip', 'duration_ms': duration_ms,
                       'speaker_vad_intervals_ms': ranges, 'asr_segment_limit_ms': ASR_SEGMENT_MS,
                       'asr_raw': None}
        if asr and ranges and args.asr_backend == 'whisper':
            from speaker_whisper import transcribe
            cues, raw = transcribe(samples, asr, duration_ms, args.language, args.threads, args.initial_prompt, turns)
            diagnostics['asr_raw'] = raw
        elif asr and ranges:
            from sensevoice_alignment import aligned_cues
            # Bound mixed speech/music decoding separately from CAM++ windows.
            engine = AutoModel(model=str(asr), vad_model=str(vad),
                               vad_kwargs={'max_single_segment_time': ASR_SEGMENT_MS}, **options)
            raw = engine.generate(input=str(args.audio), cache={}, language=args.language,
                                  use_itn=True, output_timestamp=True, batch_size_s=30,
                                  merge_vad=False, disable_pbar=True)
            diagnostics['asr_raw'] = raw
            if args.diagnostics:
                args.diagnostics.write_text(json.dumps(diagnostics, ensure_ascii=False, allow_nan=False), encoding='utf-8')
            # Reuse the existing strict CTC adapter; no proportional timestamps.
            aligned = aligned_cues(raw, duration_ms)
            cues = [Cue(id=f'cue_{i + 1:04d}', start_ms=round(c['start'] * 1000),
                        end_ms=round(c['end'] * 1000), text=c['text'])
                    for i, c in enumerate(aligned)]
        original_cue_count = len(cues)
        cues = attach_punctuation(cues)
        if args.diagnostics:
            args.diagnostics.write_text(json.dumps(diagnostics, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    result = {'duration_ms': duration_ms, 'turns': [t.model_dump() for t in turns],
              'subtitles': [c.model_dump() for c in cues],
              'metrics': {'device': 'cpu', 'threads': args.threads, 'window_count': len(windows),
                          'asr_backend': args.asr_backend if asr else None,
                          'asr_segment_limit_ms': ASR_SEGMENT_MS if asr and args.asr_backend == 'sensevoice' else None,
                          'punctuation_only_cues_attached': original_cue_count - len(cues),
                          'inference_seconds': round(time.monotonic() - started, 3),
                          'versions': {name: importlib.metadata.version(name)
                                       for name in ('funasr', 'torch', 'torchaudio', 'numpy')}}}
    if getattr(args, 'include_embeddings', False):
        result.update(windows=windows, embeddings=embeddings)
    args.result.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--diagnostics', type=Path, help='Private raw ASR and VAD diagnostics')
    parser.add_argument('--cam-model', type=Path, required=True)
    parser.add_argument('--vad-model', type=Path, required=True)
    parser.add_argument('--asr-model', type=Path)
    parser.add_argument('--asr-backend', choices=['sensevoice', 'whisper'], default='sensevoice')
    parser.add_argument('--initial-prompt', default='')
    parser.add_argument('--language', choices=['auto', 'zh', 'en', 'ja', 'ko', 'yue'], default='zh')
    parser.add_argument('--threads', type=int, choices=range(1, 9), default=4)
    parser.add_argument('--speakers', type=int, choices=range(1, 9))
    parser.add_argument('--threshold', type=float, default=.25)
    parser.add_argument('--include-embeddings', action='store_true')
    infer(parser.parse_args())


if __name__ == '__main__':
    main()
