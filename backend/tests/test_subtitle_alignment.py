"""Alignment proposals keep corrected words and never overwrite a draft or source subtitle."""
import pytest
from pydantic import ValidationError

from backend.services import subtitle_repair as repair
from backend.services.speaker_subtitles import Cue
from backend.tests.test_subtitle_repair import prepared  # noqa: F401
from backend.tests.test_studio import root  # noqa: F401


def request(prepared):
    return repair.Request(**{**prepared.request.model_dump(), 'backend': 'whisper', 'operation': 'align',
        'alignment_cues': [dict(id='corrected', start_ms=20000, end_ms=24000, text='我已校正的台词', layer=1, speaker_id='spk_1', assignment_reason='manual')]})


def test_align_offsets_proposals_and_retains_exact_text_speaker_layer_and_id(prepared, monkeypatch):
    monkeypatch.setattr(repair, '_infer', lambda *a: {'subtitles': [dict(id='corrected', start_ms=400, end_ms=3100, text='我已校正的台词')]})
    job = repair.start('p1', request(prepared)); prepared.queue.run()
    result = repair.state('p1', job['job_id'])
    assert result['status'] == 'completed' and result['operation'] == 'align'
    cue = result['subtitles'][0]
    assert (cue['id'], cue['text'], cue['speaker_id'], cue['layer']) == ('corrected', '我已校正的台词', 'spk_1', 1)
    assert (cue['start_ms'], cue['end_ms']) == (20400, 23100)


def test_align_rejects_changed_text_and_keeps_original_data(prepared, monkeypatch):
    monkeypatch.setattr(repair, '_infer', lambda *a: {'subtitles': [dict(id='corrected', start_ms=400, end_ms=3100, text='被替换的文字')]})
    job = repair.start('p1', request(prepared)); prepared.queue.run()
    result = repair.state('p1', job['job_id'])
    assert result['status'] == 'failed' and result['subtitles'] == []


def test_alignment_requires_short_complete_nonoverlapping_speech(prepared):
    valid = request(prepared).model_dump()
    for patch in [{'backend': 'sensevoice'}, {'alignment_cues': []}, {'end': 55},
                  {'alignment_cues': [dict(id='outside', start_ms=19000, end_ms=21000, text='越界')]},
                  {'alignment_cues': [dict(id='one', start_ms=20000, end_ms=23000, text='第一句'), dict(id='two', start_ms=22000, end_ms=24000, text='重叠')]}]:
        with pytest.raises(ValidationError): repair.Request.model_validate({**valid, **patch})


def test_normal_transcription_contract_remains_compatible(prepared):
    assert 'operation' not in prepared.request.model_dump()
    assert 'alignment_cues' not in prepared.request.model_dump()
