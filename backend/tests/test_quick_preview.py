"""Candidate-first lifecycle and bounded selected-range processing without remote providers."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.services import long_audio, speaker_autoflow, speaker_integration
from backend.services.studio import jobs, quick_preview, store
from backend.services.studio.models import ImportOptions
from backend.services.speaker_subtitles import Cue, SpeakerDocument, Speaker, Turn
from backend.tests.test_studio import root  # noqa: F401


def test_quick_preview_flag_is_opt_in_and_context_does_not_leak():
    assert not ImportOptions().quick_preview and 'quick_preview' not in ImportOptions().model_dump()
    assert ImportOptions(quick_preview=True).model_dump()['quick_preview'] is True
    assert not quick_preview.screening()
    with quick_preview.context():
        assert speaker_autoflow.ensure('unused', Path('unused.mp4')) is None
    assert not quick_preview.screening()


def test_selected_chunks_do_not_decode_unselected_hour_and_keep_overlap():
    parts = long_audio.range_chunks(3600000, [[120000, 150000], [140000, 165000], [1000000, 1250000]])
    assert [(part['owned_start_ms'], part['owned_end_ms']) for part in parts] == [(120000, 165000), (1000000, 1180000), (1180000, 1250000)]
    assert sum(part['end_ms'] - part['start_ms'] for part in parts) < 320000
    with pytest.raises(ValueError): long_audio.range_chunks(3600000, [[0, 3600001]])


def test_candidate_pass_only_persists_unrendered_choices(root, monkeypatch):
    from backend.services.studio.models import Draft, Scene
    state = store.read('p1')
    state.update(plan={'source_duration': 3600}, generation={'quick_preview': True, 'auto_start': True, 'requested_platforms': ['original'], 'branding': {'outro_enabled': False}},
                 analysis={'status': 'running', 'phase': 'production', 'run_id': 'preview', 'instance': store.INSTANCE})
    store.write('p1', state)
    draft = Draft(id='candidate', title='候选', scenes=[Scene(id='s', start=100, end=130)]).model_dump()
    observed = []
    monkeypatch.setattr(jobs, 'source', lambda _: root / 'source.mp4')
    monkeypatch.setattr(jobs, '_content_drafts', lambda *a: observed.append(quick_preview.screening()) or [draft])
    monkeypatch.setattr(quick_preview, 'caption_document', lambda *a: None)
    monkeypatch.setattr(jobs, 'mark_project', lambda *a, **k: None)
    for name in ['_source_has_burned_subtitles', '_apply_framing', '_prefetch_packaging', '_posts_for', '_dispatch_pending_variants']:
        monkeypatch.setattr(jobs, name, lambda *a, **k: pytest.fail('Expensive work must wait for a selection'))
    jobs._auto_generate('p1', {})
    result = store.read('p1')
    assert observed == [True] and not quick_preview.screening()
    assert result['generation']['status'] == 'awaiting_selection'
    assert result['analysis']['status'] == 'completed'
    assert result['output_variants'][0]['status'] == 'on_demand'
    assert not result['jobs']


def test_selected_speaker_preparation_retains_manual_text_and_only_selected_times(root, monkeypatch):
    from backend.services import ai_model_settings, long_speaker
    video = root / 'source.mp4'; video.write_bytes(b'isolated fixture')
    current = SpeakerDocument(duration_ms=3600000, subtitles=[Cue(id='manual', start_ms=120000, end_ms=124000,
        text='人工改好的台词', assignment_reason='unassigned')])
    inferred = current.model_copy(update={'speakers': [Speaker(speaker_id='spk_0')],
        'turns': [Turn(start_ms=119000, end_ms=126000, speaker_id='spk_0')]})
    monkeypatch.setattr(ai_model_settings, 'load', lambda: SimpleNamespace(transcription=SimpleNamespace(speaker_diarization=True, provider='sensevoice_local', initial_prompt='')))
    monkeypatch.setattr(speaker_integration, 'status', lambda: {'ready': True})
    monkeypatch.setattr('backend.pipeline.media_precheck.has_audio', lambda _: True)
    calls = []
    def execute(*args, **kwargs):
        calls.append(kwargs['ranges'])
        assert '人工改好的台词' in Path(args[4]).read_text(encoding='utf-8')
        return inferred, root
    monkeypatch.setattr(long_speaker, 'execute', execute)
    result = quick_preview.prepare_selected('p1', video, {'scenes': [{'start': 120, 'end': 130}], 'speaker_subtitles': current.model_dump()})
    assert calls == [[[120000, 130000]]]
    assert result['subtitles'][0]['text'] == '人工改好的台词'
    assert result['subtitles'][0]['start_ms'] == 120000
    assert result['subtitles'][0]['speaker_id'] == 'spk_0'
    assert not speaker_integration.sidecar('p1').exists()
    current.subtitles[0].assignment_reason = 'manual'
    preserved = quick_preview.prepare_selected('p1', video, {'scenes': [{'start': 120, 'end': 130}], 'speaker_subtitles': current.model_dump()})
    assert preserved['subtitles'][0]['speaker_id'] is None


def test_selected_speaker_ids_reuse_anchors_instead_of_renumbering_each_clip(root):
    assert quick_preview._labels('p1', 'version', [[1., 0.], [0., 1.]]) == ['spk_0', 'spk_1']
    assert quick_preview._labels('p1', 'version', [[0., 1.], [1., 0.]]) == ['spk_1', 'spk_0']
    assert quick_preview._labels('p1', 'changed', [[0., 1.]]) == ['spk_0']


def test_quick_screening_skips_visual_extra_review_without_changing_saved_report(root, monkeypatch):
    from backend.services import visual_reactions
    target = visual_reactions.report_path('p1'); target.parent.mkdir(exist_ok=True); target.write_text('{"preserved":true}', encoding='utf-8')
    monkeypatch.setattr(visual_reactions.intelligence, 'vision_call', lambda *a: pytest.fail('No visual review while screening'))
    with quick_preview.context(): assert visual_reactions.analyze('p1', root / 'unused.mp4') is None
    assert target.read_text(encoding='utf-8') == '{"preserved":true}'


def test_missing_subtitles_use_plain_asr_session_without_cam_or_global_sidecar(root, monkeypatch):
    from backend.services import speaker_process
    video = root / 'source.mp4'; video.write_bytes(b'isolated')
    runtime = root / 'runtime'
    for name in ['venv/Scripts/python.exe', 'venv/bin/python', 'models/sensevoice/model.pt', 'models/fsmn-vad/model.pt']:
        file = runtime / name; file.parent.mkdir(parents=True, exist_ok=True); file.touch()
    monkeypatch.setattr(speaker_integration, 'runtime_root', lambda: runtime)
    monkeypatch.setattr(long_audio, 'probe', lambda _: {'duration_ms': 3600000})
    commands, parts = [], []
    class Session:
        def __init__(self, command, **kwargs): commands.append(command)
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def infer(self, audio, result):
            import json
            part = json.loads(audio.read_text())
            parts.append(part)
            return {'duration_ms': part['end_ms'] - part['start_ms'], 'subtitles': [
                {'id': 'x', 'start_ms': 5000, 'end_ms': 6000, 'text': '基础台词'}]}
    monkeypatch.setattr(speaker_process, 'SpeakerProcess', Session)
    monkeypatch.setattr(long_audio, 'extract', lambda video, target, part, media: target.write_text(__import__('json').dumps(part)))
    output = root / 'source.srt'
    quick_preview.transcribe_plain(video, output, SimpleNamespace(provider='sensevoice_local', initial_prompt=''))
    assert '--asr-only' in commands[0] and '--cam-model' not in commands[0]
    assert len(commands) == 1 and len(parts) == 20
    assert output.is_file() and '基础台词' in output.read_text(encoding='utf-8')
    assert not speaker_integration.sidecar('p1').exists()


@pytest.mark.parametrize('concurrent_edit', [False, True])
def test_selected_generation_uses_local_captions_and_preserves_newer_draft(root, monkeypatch, concurrent_edit):
    from backend.services.studio.models import Draft, Scene
    from backend.services import visual_reactions
    draft = store.save_draft('p1', Draft(id='selected', title='候选原标题', scenes=[Scene(id='s', start=120, end=130)]), create=True)
    state = store.read('p1')
    state.update(generation={'quick_preview': True, 'auto_start': True, 'status': 'rendering'},
        output_variants=[{'id': 'v', 'draft_id': 'selected', 'status': 'preparing', 'instance': store.INSTANCE, 'strategy_id': 'original'}])
    store.write('p1', state)
    observed = []
    def selected(*args):
        observed.append('selected')
        if concurrent_edit:
            store.save_draft('p1', Draft.model_validate({**draft, 'title': '刚保存的新修改'}))
        return None
    monkeypatch.setattr(quick_preview, 'prepare_selected', selected)
    monkeypatch.setattr(jobs, 'source', lambda _: root / 'fixture.mp4')
    monkeypatch.setattr(jobs, '_prepare_speaker_captions', lambda *args: pytest.fail('Must not analyze full video'))
    monkeypatch.setattr(visual_reactions, 'analyze', lambda *args, **kwargs: observed.append(kwargs['ranges']))
    monkeypatch.setattr(jobs, '_source_has_burned_subtitles', lambda *args: False)
    monkeypatch.setattr(jobs, '_apply_framing', lambda pid, value, *args: (value, None))
    monkeypatch.setattr(jobs, '_apply_packaging', lambda pid, value, *args: value)
    monkeypatch.setattr(jobs, '_posts_for', lambda *args: {})
    monkeypatch.setattr(jobs, '_audience_title', lambda value, *args: value)
    monkeypatch.setattr(jobs, '_apply_strategy', lambda value, *args, **kwargs: Draft.model_validate(value))
    monkeypatch.setattr(jobs, 'capture_studio_exception', lambda *args, **kwargs: None)
    monkeypatch.setattr(jobs, 'sync_project_completion', lambda *args: None)
    monkeypatch.setattr(jobs, '_dispatch_pending_variants', lambda *args: observed.append('dispatch'))
    jobs._produce_on_demand('p1', 'v')
    result = store.read('p1')
    assert observed[:2] == ['selected', [(120., 130.)]]
    if concurrent_edit:
        assert result['drafts'][0]['title'] == '刚保存的新修改'
        assert result['output_variants'][0]['status'] == 'failed' and 'dispatch' not in observed
    else:
        assert result['output_variants'][0]['status'] == 'queued' and observed[-1] == 'dispatch'


def test_extra_visual_review_only_samples_selected_ranges(root, monkeypatch):
    from backend.services import visual_reactions, reaction_scan
    video = root / 'fixture.mp4'; video.write_bytes(b'isolated')
    monkeypatch.setattr(visual_reactions, 'options', lambda _: {'visual_reactions': True, 'reaction_budget': 4})
    monkeypatch.setattr(visual_reactions.intelligence, 'source_frame_analysis_allowed', lambda: True)
    monkeypatch.setattr(visual_reactions.intelligence, '_probe', lambda _: {'duration': 3600})
    monkeypatch.setattr('backend.services.studio.vision_settings.effective', lambda: {'model': 'local-fixture'})
    monkeypatch.setattr(reaction_scan, 'scan', lambda *args, **kwargs: pytest.fail('No whole-video decode'))
    windows = []
    def request(video, window, *args):
        windows.append(window)
        return {'raw': {'events': []}, 'actual_times': window['times']}
    monkeypatch.setattr(visual_reactions, '_request', request)
    report = visual_reactions.analyze('p1', video, ranges=[(120, 150), (900, 910)])
    assert report.status == 'completed' and windows
    assert all(any(left <= window['start'] < window['end'] <= right for left, right in [(120, 150), (900, 910)]) for window in windows)


def test_silent_candidate_does_not_require_speaker_runtime(root, monkeypatch):
    from backend.services import ai_model_settings
    monkeypatch.setattr(ai_model_settings, 'load', lambda: SimpleNamespace(transcription=SimpleNamespace(speaker_diarization=True)))
    monkeypatch.setattr('backend.pipeline.media_precheck.has_audio', lambda _: False)
    monkeypatch.setattr(speaker_integration, 'status', lambda: pytest.fail('Silent scenes need no speaker model'))
    assert quick_preview.prepare_selected('p1', root / 'silent.mp4', {'scenes': [{'start': 0, 'end': 30}]}) is None
