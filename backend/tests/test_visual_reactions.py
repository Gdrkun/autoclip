"""Whole-picture reaction evidence, consent, cache and real selection boundaries."""
import asyncio
from array import array
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.services import visual_reactions as reactions, reaction_scan
from backend.services.studio import store, intelligence, jobs
from backend.services.studio.models import ImportOptions
from backend.tests.test_studio import root, source, client  # noqa: F401


@pytest.fixture(autouse=True)
def scope():
    token = reactions._current.set(None)
    yield
    reactions._current.reset(token)


@pytest.fixture
def prepared(root, source, monkeypatch):
    state = store.read('p1')
    state['plan'] = {'overrides': {'visual_reactions': True, 'reaction_budget': 1, 'instruction': '优先互动'}}
    store.write('p1', state)
    srt = source.with_suffix('.srt')
    srt.write_text('1\n00:00:00,100 --> 00:00:02,800\n说错了哈哈\n', encoding='utf-8')
    monkeypatch.setattr(intelligence, 'source_frame_analysis_allowed', lambda: True)
    from backend.services.studio import vision_settings
    monkeypatch.setattr(vision_settings, 'effective', lambda: {'model': 'fixture-vision', 'base_url': 'http://127.0.0.1:1', 'api_key': 'private-key'})
    calls = []
    def observe(content, **kwargs):
        calls.append(content)
        times = [float(item['text'].split()[1]) for item in content[1:] if item['type'] == 'text']
        return {'events': [{'label': '人物动作变化', 'kind': 'reaction', 'start': 0, 'end': 3,
            'observed_at': [times[1], times[-2]], 'evidence': '前后画面位置发生变化，字幕有接话', 'uncertainty': '合成协议样例，不是真实情绪'}]}
    monkeypatch.setattr(intelligence, 'vision_call', observe)
    return source, srt, calls


def test_defaults_and_request_budget_preserve_legacy_shape():
    assert 'visual_reactions' not in ImportOptions().model_dump()
    assert 'reaction_budget' not in ImportOptions().model_dump()
    for count in (0, 13):
        with pytest.raises(ValueError): ImportOptions(reaction_budget=count)


def test_picture_changes_are_only_clues_and_audio_does_not_claim_laughter():
    size = reaction_scan.WIDTH*reaction_scan.HEIGHT
    raw = bytes([0])*size + bytes([255])*size
    assert reaction_scan.picture_clues(raw, 7) == [{'at': 7.5, 'picture': 1.0, 'scene_change': True}]
    sound = array('h', [10]*8000 + [20000]*4000).tobytes()
    clues = reaction_scan.sound_clues(sound, 2)
    assert clues[0]['at'] == 3 and 'sound' in clues[0] and 'laughter' not in str(clues)


def test_candidate_coverage_includes_late_video_and_cut_sides():
    windows = reaction_scan.candidate_windows([{'at': 25, 'picture': .9, 'scene_change': True}], 120, 4)
    assert len(windows) == 4 and windows[-1]['start'] > 80
    assert any(abs(at-24.6)<.01 for at in windows[0]['times'])
    assert any(abs(at-25.4)<.01 for at in windows[0]['times'])
    assert all(len(window['times']) <= 16 and 0 <= window['start'] < window['end'] <= 120 for window in windows)


def test_disabled_or_revoked_consent_never_scans_or_calls_model(root, source, monkeypatch):
    monkeypatch.setattr(reaction_scan, 'scan', lambda *a, **k: pytest.fail('no scan without permission'))
    monkeypatch.setattr(intelligence, 'vision_call', lambda *a, **k: pytest.fail('no paid calls'))
    assert reactions.analyze('p1', source) is None
    state=store.read('p1');state['plan']={'overrides':{'visual_reactions':True}};store.write('p1',state)
    monkeypatch.setattr(intelligence, 'source_frame_analysis_allowed', lambda: False)
    assert reactions.analyze('p1', source).status == 'unavailable'


def test_real_full_frame_sampling_cache_and_analysis_only_markers(prepared, root):
    video, srt, calls = prepared
    original = srt.read_bytes()
    progress=[]
    report = reactions.analyze('p1', video, srt, lambda *args: progress.append(args))
    assert report.status == 'completed' and len(report.events) == 1 and len(calls) == 1
    assert any('image_url' in item for item in calls[0]) and '说错了哈哈' in calls[0][0]['text']
    assert '不凭表情认定真实情绪' in calls[0][0]['text'] and '固定左右' in calls[0][0]['text']
    assert all((root/'metadata/visual-reactions'/report.run_id/'0'/f'{i}.jpg').is_file() for i in range(12))
    from backend.pipeline.selection_preferences import selection_prompt, cache_suffix
    with reactions.project_context('p1'):
        assert '人物动作变化' in selection_prompt('优先搞笑')
        marker = reactions.selection_srt(srt, root/'metadata')
        assert marker.parent.name == 'analysis-only' and '非对白' in marker.read_text(encoding='utf-8')
        assert cache_suffix('')
        assert reactions.preserve_bounds([(0,3)],[(.5,2)]) == [(0,3)]
    second = reactions.analyze('p1', video, srt)
    assert len(calls) == 1 and second.run_id == report.run_id
    assert srt.read_bytes() == original and progress[0][0] == 'scan' and progress[-1][0] == 'review'
    assert 'private-key' not in reactions.report_path('p1').read_text(encoding='utf-8')


