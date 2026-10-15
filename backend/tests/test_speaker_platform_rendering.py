"""Real FFmpeg regressions for speaker captions with platform language/window defaults."""
from pathlib import Path
import json
import subprocess

from PIL import Image
import pytest

from backend.tests.test_studio import root, source, client  # noqa: F401
from backend.services.studio import render, store
from backend.services.studio.models import Draft, Packaging, Scene
from backend.services.speaker_subtitles import Speaker, SpeakerDocument, Cue


def document(text='心宜和思诺在唱歌。'):
    return SpeakerDocument(duration_ms=3000,speakers=[Speaker(speaker_id='spk_0',color='#FF91BD'),
                                                    Speaker(speaker_id='spk_1',color='#C0A5FF')],
                           subtitles=[Cue(id='a',start_ms=100,end_ms=1800,text=text,speaker_id='spk_0'),
                                      Cue(id='b',start_ms=300,end_ms=1900,text='对方的回应和笑声。',speaker_id='spk_1',layer=1)])


def no_models(monkeypatch):
    monkeypatch.setattr(render,'text_json',lambda *a,**k:pytest.fail('render must not call a model'))
    from backend.services import video_encoder
    monkeypatch.setattr(video_encoder,'encoder',lambda:'libx264')


@pytest.mark.parametrize('language',['source','zh'])
def test_real_portrait_window_speaker_render_keeps_layout_and_two_colors(root,source,monkeypatch,language):
    no_models(monkeypatch)
    subprocess.run(['ffmpeg','-nostdin','-v','error','-y','-f','lavfi','-i','color=c=blue:s=320x180:r=30:d=3',
                    '-f','lavfi','-i','sine=f=440:d=3','-shortest',str(source)],check=True,timeout=30)
    # Use the actual platform canvas: window compositor is 1080 x 1920.
    draft=Draft(id='window',title='实际访谈窗口',scenes=[Scene(id='s',start=0,end=2)],aspect='portrait',layout='window',
                language=language,speaker_subtitles=document(),packaging=Packaging(template='interview_zh',audience_language='zh',title_lines=['已有包装'],cues=[]))
    result=render.render_draft('p1',source,draft,'window-'+language,lambda _:None)
    output=root/'output/studio'/('window-'+language+'.mp4')
    assert result['width']==1080 and result['height']==1920
    frame=root/('window-'+language+'.png')
    subprocess.run(['ffmpeg','-nostdin','-v','error','-y','-ss','0.8','-i',str(output),'-frames:v','1',str(frame)],check=True,timeout=30)
    image=Image.open(frame).convert('RGB')
    assert image.size==(1080,1920)
    # The synthetic blue video must occupy the 4:3 middle window, with a separate canvas above.
    assert image.getpixel((540,960)) != image.getpixel((540,200))
    pixels=list(image.getdata())
    assert sum(r>190 and 70<g<195 and 115<b<235 for r,g,b in pixels)>10
    assert sum(130<r<235 and 95<g<210 and b>210 for r,g,b in pixels)>10
    subprocess.run(['ffmpeg','-v','error','-i',str(output),'-f','null','-'],check=True,timeout=30)


def test_real_bilibili_zh_same_language_preserves_speaker_subtitles(root,source,monkeypatch):
    no_models(monkeypatch)
    from backend.services.studio.jobs import _apply_strategy
    base=Draft(id='bilibili',title='中文原字幕',scenes=[Scene(id='s',start=0,end=2)],speaker_subtitles=document())
    draft=_apply_strategy(base.model_dump(),'bilibili')
    assert draft.language=='zh'
    result=render.render_draft('p1',source,draft,'bilibili-zh',lambda _:None)
    assert result['width']==1920 and result['height']==1080
    assert result['duration']==pytest.approx(2,abs=.1)
    assert draft.speaker_subtitles==base.speaker_subtitles
    info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=codec_type','-of','json',
                                           str(root/'output/studio/bilibili-zh.mp4')]))
    assert {'audio','video'}<={s['codec_type'] for s in info['streams']}


@pytest.mark.parametrize('text,language',[('心宜','zh'),('Hello there','en'),('ここで私たちは一緒に歌いましょう。','zh'),('This is an English conversation with clear words.','zh')])
def test_matching_original_language_and_actual_translation_are_distinguished(root,source,monkeypatch,text,language):
    no_models(monkeypatch)
    doc=document(text);doc.subtitles=doc.subtitles[:1]
    draft=Draft(id='language',title='Language',scenes=[Scene(id='s',start=0,end=2)],language=language,speaker_subtitles=doc)
    if (text,language) in [('心宜','zh'),('Hello there','en')]:
        render.render_draft('p1',source,draft,'short-'+language,lambda _:None)
    else:
        with pytest.raises(ValueError,match='只支持原语言'):
            render.render_draft('p1',source,draft,'needs-translation',lambda _:None)


def test_retry_saved_failed_draft_reuses_snapshot_without_asr_or_selection(client,root,source,monkeypatch):
    from backend.services.studio import jobs
    no_models(monkeypatch)
    draft=Draft(id='saved',title='保留选片',scenes=[Scene(id='s',start=.1,end=2.1)],language='zh',speaker_subtitles=document())
    original=store.save_draft('p1',draft,create=True)
    monkeypatch.setattr(jobs,'source',lambda _:source)
    monkeypatch.setattr(jobs,'_design_covers',lambda *a:None)
    class Immediate:
        def submit(self,fn,*args,**kwargs):return fn(*args,**kwargs)
    monkeypatch.setattr(jobs,'render_executor',Immediate())
    monkeypatch.setattr('backend.services.studio.qa.schedule.schedule_after_render',lambda *a,**k:None)
    response=client.post('/studio/p1/drafts/saved/export',json={'revision':original['revision']})
    assert response.status_code==200,response.text
    state=client.get('/studio/p1').json()
    assert state['jobs'][0]['status']=='completed',state['jobs'][0].get('error')
    assert state['drafts'][0]==original
