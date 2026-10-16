"""Speaker captions replace burned captions without overriding a user's OFF choice."""
import copy
import json
import subprocess

import pytest

from backend.services import speaker_integration
from backend.services.studio import jobs, render, store
from backend.services.studio.models import Draft, Scene
from backend.tests.test_speaker_integration import document, project  # noqa: F401


def draft(**kwargs):
    return Draft(id='d1', title='Saved captions', scenes=[Scene(id='s1', start=0, end=2)],
                 origin='auto-content', speaker_subtitles=document(), **kwargs)


def generation():
    # The affected real project has a band but no language classification.
    return {'status': 'completed', 'source_has_burned_subtitles': True,
            'burned_caption_band': [.65, .98]}


def seed(project, value, **kwargs):
    path = project / 'metadata/studio.json'
    path.parent.mkdir(exist_ok=True)
    state = {'schema_version': 2, 'drafts': [value], 'events': [], 'analysis': None,
             'generation': generation(), 'output_variants': [], 'jobs': [
                 {'job_id': 'old', 'draft_id': 'd1', 'revision': value['revision'], 'status': 'completed',
                  'snapshot': copy.deepcopy(value)}], **kwargs}
    path.write_text(json.dumps(state), encoding='utf-8')
    return path, state


@pytest.mark.parametrize('platform', ['douyin', 'bilibili', 'original'])
def test_platform_rule_keeps_existing_speaker_captions_enabled(platform):
    original = draft().model_dump()
    result = jobs._apply_strategy(original, platform, burned_subtitles=True)
    assert result.subtitles is True
    assert result.speaker_subtitles == document()
    assert original['subtitles'] is True


def test_platform_rule_preserves_explicit_off():
    result = jobs._apply_strategy(draft(subtitles=False, revision=3).model_dump(), 'douyin', burned_subtitles=True)
    assert result.subtitles is False
    assert not result.model_dump().get('subtitles_auto_suppressed')


def test_only_automatic_suppression_is_marked_and_can_be_restored(project):
    speaker_integration.atomic_json(speaker_integration.sidecar('speaker-test'), document().model_dump())
    plain = Draft(id='d1', title='Pending voices', origin='auto-content', scenes=[Scene(id='s', start=0, end=2)])
    suppressed = jobs._apply_strategy(plain.model_dump(), 'douyin', burned_subtitles=True)
    assert suppressed.model_dump().get('subtitles_auto_suppressed') is True
    # The sidecar may arrive after the platform defaults were selected.
    store.write('speaker-test', {'drafts': [suppressed.model_dump()], 'jobs': [], 'events': [],
                                'analysis': None, 'generation': generation(), 'output_variants': []})
    saved = store.read('speaker-test')['drafts'][0]
    assert saved['subtitles'] is True
    assert saved['speaker_subtitles'] == document().model_dump()
    assert saved['caption_mask'] == [.65, .98]


def test_generation_reuses_corrected_document_before_packaging(project, monkeypatch):
    corrected = document()
    corrected.speakers[0].display_name = 'Confirmed name'
    corrected.subtitles[0].text = 'Corrected words'
    speaker_integration.atomic_json(speaker_integration.sidecar('speaker-test'), corrected.model_dump())
    store.write('speaker-test', {'drafts': [], 'jobs': [], 'events': [], 'analysis': None,
                                'generation': generation(), 'output_variants': []})
    def forbidden(*args, **kwargs):
        pytest.fail('Caption replacement must not run ASR or template subtitle translation')
    monkeypatch.setattr(speaker_integration, 'execute', forbidden)
    from backend.services.studio import packaging
    monkeypatch.setattr(packaging, 'build_packaging', forbidden)
    raw = Draft(id='d1', title='New platform', scenes=[Scene(id='s', start=0, end=2)]).model_dump()
    value = jobs._apply_packaging('speaker-test', raw, 'douyin', True, {})
    assert value['speaker_subtitles'] == corrected.model_dump()
    assert value['caption_mask'] == [.65, .98]
    assert not value.get('packaging')
    assert jobs._apply_strategy(value, 'douyin', burned_subtitles=True).subtitles is True


def test_legacy_initial_auto_draft_is_backed_up_and_versioned_without_rewriting_video(project):
    path, original = seed(project, draft(subtitles=False).model_dump())
    old_bytes = path.read_bytes()
    video = project / 'output.mp4'
    video.write_bytes(b'keep-rendered-video')
    state = store.read('speaker-test')
    restored = state['drafts'][0]
    assert restored['subtitles'] is True and restored['revision'] == 2
    assert restored['caption_mask'] == [.65, .98]
    assert restored['speaker_subtitles'] == original['drafts'][0]['speaker_subtitles']
    assert state['jobs'] == original['jobs']
    assert video.read_bytes() == b'keep-rendered-video'
    backups = list(path.parent.glob('studio.before-speaker-captions*.json'))
    assert len(backups) == 1 and backups[0].read_bytes() == old_bytes
    assert store.read('speaker-test')['drafts'][0] == restored
    assert len(list(path.parent.glob('studio.before-speaker-captions*.json'))) == 1


@pytest.mark.parametrize('values', [{'revision': 2}, {'origin': 'manual'}, {'speaker_colors': False}, {'speaker_subtitles': None}, {'parent_draft_id': 'parent', 'parent_revision': 2}])
def test_ambiguous_or_user_edited_old_drafts_are_not_reenabled(project, values):
    raw = draft(subtitles=False).model_dump()
    raw.update(values)
    seed(project, raw)
    restored = store.read('speaker-test')['drafts'][0]
    assert restored['subtitles'] is False and restored['revision'] == raw['revision']
    assert not list((project / 'metadata').glob('studio.before-speaker-captions*.json'))