@pytest.mark.parametrize('change', [
    {'observed_at':[.2,.9]}, {'start':-1}, {'end':99}, {'observed_at':[1,1]},
    {'observed_at':[float('nan'),2]}, {'ignored':True}, {'kind':'emotion'},
])
def test_fabricated_times_and_review_flags_rejected(change):
    value={'kind':'reaction','label':'x','start':0,'end':3,'observed_at':[1,2],'evidence':'seen'}
    with pytest.raises(ValueError):
        reactions.validate_events({'events':[{**value, **change}]}, {'id':0,'start':0,'end':3}, [0,1,2,3])


def test_api_evidence_and_review_do_not_launch_models(prepared, client, monkeypatch):
    video,srt,calls=prepared
    report=reactions.analyze('p1',video,srt)
    event=report.events[0]
    def forbidden(*a,**k): pytest.fail('GET and review must not analyze')
    monkeypatch.setattr(intelligence,'vision_call',forbidden)
    assert client.get('/studio/visual-reactions/status').status_code == 200
    endpoint='/studio/p1/visual-reactions'
    assert client.get(endpoint).json()['events'][0]['id']==event.id
    assert client.patch(endpoint+'/'+event.id,json={'run_id':'0'*64,'ignored':True}).status_code==409
    assert client.patch(endpoint+'/'+event.id,json={'run_id':report.run_id,'ignored':True}).json()['events'][0]['ignored']
    with reactions.project_context('p1'): assert reactions.context_prompt()==''
    image=client.get(endpoint+f'/frames/{report.run_id}/0/1')
    assert image.status_code==200 and image.headers['content-type']=='image/jpeg'
    assert client.get(endpoint+f'/frames/{report.run_id}/0/999').status_code==404
    assert client.get('/studio/missing/visual-reactions').status_code==404


def test_failed_provider_stops_budget_and_keeps_original_input(prepared,monkeypatch):
    video,srt,_=prepared;original=srt.read_bytes()
    def fail(*a,**k):raise intelligence.VisionRequestError('timeout','fixture')
    monkeypatch.setattr(intelligence,'vision_call',fail)
    report=reactions.analyze('p1',video,srt)
    assert report.status=='failed' and report.failed_windows==1 and srt.read_bytes()==original
    assert reactions.context_prompt()==''


def test_cancelled_project_never_generates_frames(prepared,monkeypatch):
    video,srt,calls=prepared
    from backend.core import project_cancellation as cancellation
    def cancelled(*a):raise cancellation.JobStopped('p1')
    monkeypatch.setattr(cancellation,'checkpoint',cancelled)
    with pytest.raises(cancellation.JobStopped):reactions.analyze('p1',video,srt)
    assert not calls


def test_source_change_invalidates_context_and_images(prepared):
    video,srt,_=prepared
    report=reactions.analyze('p1',video,srt)
    video.write_bytes(video.read_bytes()+b'changed')
    assert reactions.load_project('p1') is None
    with pytest.raises(FileNotFoundError):reactions.frame_path('p1',report.run_id,0,1)


def test_actual_adapter_uses_evidence_before_selecting(prepared,root,monkeypatch):
    from backend.services import simple_pipeline_adapter as adapter, speaker_integration
    from backend.services.data_sync_service import DataSyncService
    from backend.pipeline import media_precheck
    video,srt,calls=prepared
    monkeypatch.setattr(adapter.SimplePipelineAdapter,'_preflight_llm',lambda *a:None)
    monkeypatch.setattr(adapter.SimplePipelineAdapter,'_prompt_files',lambda *a:{})
    progress=[]
    monkeypatch.setattr(adapter,'emit_progress',lambda *a,**k:progress.append((a,k)))
    monkeypatch.setattr(adapter,'clear_progress',lambda *a:None)
    monkeypatch.setattr(media_precheck,'subtitle_route_failure',lambda *a,**k:None)
    monkeypatch.setattr(speaker_integration,'ensure_for_project',lambda *a,**k:None)
    monkeypatch.setattr(DataSyncService,'sync_project_from_filesystem',lambda *a:{'success':True})
    seen=[]
    def select(self,path,metadata,**kwargs):
        seen.append(Path(path).read_text(encoding='utf-8'))
        from backend.pipeline.selection_preferences import selection_prompt
        assert '人物动作变化' in selection_prompt('')
        return [{'id':'1','generated_title':'fixture','final_score':.9}]
    monkeypatch.setattr(adapter.SimplePipelineAdapter,'_find_clips_in_one_pass',select)
    result=asyncio.run(adapter.SimplePipelineAdapter('p1','task').process_project_sync(str(video),str(srt),clips_only=True))
    assert result['status']=='succeeded',result
    assert len(calls)==1 and '非对白' in seen[0]
    reaction_progress=[kwargs['subpercent'] for args,kwargs in progress if len(args)>2 and args[2] in (
        '正在扫描画面变化与声音线索','正在复核连续画面反应')]
    assert reaction_progress==sorted(reaction_progress) and all(95<=value<=99 for value in reaction_progress)


