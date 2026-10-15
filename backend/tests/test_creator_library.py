"""Local persistence and real selection/ASR boundaries; no external model calls."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend.services import creator_library as lib
from backend.services.character_background import project_context
from backend.services.studio import store
from backend.services.studio.models import Draft, Scene, ImportOptions
from backend.tests.test_studio import client, root, source  # noqa: F401


def fixture_library():
    return lib.Library(profiles=[lib.Profile(name='思诺snow', aliases=['思诺'], background='沉稳，热爱唱歌', memes='考研梗需要前后语境')],
                       terms=[lib.Term(correct='心宜', variants=['心仪']), lib.Term(correct='小海诺', variants=['小海螺'], scope='思诺snow')])


def project(root, query='思诺snow'):
    data=store.read('p1');data['plan']={'overrides':{'background_query':query}};store.write('p1',data)
    return lib.save(fixture_library())


def test_library_http_roundtrip_conflict_backup_and_invalid_identity(client):
    original=client.get('/studio/creator-library').json()
    body=fixture_library().model_dump()
    saved=client.put('/studio/creator-library',json=body)
    assert saved.status_code==200 and saved.json()['revision']==1
    assert client.put('/studio/creator-library',json=body).status_code==409
    body=saved.json();body['profiles'][0]['memes']='人工修订后的梗'
    assert client.put('/studio/creator-library',json=body).status_code==200
    assert json.loads(lib.path().with_suffix('.backup.json').read_text(encoding='utf-8'))['revision']==1
    assert original['profiles']==[]
    body['revision']=2;body['profiles'].append({**body['profiles'][0],'id':'another','name':'另一角色','aliases':['思诺']})
    assert client.put('/studio/creator-library',json=body).status_code==422
    assert lib.load().revision==2


def test_corrupt_library_never_overwrites_original(root):
    lib.path().write_text('{broken',encoding='utf-8')
    with pytest.raises(ValueError,match='原文件已保留'):lib.save(lib.Library())
    assert lib.path().read_text(encoding='utf-8')=='{broken'
    with project_context('p1'):
        assert lib.context_prompt()==''


def test_profile_aliases_and_terms_are_scoped_not_substring_matches(root):
    library=fixture_library()
    assert lib.matched('思诺（B站）',library)['profiles'][0]['name']=='思诺snow'
    assert len(lib.matched('思诺（B站）',library)['terms'])==2
    assert not lib.matched('思诺snow的同名粉丝',library)['profiles']
    assert len(lib.matched('心宜不是心仪',library)['terms'])==1


def test_user_background_and_feedback_reach_actual_model_boundary_and_cache(root):
    project(root)
    store.save_draft('p1',Draft(id='d',title='有铺垫的互动',scenes=[Scene(id='s',start=0,end=30)]),create=True)
    lib.record_feedback('p1','d','less','humor','少选无铺垫的闲聊')
    from backend.pipeline.selection_preferences import selection_prompt,cache_suffix
    from backend.pipeline.clip_finder import find_clips
    from backend.tests.test_clip_finder import _entries
    prompts=[]
    def call(prompt,data):
        prompts.append(prompt)
        return {'clips':[{'start':10,'end':40,'title':'真实反差','reason':'有上下文的互动','score':.9}]}
    assert selection_prompt('')==''
    with project_context('p1'):
        before=cache_suffix('')
        find_clips(_entries(12),call,threshold=.7)
        assert '沉稳，热爱唱歌' in prompts[0] and '考研梗' in prompts[0] and '少选无铺垫的闲聊' in prompts[0]
        assert '当前明确制作要求优先于历史反馈' in prompts[0]
    saved=lib.load();saved.profiles[0].memes='更正后的梗';lib.save(saved)
    with project_context('p1'):assert cache_suffix('')!=before
    assert selection_prompt('')==''


def test_feedback_api_upserts_by_draft_and_can_be_forgotten(client):
    project(None)
    store.save_draft('p1',Draft(id='d',title='合成示例',scenes=[Scene(id='s',start=0,end=2)]),create=True)
    url='/studio/p1/drafts/d/selection-feedback'
    assert client.post(url,json={'direction':'more','category':'singing','note':'完整乐句'}).status_code==200
    assert client.post(url,json={'direction':'less','category':'other','note':'太多闲聊'}).status_code==200
    assert len(lib.load().feedback)==1 and lib.load().feedback[0].direction=='less'
    assert client.post('/studio/p1/drafts/missing/selection-feedback',json={'direction':'more','category':'humor'}).status_code==404
    other=lib.matched('另一角色',lib.load());assert not other['feedback']
    body=client.get('/studio/creator-library').json();body['feedback']=[]
    assert client.put('/studio/creator-library',json=body).status_code==200
    assert not lib.load().feedback


def test_correction_suggestions_only_change_text_and_do_not_cascade(client):
    project(None)
    library=lib.load();library.terms.append(lib.Term(correct='心宜不是心仪',variants=['心仪不是心仪']));lib.save(library)
    response=client.post('/studio/p1/vocabulary-suggestions',json={'texts':['心仪不是心仪和小海螺','没有错误']})
    assert response.status_code==200
    assert response.json()['suggestions']==[{'index':0,'before':'心仪不是心仪和小海螺','after':'心宜不是心仪和小海诺'}]
    assert not (store.directory('p1')/'metadata/speaker_subtitles.json').exists()


def test_ambiguous_replacements_are_not_guessed(root):
    lib.save(lib.Library(terms=[lib.Term(correct='心宜',variants=['心仪']),lib.Term(correct='心怡',variants=['心仪'])]))
    assert lib.corrections(['心仪说话'])==[]


def test_whisper_convenience_function_gets_vocabulary_prompt(root,monkeypatch):
    project(root)
    from backend.utils import speech_recognizer as speech
    monkeypatch.setattr('backend.pipeline.media_precheck.has_audio',lambda _:True)
    monkeypatch.setattr('backend.services.ai_model_settings.load',lambda:SimpleNamespace(transcription=SimpleNamespace(
        provider='whisper_local',speaker_diarization=False,initial_prompt='自定义提示',model='base')))
    captured=[]
    monkeypatch.setattr(speech,'SpeechRecognizer',lambda:SimpleNamespace(generate_subtitle=lambda video,output,config:captured.append(config) or output))
    with project_context('p1'):
        speech.generate_subtitle_for_video(Path('input.mp4'),Path('output.srt'))
    assert '自定义提示' in captured[0].initial_prompt and '小海诺' in captured[0].initial_prompt and '思诺snow' in captured[0].initial_prompt


def test_asr_prompt_is_bounded_and_manual_prompt_is_preserved(root):
    project(root)
    with project_context('p1'):
        assert lib.asr_prompt('x'*500)=='x'*500
        assert lib.asr_prompt('原提示').startswith('原提示')
    assert lib.asr_prompt('原提示').startswith('原提示')
    assert '小海诺' not in lib.asr_prompt('原提示')


@pytest.mark.parametrize('value',[{'correct':'','variants':[]},{'correct':'心宜','variants':['宜']},{'correct':'心宜','variants':['心宜']}])
def test_invalid_terms_rejected(value):
    with pytest.raises(ValidationError):lib.Term.model_validate(value)