def test_manual_off_after_recovery_survives_saves_and_reloads(project):
    seed(project, draft(subtitles=False).model_dump())
    recovered = Draft.model_validate(store.read('speaker-test')['drafts'][0])
    store.save_draft('speaker-test', recovered.model_copy(update={'subtitles': False}))
    saved = store.read('speaker-test')['drafts'][0]
    assert saved['revision'] == 3 and saved['subtitles'] is False


def test_new_recognition_does_not_migrate_an_open_draft_or_lose_its_revision(project):
    raw = draft(subtitles=False).model_dump()
    raw.pop('speaker_subtitles')
    path, _ = seed(project, raw)
    speaker_integration.atomic_json(speaker_integration.sidecar('speaker-test'), document().model_dump())
    assert store.read('speaker-test')['drafts'][0]['revision'] == 1
    assert not list(path.parent.glob('studio.before-speaker-captions*.json'))
    applied = Draft.model_validate({**raw, 'subtitles': True, 'speaker_subtitles': document().model_dump()})
    saved = store.save_draft('speaker-test', applied)
    assert saved['revision'] == 2 and saved['caption_mask'] == [.65, .98]


def test_failed_backup_does_not_change_old_draft(project, monkeypatch):
    path, original = seed(project, draft(subtitles=False).model_dump())
    from pathlib import Path
    real_open = Path.open
    def denied(self, *args, **kwargs):
        if self.name.startswith('studio.before-speaker-captions'):
            raise PermissionError('backup denied')
        return real_open(self, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', denied)
    assert store.read('speaker-test')['drafts'][0] == original['drafts'][0]
    assert json.loads(path.read_text()) == original


def test_failed_recovery_write_keeps_previous_draft_and_export(project, monkeypatch):
    path, original = seed(project, draft(subtitles=False).model_dump())
    def denied(*args):
        raise PermissionError('disk unavailable')
    monkeypatch.setattr(store, '_replace_state', denied)
    result = store.read('speaker-test')
    assert result['drafts'] == original['drafts'] and result['jobs'] == original['jobs']
    assert json.loads(path.read_text()) == original


def test_workspace_http_recovers_once_and_respects_subsequent_manual_off(project, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from types import SimpleNamespace
    from backend.api.v1 import studio
    raw = project / 'raw'
    raw.mkdir()
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                    'color=c=blue:s=160x90:d=2:r=25', str(raw / 'input.mp4')], check=True, timeout=30)
    seed(project, draft(subtitles=False).model_dump())
    monkeypatch.setattr(studio, 'project_or_404', lambda *args: SimpleNamespace(processing_config={}))
    app = FastAPI()
    app.include_router(studio.router, prefix='/studio')
    app.dependency_overrides[studio.get_db] = lambda: None
    with TestClient(app) as client:
        response = client.get('/studio/speaker-test')
        assert response.status_code == 200
        saved = response.json()['drafts'][0]
        assert saved['subtitles'] is True and saved['revision'] == 2
        saved.update(subtitles=False, subtitles_auto_suppressed=False)
        result = client.put('/studio/speaker-test/drafts/d1', json=saved)
        assert result.status_code == 200 and result.json()['revision'] == 3
        assert client.get('/studio/speaker-test').json()['drafts'][0]['subtitles'] is False


@pytest.mark.parametrize('band', [None, [float('nan'), .9], [.8, .2]])
def test_unknown_or_invalid_band_does_not_guess_a_mask_or_disable_recognized_captions(project, band):
    from backend.services.studio.speaker_captions import reconcile
    result = reconcile(draft().model_dump(), {**generation(), 'burned_caption_band': band})
    assert result['subtitles'] is True and not result.get('caption_mask')


def test_real_render_masks_old_caption_band_and_draws_both_speaker_colors(project, monkeypatch):
    from PIL import Image
    from backend.services import video_encoder
    monkeypatch.setattr(video_encoder, 'encoder', lambda: 'libx264')
    monkeypatch.setattr(render, 'text_json', lambda *args, **kwargs: pytest.fail('no paid calls'))
    raw = draft().model_dump()
    raw['caption_mask'] = [.65, .98]
    value = jobs._apply_strategy(raw, 'original', burned_subtitles=True)
    source = project / 'input.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=2',
                    '-vf', 'drawbox=x=160:y=250:w=320:h=20:color=white:t=fill', str(source)], check=True, timeout=30)
    render.render_draft('speaker-test', source, value, 'fixed', lambda _: None)
    out = project / 'output/studio/fixed.mp4'
    frame = project / 'fixed.png'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', '0.8', '-i', str(out), '-frames:v', '1', str(frame)], check=True, timeout=30)
    image = Image.open(frame).convert('RGB')
    # The old opaque white bar no longer remains sharp/white; the new text retains two colors.
    assert min(image.getpixel((320, 260))) < 180
    pixels = list(image.getdata())
    assert sum(r > 190 and 70 < g < 195 and 115 < b < 235 for r, g, b in pixels) > 10
    assert sum(130 < r < 235 and 95 < g < 210 and b > 210 for r, g, b in pixels) > 10
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(out), '-f', 'null', '-'], check=True, timeout=30)
