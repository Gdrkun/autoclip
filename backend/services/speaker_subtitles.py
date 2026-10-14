"""Local speaker POC contracts. No models, app configuration or database imports."""
from __future__ import annotations

import heapq
import math
from collections import defaultdict

from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Literal


class SpeakerCaptionLayout(BaseModel):
    model_config = ConfigDict(extra='forbid')
    font_scale: float = Field(default=1, ge=.5, le=2.5, allow_inf_nan=False)
    x: float = Field(default=.5, ge=.05, le=.95, allow_inf_nan=False)
    y: float = Field(default=.91, ge=.15, le=.95, allow_inf_nan=False)


class Speaker(BaseModel):
    model_config = ConfigDict(extra='forbid')
    speaker_id: str = Field(pattern=r'^spk_[0-9]+$')
    display_name: str = Field(default='', max_length=40)
    color: str = Field(default='#FFFFFF', pattern=r'^#[0-9a-fA-F]{6}$')


class Cue(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=100)
    start_ms: int = Field(strict=True, ge=0)
    end_ms: int = Field(strict=True, gt=0)
    text: str = Field(min_length=1, max_length=2000)
    speaker_id: str | None = Field(default=None, pattern=r'^spk_[0-9]+$')
    layer: int = Field(default=0, strict=True, ge=0, le=1)
    assignment_reason: Literal['unassigned', 'matched', 'no_speech', 'insufficient_coverage', 'ambiguous', 'manual'] = 'unassigned'

    @model_validator(mode='after')
    def interval(self):
        if self.end_ms <= self.start_ms or not self.text.strip():
            raise ValueError('Subtitle needs text and start_ms < end_ms')
        return self


class Turn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    start_ms: int = Field(strict=True, ge=0)
    end_ms: int = Field(strict=True, gt=0)
    speaker_id: str = Field(pattern=r'^spk_[0-9]+$')

    @model_validator(mode='after')
    def interval(self):
        if self.end_ms <= self.start_ms:
            raise ValueError('Turn needs start_ms < end_ms')
        return self