def test_fast_and_legacy_selection_receive_visual_context(prepared,root,monkeypatch):
    from backend.pipeline.clip_finder import find_clips
    from backend.pipeline import step1_outline, step2_timeline
    from backend.tests.test_clip_finder import _entries
    video,srt,_=prepared;reactions.analyze('p1',video,srt)
    calls=[]
    monkeypatch.setattr(step1_outline,'LLMClient',lambda:SimpleNamespace())
    monkeypatch.setattr(step2_timeline,'LLMClient',lambda:SimpleNamespace())
    def select(prompt,payload):
        calls.append(prompt)
        return {'clips':[{'start':10,'end':40,'title':'完整反应','reason':'画面依据','score':.9}]}
    with reactions.project_context('p1'):
        find_clips(_entries(12),select,threshold=.7)
        assert '人物动作变化' in calls[0]
        assert '人物动作变化' in step1_outline.OutlineExtractor(root/'metadata').outline_prompt
        assert '人物动作变化' in step2_timeline.TimelineExtractor(root/'metadata').timeline_prompt


def fake_windows(prepared, monkeypatch, budget=3):
    video,srt,calls=prepared
    state=store.read('p1');state['plan']['overrides']['reaction_budget']=budget;store.write('p1',state)
    monkeypatch.setattr(intelligence,'_probe',lambda *a:{'duration':42})
    monkeypatch.setattr(reaction_scan,'scan',lambda *a,**k:[])
    def sample(video,times,folder,**kwargs):
        output=[]
        for index,at in enumerate(times):
            (folder/f'{index}.jpg').write_bytes(b'fixture-image')
            output += [{'type':'text','text':f'原片时间 {at:.2f} 秒'}, {'type':'image_url','image_url':{'url':'data:image/jpeg;base64,Zml4dHVyZQ=='}}]
        return output
    monkeypatch.setattr(intelligence,'sample',sample)
    return video,srt


def test_partial_failure_retry_reuses_only_completed_window_cache(prepared,monkeypatch):
    video,srt=fake_windows(prepared,monkeypatch)
    seen=[]
    def call(content,**kwargs):
        payload=json.loads(content[0]['text'].split('\n')[-1]);start=payload['window']['start'];seen.append(start)
        if len(seen)==2:raise intelligence.VisionRequestError('timeout','fixture')
        return {'events':[]}
    monkeypatch.setattr(intelligence,'vision_call',call)
    first=reactions.analyze('p1',video,srt)
    assert first.status=='partial' and first.completed_windows==1 and len(seen)==2
    second=reactions.analyze('p1',video,srt)
    assert second.status=='completed' and second.completed_windows==3
    assert len(seen)==4 and seen[0]!=seen[1] and seen[1]==seen[2]


def test_permission_revocation_between_windows_stops_next_request(prepared,monkeypatch):
    video,srt=fake_windows(prepared,monkeypatch)
    allowed=[True];calls=[]
    monkeypatch.setattr(intelligence,'source_frame_analysis_allowed',lambda:allowed[0])
    def call(*a,**k):
        calls.append(1);allowed[0]=False
        return {'events':[]}
    monkeypatch.setattr(intelligence,'vision_call',call)
    report=reactions.analyze('p1',video,srt)
    assert calls==[1] and report.status=='partial' and report.completed_windows==1


def test_scan_chunk_cache_is_reused_and_corruption_recovers(tmp_path,monkeypatch):
    calls=[]
    size=reaction_scan.WIDTH*reaction_scan.HEIGHT
    monkeypatch.setattr(reaction_scan,'_decode',lambda video,start,length,audio=False:calls.append(start) or bytes([0])*size)
    cache=tmp_path/'scan'
    reaction_scan.scan('fixture',181,cache,audio=False)
    assert calls==[0,180]
    reaction_scan.scan('fixture',181,cache,audio=False)
    assert calls==[0,180]
    (cache/'scan-1.json').write_text('broken')
    reaction_scan.scan('fixture',181,cache,audio=False)
    assert calls==[0,180,180]


def test_new_import_http_persists_reaction_request_without_starting_inference(client,source,monkeypatch):
    captured=[]
    monkeypatch.setattr(jobs,'inspect_project',lambda pid,options,*args,**kwargs:captured.append(options))
    with source.open('rb') as stream:
        response=client.post('/studio/import',data={'visual_reactions':'true','reaction_budget':'4'},files={'video':('fixture.mp4',stream,'video/mp4')})
    assert response.status_code==200,response.text
    assert captured[0].visual_reactions and captured[0].reaction_budget==4
