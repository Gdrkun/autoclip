"""Optional CPU AudioSet classifier. Runs only in an isolated Torch process."""
import argparse
import json
import os
from pathlib import Path
import wave

REPOSITORY = 'MIT/ast-finetuned-audioset-10-10-0.4593'
REVISION = 'f826b80d28226b62986cc218e5cec390b1096902'


def classify_scores(scores, labels):
    singing_names = {'singing', 'male singing', 'female singing', 'child singing', 'humming', 'chant', 'mantra', 'yodeling', 'rapping', 'choir', 'vocal music', 'a capella'}
    singing = max((float(v) for v, label in zip(scores, labels) if label.lower() in singing_names), default=0)
    music = max((float(v) for v, label in zip(scores, labels) if label.lower() == 'music'), default=0)
    speech = max((float(v) for v, label in zip(scores, labels) if label.lower() == 'speech'), default=0)
    return singing, music, speech


def merge_windows(windows, duration):
    ranges = []
    for item in windows:
        strong = item['singing'] >= .5
        voice = item['singing'] >= .3 and item['speech'] <= item['singing'] * 1.5
        musical_voice = item['singing'] >= .2 and item.get('music', 0) >= .35 and item['speech'] <= .25
        if not (strong or voice or musical_voice):
            continue
        # Preserve context around coarse classifier windows rather than slicing a sung phrase.
        start, end = max(0, item['start'] - 1), min(duration, item['end'] + 1)
        if end <= start:
            continue
        if ranges and start - ranges[-1]['end'] <= 4:
            ranges[-1]['end'] = end
            ranges[-1]['score'] = max(ranges[-1]['score'], item['singing'])
        else:
            ranges.append({'start': start, 'end': end, 'score': item['singing']})
    return [{**item, 'start': round(item['start'], 3), 'end': min(duration, round(item['end'], 3)),
             'score': round(item['score'], 4)} for item in ranges if item['end'] - item['start'] >= 6]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'analyze'])
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--audio', type=Path)
    args = parser.parse_args()
    os.environ.update(CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='4', MKL_NUM_THREADS='4')
    if args.action == 'prepare':
        from huggingface_hub import snapshot_download
        snapshot_download(REPOSITORY, revision=REVISION, local_dir=str(args.model),
                          allow_patterns=['config.json', 'preprocessor_config.json', 'model.safetensors'])
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    import torch
    import numpy as np
    from transformers import ASTFeatureExtractor, ASTForAudioClassification
    torch.set_num_threads(4)
    extractor = ASTFeatureExtractor.from_pretrained(str(args.model), local_files_only=True)
    model = ASTForAudioClassification.from_pretrained(str(args.model), local_files_only=True).to('cpu').eval()
    if args.action == 'prepare':
        result = {'status': 'ready', 'model': REPOSITORY}
    else:
        windows = []
        with wave.open(str(args.audio), 'rb') as audio:
            assert audio.getframerate() == 16000 and audio.getnchannels() == 1 and audio.getsampwidth() == 2
            duration = audio.getnframes() / 16000
            if not 1 <= duration <= 7200:
                raise ValueError('歌声检测支持 1 秒至 2 小时的视频')
            for offset in range(0, max(1, int(duration) - 4), 5):
                audio.setpos(offset * 16000)
                samples = np.frombuffer(audio.readframes(160000), dtype='<i2').astype(np.float32) / 32768
                if not len(samples):
                    break
                if np.sqrt(np.mean(samples ** 2)) < .002:
                    continue
                inputs = extractor(samples, sampling_rate=16000, return_tensors='pt')
                with torch.inference_mode():
                    scores = model(**inputs).logits[0].sigmoid().tolist()
                singing, music, speech = classify_scores(scores, [model.config.id2label[i] for i in range(len(scores))])
                windows.append({'start': offset, 'end': min(duration, offset + 10),
                                'singing': singing, 'music': music, 'speech': speech})
        result = {'status': 'completed', 'model': REPOSITORY, 'device': 'cpu', 'duration': duration,
                  'quality': 'candidate_requires_review', 'segments': merge_windows(windows, duration), 'windows': windows}
    args.result.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf-8')


if __name__ == '__main__':
    main()