class SpeakerDocument(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: Literal[1] = 1
    time_base: Literal['clip'] = 'clip'
    duration_ms: int = Field(strict=True, gt=0)
    speakers: list[Speaker] = Field(default_factory=list, max_length=100)
    subtitles: list[Cue] = Field(default_factory=list, max_length=10000)
    turns: list[Turn] = Field(default_factory=list, max_length=10000)

    @model_validator(mode='after')
    def references(self):
        speaker_ids = [s.speaker_id for s in self.speakers]
        cue_ids = [c.id for c in self.subtitles]
        if len(set(speaker_ids)) != len(speaker_ids) or len(set(cue_ids)) != len(cue_ids):
            raise ValueError('Speaker and cue IDs must be unique')
        for item in [*self.subtitles, *self.turns]:
            if item.end_ms > self.duration_ms:
                raise ValueError('Timestamp exceeds clip duration')
            if item.speaker_id is not None and item.speaker_id not in speaker_ids:
                raise ValueError('Unknown speaker reference')
        return self


def vad_intervals(result, duration_ms):
    """FunASR FSMN value is milliseconds; never guess units from magnitudes."""
    if not isinstance(result, list) or not result:
        raise ValueError('FSMN-VAD returned no result object')
    ranges = []
    for item in result:
        if not isinstance(item, dict) or not isinstance(item.get('value'), list):
            raise ValueError('FSMN-VAD must return a value list')
        for pair in item['value']:
            if (not isinstance(pair, (list, tuple)) or len(pair) != 2
                    or not all(isinstance(t, (int, float)) and not isinstance(t, bool)
                               and math.isfinite(t) and int(t) == t for t in pair)):
                raise ValueError('Invalid FSMN-VAD millisecond interval')
            start, end = map(int, pair)
            if not 0 <= start < end <= duration_ms + 100:
                raise ValueError('FSMN-VAD interval outside audio')
            end = min(end, duration_ms)  # tolerate final VAD frame rounding only
            if start < end:
                ranges.append((start, end))
    merged = []
    for start, end in sorted(ranges):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def embedding_windows(ranges, window_ms=3000, hop_ms=1500, minimum_ms=600):
    """Window context may overlap, but each window owns a disjoint turn interval."""
    if not 0 < minimum_ms <= hop_ms <= window_ms:
        raise ValueError('Invalid embedding window configuration')
    windows = []
    for start, end in ranges:
        if end - start < minimum_ms:
            continue
        starts = [start]
        while starts[-1] + window_ms < end:
            following = min(starts[-1] + hop_ms, end - window_ms)
            if following <= starts[-1]:
                break
            starts.append(following)
        ends = [min(s + window_ms, end) for s in starts]
        centres = [(s + e) // 2 for s, e in zip(starts, ends)]
        boundaries = [start, *[(a + b) // 2 for a, b in zip(centres, centres[1:])], end]
        windows.extend({'start_ms': s, 'end_ms': e, 'owned_start_ms': boundaries[i],
                        'owned_end_ms': boundaries[i + 1]} for i, (s, e) in enumerate(zip(starts, ends)))
    return windows


def cluster_embeddings(embeddings, *, max_speakers=None, threshold=.25):
    """Average-link cosine clustering. Count is a cap, not a forced split.

    The threshold is a heuristic; it is deliberately not exported as confidence.
    IDs are ordered by first occurrence and have no cross-video identity.
    """
    if max_speakers is not None and (type(max_speakers) is not int or not 1 <= max_speakers <= 8):
        raise ValueError('max_speakers must be between 1 and 8')
    if not math.isfinite(threshold) or not 0 < threshold < 2:
        raise ValueError('Invalid cosine threshold')
    if len(embeddings) > 400:
        raise ValueError('POC supports at most 400 embedding windows')
    vectors = []
    for values in embeddings:
        if not values or not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                                 and math.isfinite(v) for v in values):
            raise ValueError('Invalid CAM++ embedding')
        norm = math.sqrt(sum(v * v for v in values))
        if not math.isfinite(norm) or norm <= 1e-12:
            raise ValueError('Empty CAM++ embedding')
        if vectors and len(values) != len(vectors[0]):
            raise ValueError('CAM++ embedding dimensions disagree')
        vectors.append([v / norm for v in values])
    groups = {i: [i] for i in range(len(vectors))}
    distances, pending = {}, []
    for i, left in enumerate(vectors):
        for j in range(i + 1, len(vectors)):
            distance = max(0.0, min(2.0, 1 - sum(a * b for a, b in zip(left, vectors[j]))))
            distances[i, j] = distance
            heapq.heappush(pending, (distance, i, j))
    serial = len(vectors)
    while pending:
        distance, a, b = heapq.heappop(pending)
        if a not in groups or b not in groups:
            continue
        if distance > threshold and (max_speakers is None or len(groups) <= max_speakers):
            break
        left, right = groups.pop(a), groups.pop(b)
        for other in groups:
            da = distances[min(a, other), max(a, other)]
            db = distances[min(b, other), max(b, other)]
            merged = (da * len(left) + db * len(right)) / (len(left) + len(right))
            distances[other, serial] = merged
            heapq.heappush(pending, (merged, other, serial))
        groups[serial] = left + right
        serial += 1
    labels = [None] * len(vectors)
    for label, group in enumerate(sorted(groups.values(), key=min)):
        for index in group:
            labels[index] = f'spk_{label}'
    return labels


def windows_to_turns(windows, labels):
    if len(windows) != len(labels):
        raise ValueError('Window and embedding counts disagree')
    turns = []
    for window, speaker_id in zip(windows, labels):
        turn = Turn(start_ms=window['owned_start_ms'], end_ms=window['owned_end_ms'], speaker_id=speaker_id)
        if turns and turns[-1].end_ms == turn.start_ms and turns[-1].speaker_id == speaker_id:
            turns[-1] = turns[-1].model_copy(update={'end_ms': turn.end_ms})
        else:
            turns.append(turn)
    return turns


def associate_cues(cues, turns, *, minimum_coverage=.55, minimum_margin=.20):
    """Use unambiguous time coverage; mixed/short/uncovered cues stay unknown.

    Repeated/overlapping windows cannot multiply coverage. Conflicting turns
    cannot assign the same time twice. Existing text, times, IDs and layers stay.
    """
    if not 0 < minimum_coverage <= 1 or not 0 <= minimum_margin <= 1:
        raise ValueError('Invalid assignment thresholds')
    assigned = []
    for cue in cues:
        related = [t for t in turns if t.start_ms < cue.end_ms and t.end_ms > cue.start_ms]
        bounds = sorted({cue.start_ms, cue.end_ms, *[max(cue.start_ms, t.start_ms) for t in related],
                         *[min(cue.end_ms, t.end_ms) for t in related]})
        coverage = defaultdict(int)
        conflicting = 0
        for start, end in zip(bounds, bounds[1:]):
            active = {t.speaker_id for t in related if t.start_ms < end and t.end_ms > start}
            if len(active) == 1:
                coverage[active.pop()] += end - start
            elif len(active) > 1:
                conflicting += end - start
        ranked = sorted(coverage.items(), key=lambda item: (-item[1], item[0]))
        duration = cue.end_ms - cue.start_ms
        speaker_id, reason = None, 'no_speech'
        if ranked:
            winner, first = ranked[0]
            second = ranked[1][1] if len(ranked) > 1 else 0
            if conflicting or (first - second) / duration < minimum_margin:
                reason = 'ambiguous'
            elif first / duration < minimum_coverage:
                reason = 'insufficient_coverage'
            else:
                speaker_id, reason = winner, 'matched'
        elif related:
            reason = 'ambiguous'
        assigned.append(cue.model_copy(update={'speaker_id': speaker_id, 'assignment_reason': reason}))
    return assigned


def attach_punctuation(cues):
    """Attach punctuation-only ASR rows without inventing a spoken interval.

    CTC sometimes anchors a sentence's final punctuation seconds after the last
    word. Keep its text with that sentence, using only the real word's bounds.
    Do not merge lexical rows: a one-character Chinese utterance can be real.
    """
    output, leading = [], ''
    for cue in cues:
        if any(character.isalnum() for character in cue.text):
            output.append(cue.model_copy(update={'text': leading + cue.text}))
            leading = ''
        elif output:
            previous = output[-1]
            output[-1] = previous.model_copy(update={'text': previous.text + cue.text})
        else:
            leading += cue.text
    return output
