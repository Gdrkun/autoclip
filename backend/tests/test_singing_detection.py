"""Audio event filtering, timing, fallback and subprocess contracts; no paid calls."""
import json
from pathlib import Path

import pytest

from backend.services import singing_detection as singing
from backend.services import singing_worker as worker
from backend.services.studio import store
from backend.tests.test_studio import client, root, source  # noqa: F401


def report(source):
    return singing.Report(status='completed',duration=40,fingerprint=singing.fingerprint(source),
                          segments=[singing.Segment(start=5,end=35,score=.8)])


def test_music_only_and_speech_are_not_singing():
    assert worker.classify_scores([.9,.8,.01],['Music','Speech','Singing'])==(.01,.9,.8)
    values=[{'start':0,'end':10,'singing':.01,'speech':.8,'music':.9}]
    assert worker.merge_windows(values,20)==[]
    values[0]['singing']=.4
    assert worker.merge_windows(values,20)==[]
    values[0]['singing']=.9
    assert worker.merge_windows(values,20)==[{'start':0,'end':11,'score':.9}]


def test_singing_windows_merge_and_remain_inside_source():
    values=[{'start':t,'end':min(t+10,22),'singing':.7,'speech':.1} for t in [0,5,10,15]]
    result=worker.merge_windows(values,22)
    assert len(result)==1 and result[0]['start']==0 and result[0]['end']==22
    assert worker.classify_scores([.8,.1],['Female singing','Speech'])[0]==.8
    duration=33.134875
    tail=worker.merge_windows([{'start':25,'end':duration,'singing':.7,'speech':.1}],duration)
    assert tail[0]['end']<=duration


def test_audio_candidates_fill_missing_transcript_without_becoming_source_subtitles(root,source):
    value=report(source);singing.atomic_json(singing.report_path('p1'),value.model_dump())
    from backend.services.publish_export import find_source_srt
    from backend.pipeline.selection_preferences import selection_prompt
    with singing.project_context('p1'):
        analysis=singing.selection_srt(None,root/'metadata')
        assert '非歌词' in analysis.read_text(encoding='utf-8')
        assert singing.selection_srt(analysis,root/'metadata')==analysis
        assert '本地 CPU 音频模型' in selection_prompt('优先唱歌')
    assert find_source_srt('p1') is None


def test_changed_source_invalidates_saved_detection(root,source):
    singing.atomic_json(singing.report_path('p1'),report(source).model_dump())
    assert singing.load_project('p1')
    source.write_bytes(source.read_bytes()+b'changed')
    assert singing.load_project('p1') is None


def test_sentence_polishing_does_not_cut_out_untranscribed_song(root,source):
    singing.atomic_json(singing.report_path('p1'),report(source).model_dump())
    with singing.project_context('p1'):
        assert singing.preserve_song_bounds([(4,36),(0,3)],[(20,30),(0,2)])==[(4,36),(0,2)]
    assert singing.preserve_song_bounds([(4,36)],[(20,30)])==[(20,30)]


def test_disabling_removes_active_hints_preserving_original_media(root,source):
    original=source.read_bytes()
    singing.atomic_json(singing.report_path('p1'),report(source).model_dump())
    singing.analyze('p1',source,False)
    assert singing.load_project('p1') is None and source.read_bytes()==original


def test_missing_model_explicitly_reports_unavailable_without_network(root,source,monkeypatch):
    monkeypatch.setattr(singing,'status',lambda:{'status':'not_ready'})
    monkeypatch.setattr(singing,'_worker',lambda *a:pytest.fail('no implicit model download'))
    result=singing.analyze('p1',source,True)
    assert result.status=='unavailable' and not result.segments


def test_api_prepare_runs_only_on_explicit_request(client,monkeypatch):
    monkeypatch.setattr(singing,'status',lambda:{'status':'ready','runtime_ready':True})
    assert client.get('/studio/singing/status').json()['status']=='ready'
    monkeypatch.setattr(singing,'prepare',lambda:{'status':'preparing'})
    assert client.post('/studio/singing/prepare').json()['status']=='preparing'


def test_invalid_nonfinite_or_out_of_range_times_rejected():
    for start,end in [(float('nan'),20),(20,10),(0,float('inf')),(-1,20)]:
        with pytest.raises(ValueError):singing.Segment(start=start,end=end,score=.7)
    with pytest.raises(ValueError):singing.Report(status='completed',duration=10,segments=[singing.Segment(start=0,end=20,score=.9)])


def test_enabled_singing_import_field_reaches_inspection(client,source,monkeypatch):
    from backend.services.studio import jobs
    captured=[];monkeypatch.setattr(jobs,'inspect_project',lambda pid,options,*a,**k:captured.append(options))
    response=client.post('/studio/import',data={'detect_singing':'true'},files={'video':('sample.mp4',source.read_bytes(),'video/mp4')})
    assert response.status_code==200 and captured[0].detect_singing


@pytest.mark.parametrize('mode',['error','empty'])
def test_actual_pipeline_can_select_audio_when_asr_has_no_lyrics(root,source,monkeypatch,mode):
    import asyncio
    from backend.services import simple_pipeline_adapter as mod
    from backend.utils.speech_recognizer import SpeechRecognitionError
    from backend.pipeline.selection_preferences import selection_prompt
    monkeypatch.setattr(mod,'clear_progress',lambda *a:None)
    monkeypatch.setattr(mod,'emit_progress',lambda *a,**k:None)
    monkeypatch.setattr('backend.pipeline.media_precheck.subtitle_route_failure',lambda *a,**k:None)
    monkeypatch.setattr(mod.SimplePipelineAdapter,'_preflight_llm',lambda *a:None)
    monkeypatch.setattr(mod.SimplePipelineAdapter,'_prompt_files',lambda *a:{})
    monkeypatch.setattr('backend.services.data_sync_service.DataSyncService.sync_project_from_filesystem',lambda *a:{'success':True})
    async def no_lyrics(*args):
        if mode=='error':raise SpeechRecognitionError('没有识别到歌词')
        return None
    observed=[]
    def fast(self,srt_path,metadata_dir,**kwargs):
        observed.append(Path(srt_path).read_text(encoding='utf-8'))
        assert '本地 CPU 音频模型' in selection_prompt('')
        return [{'id':'1','generated_title':'待试听的演唱候选','final_score':.9}]
    monkeypatch.setattr(mod.SimplePipelineAdapter,'_generate_subtitle_automatically',no_lyrics)
    monkeypatch.setattr(mod.SimplePipelineAdapter,'_find_clips_in_one_pass',fast)
    singing.atomic_json(singing.report_path('p1'),report(source).model_dump())
    with singing.project_context('p1'):
        result=asyncio.run(mod.SimplePipelineAdapter('p1','t').process_project_sync(str(source),None,clips_only=True))
    assert result['status']=='succeeded',result
    assert observed and '非歌词' in observed[0]
