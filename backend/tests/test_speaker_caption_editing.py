"""Saved caption geometry/order, ASS and actual MP4 output without model calls."""
import subprocess

from PIL import Image
import pytest
from pydantic import ValidationError

from backend.tests.test_studio import client, root, source  # noqa: F401
from backend.tests.test_speaker_integration import document
from backend.services.speaker_subtitles import SpeakerCaptionLayout
from backend.services.speaker_ass import scene_ass
from backend.services.studio import store, render
from backend.services.studio.models import Draft, Scene


def draft(**kwargs):
    return Draft(id='caption-layout', title='Caption layout', scenes=[Scene(id='s1', start=0, end=2)],
                 speaker_subtitles=document(), **kwargs)


def test_old_draft_serialization_has_no_layout_field():
    assert 'speaker_subtitle_layout' not in draft().model_dump()


@pytest.mark.parametrize('value', [{'font_scale': .1}, {'font_scale': 3}, {'font_scale': float('nan')},
                                 {'x': 0}, {'x': float('inf')}, {'y': 1}, {'y': .1}])
def test_layout_rejects_invalid_values(value):
    with pytest.raises(ValidationError):
        SpeakerCaptionLayout.model_validate(value)


@pytest.mark.parametrize('aspect,width,height,font,x,y', [('original', 320, 180, 21, 128, 117),
                                                        ('portrait', 1080, 1920, 122, 432, 1248)])
def test_http_save_reload_and_ass_keep_layout_and_manual_order(client, aspect, width, height, font, x, y):
    initial = store.save_draft('p1', draft(aspect=aspect), create=True)
    changed = {**initial, 'speaker_subtitle_layout': {'font_scale': 1.5, 'x': .4, 'y': .65}}
    changed['speaker_subtitles']['subtitles'].reverse()
    response = client.put('/studio/p1/drafts/caption-layout', json=changed)
    assert response.status_code == 200, response.text
    saved = client.get('/studio/p1').json()['drafts'][0]
    assert saved['speaker_subtitle_layout'] == changed['speaker_subtitle_layout']
    assert [cue['id'] for cue in saved['speaker_subtitles']['subtitles']] == ['b', 'a']
    ass = client.get('/studio/p1/drafts/caption-layout/speaker-subtitles.ass')
    assert ass.status_code == 200, ass.text
    assert f'PlayResX: {width}' in ass.text and f'PlayResY: {height}' in ass.text
    assert f'Microsoft YaHei,{font},' in ass.text and f'\\pos({x},{y})' in ass.text
    assert '&HBD91FF&' in ass.text
    response = client.put('/studio/p1/drafts/caption-layout', json={**saved, 'speaker_colors': False})
    assert response.status_code == 200
    ass = client.get('/studio/p1/drafts/caption-layout/speaker-subtitles.ass').text
    assert '&HBD91FF&' not in ass and '&HFFFFFF&' in ass


def test_equal_time_order_is_stable_for_overlap_assignment():
    doc = document()
    doc.subtitles[1].start_ms = doc.subtitles[0].start_ms
    doc.subtitles.reverse()
    ass = scene_ass(doc, Scene(id='s', start=0, end=2), 320, 180,
                    layout=SpeakerCaptionLayout(font_scale=2, x=.3, y=.5))
    rows = [line for line in ass.splitlines() if line.startswith('Dialogue:')]
    assert 'Speaker B' in rows[0] and '\\pos(96,90)' in rows[0]
    assert 'Speaker A' in rows[1] and '\\pos(96,45)' in rows[1]


def test_actual_mp4_moves_and_scales_subtitle_pixels(root, source, monkeypatch):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:s=320x180:r=30:d=2',
                    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2', '-shortest', str(source)], check=True)
    monkeypatch.setattr(render, 'text_json', lambda *a, **k: pytest.fail('layout must not call a model'))
    doc = document()
    doc.subtitles = [doc.subtitles[0].model_copy(update={'text': 'AAAA'})]
    bounds = []
    for job, layout in [('default', None), ('custom', SpeakerCaptionLayout(font_scale=2, x=.3, y=.5))]:
        item = draft(speaker_subtitle_layout=layout)
        item.speaker_subtitles = doc
        render.render_draft('p1', source, item, job, lambda _: None)
        output = root / 'output/studio' / f'{job}.mp4'
        frame = root / f'{job}.png'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '0.8', '-i', str(output), '-frames:v', '1', str(frame)], check=True)
        points = [(i % 320, i // 320) for i, (r, g, b) in enumerate(Image.open(frame).convert('RGB').getdata())
                  if r > 180 and 60 < g < 200 and 100 < b < 240]
        assert points
        bounds.append((min(x for x, _ in points), min(y for _, y in points),
                       max(x for x, _ in points), max(y for _, y in points)))
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], check=True)
    normal, custom = bounds
    assert custom[3] < normal[1] - 40
    assert abs((custom[0] + custom[2]) / 2 - 96) < 5
    assert custom[2] - custom[0] > 1.6 * (normal[2] - normal[0])
