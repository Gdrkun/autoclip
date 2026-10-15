"""Caption outline persistence, ASS styles and actual encoded pixels; no model calls."""
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


def styles(text):
    section = text.split('[V4+ Styles]\n', 1)[1].split('[Events]', 1)[0]
    lines = section.splitlines()
    fields = [name.strip() for name in lines[0].removeprefix('Format: ').split(',')]
    result = {}
    for line in lines[1:]:
        if line.startswith('Style: '):
            values = dict(zip(fields, line.removeprefix('Style: ').split(',')))
            result[values['Name']] = values
    return result


def draft(**kwargs):
    return Draft(id='outline-draft', title='Outline test', scenes=[Scene(id='s1', start=0, end=2)],
                 speaker_subtitles=document(), **kwargs)


def test_legacy_layout_keeps_serialization_and_fixed_black_outline():
    layout = SpeakerCaptionLayout(font_scale=1.5, x=.4, y=.65)
    assert layout.model_dump() == {'font_scale': 1.5, 'x': .4, 'y': .65}
    ass = scene_ass(document(), Scene(id='s', start=0, end=2), 320, 180, layout=layout)
    default = styles(ass)['Default']
    assert default['Outline'] == '2' and default['OutlineColour'] == '&H00000000'


@pytest.mark.parametrize('value', [{'outline_width': 0}, {'outline_width': 9}, {'outline_width': float('nan')},
                                 {'outline_width': float('inf')}, {'outline_color': '#FFF'},
                                 {'outline_color': '#GG0000'}, {'outline_enabled': 'false'}])
def test_invalid_outline_settings_are_rejected(value):
    with pytest.raises(ValidationError):
        SpeakerCaptionLayout.model_validate(value)


@pytest.mark.parametrize('enabled', [True, False])
def test_http_outline_save_reload_and_ass(client, enabled):
    original = store.save_draft('p1', draft(), create=True)
    layout = {'font_scale': 1.5, 'x': .4, 'y': .65,
              'outline_enabled': enabled, 'outline_width': 3, 'outline_color': '#12ABEF'}
    response = client.put('/studio/p1/drafts/outline-draft', json={**original, 'speaker_subtitle_layout': layout})
    assert response.status_code == 200, response.text
    saved = client.get('/studio/p1').json()['drafts'][0]
    assert saved['speaker_subtitle_layout'] == layout
    response = client.get('/studio/p1/drafts/outline-draft/speaker-subtitles.ass')
    assert response.status_code == 200, response.text
    default = styles(response.text)['Default']
    assert default['Outline'] == ('4.5' if enabled else '0')
    assert default['OutlineColour'] == '&H00EFAB12'
    assert default['Shadow'] == '0'


def test_box_background_is_independent_of_the_letter_outline():
    layout = SpeakerCaptionLayout(outline_enabled=True, outline_width=3, outline_color='#00FF00')
    ass = scene_ass(document(), Scene(id='s', start=0, end=2), 320, 180, style='box', layout=layout)
    result = styles(ass)
    assert result['Default']['BorderStyle'] == '3'
    assert result['Default']['OutlineColour'] == '&H00000000'
    assert result['OutlineText']['BorderStyle'] == '1'
    assert result['OutlineText']['OutlineColour'] == '&H0000FF00'
    assert '\\1a&HFF&' in ass
    assert len([line for line in ass.splitlines() if line.startswith('Dialogue:')]) == 4


def test_real_mp4_has_colored_outline_with_adjustable_width_and_off_switch(root, source, monkeypatch):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=white:s=320x180:r=30:d=2',
                    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2', '-shortest', str(source)], check=True)
    monkeypatch.setattr(render, 'text_json', lambda *a, **k: pytest.fail('outline must not call a model'))
    doc = document()
    doc.subtitles = [doc.subtitles[0].model_copy(update={'text': 'MMMM'})]
    green = {}
    for name, enabled, width, style in [('thin', True, .5, 'clean'), ('thick', True, 4, 'clean'),
                                       ('off', False, 4, 'clean'), ('boxed', True, 4, 'box')]:
        layout = SpeakerCaptionLayout(font_scale=1.5, x=.5, y=.65, outline_enabled=enabled,
                                      outline_width=width, outline_color='#00FF00')
        item = draft(speaker_subtitle_layout=layout, subtitle_style=style)
        item.speaker_subtitles = doc
        render.render_draft('p1', source, item, 'outline-'+name, lambda _: None)
        output = root/'output/studio'/('outline-'+name+'.mp4')
        frame = root/('outline-'+name+'.png')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '0.8', '-i', str(output), '-frames:v', '1', str(frame)], check=True)
        green[name] = sum(g > 140 and r < 130 and b < 150 for r, g, b in Image.open(frame).convert('RGB').getdata())
        if name == 'boxed':
            assert sum(max(rgb) < 60 for rgb in Image.open(frame).convert('RGB').getdata()) > 50
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(output), '-f', 'null', '-'], check=True)
    assert green['thin'] > 5 and green['thick'] > 2 * green['thin'], green
    assert green['off'] == 0 and green['boxed'] > 20, green
