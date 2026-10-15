"""Long audio regressions: chunk ownership, global voices, resume and real cancellation."""
from pathlib import Path
import json
import subprocess
import sys
import time

import pytest

from backend.tests.test_studio import root, source, client  # noqa: F401


def test_no_ten_minute_limit_in_app_status():
    from backend.services.speaker_integration import status
    assert status()['max_duration_seconds'] is None


def test_no_two_hour_limit_in_singing_contract():
    from backend.services.singing_detection import Report
    assert Report(status='completed',duration=8716.466).duration>7200


def test_chunk_ownership_covers_long_video_once_with_bounded_memory():
    from backend.services.long_audio import chunks
    parts=list(chunks(8716466))
    assert len(parts)==49 and parts[0]['owned_start_ms']==0 and parts[-1]['owned_end_ms']==8716466
    assert all(a['owned_end_ms']==b['owned_start_ms'] for a,b in zip(parts,parts[1:]))
    assert all(0 < p['end_ms']-p['start_ms']<=188000 for p in parts)


def test_long_probe_accepts_finite_duration_and_rejects_missing_audio(monkeypatch):
    from backend.services.long_audio import probe
    value={'format':{'duration':'8716.466313','start_time':'1.4'},'streams':[{'codec_type':'video'},{'codec_type':'audio'}]}
    monkeypatch.setattr('backend.core.project_cancellation.run',lambda *a,**k:subprocess.CompletedProcess(a[0],0,json.dumps(value),''))
    assert probe('source.flv')=={'duration_ms':8716466,'video_start_seconds':1.4}
    value['streams'].pop()
    with pytest.raises(ValueError,match='音轨'):probe('source.flv')


def test_resume_only_valid_chunks_and_configuration_changes_invalidate(tmp_path,monkeypatch):
    from backend.services import long_audio as audio
    video=tmp_path/'source.mp4';video.write_bytes(b'synthetic')
    folder=tmp_path/'cache';folder.mkdir()
    calls=[]
    monkeypatch.setattr(audio,'extract',lambda video,path,*a:path.write_bytes(b'audio'))
    def infer(audio,path,part):
        calls.append(part['index'])
        if part['index']==1 and len(calls)==2:raise ValueError('synthetic failure')
        return {'chunk':part['index']}
    validate=lambda value,part:value if value.get('chunk')==part['index'] else (_ for _ in ()).throw(ValueError('bad'))
    key=audio.identity(video,{'prompt':'A'})
    with pytest.raises(ValueError,match='synthetic failure'):
        audio.process_chunks(video,{'duration_ms':400000},folder,key,infer,validate)
    first=(folder/'chunk-00000.json').read_bytes()
    progress=[]
    result=audio.process_chunks(video,{'duration_ms':400000},folder,key,infer,validate,lambda *a:progress.append(a))
    assert calls==[0,1,1,2] and len(result)==3 and (folder/'chunk-00000.json').read_bytes()==first
    assert progress[-1]==(3,3,1)
    (folder/'chunk-00001.json').write_text('{broken')
    audio.process_chunks(video,{'duration_ms':400000},folder,key,infer,validate)
    assert calls[-1]==1
    assert audio.identity(video,{'prompt':'B'})!=key


def test_global_voices_do_not_swap_when_chunk_local_ids_swap():
    from backend.services.long_speaker import combine
    a,b=[1.,0.],[0.,1.]
    def value(vectors,texts):
        return {'duration_ms':10000,'windows':[{'owned_start_ms':0,'owned_end_ms':5000},{'owned_start_ms':5000,'owned_end_ms':10000}],
                'embeddings':vectors,'subtitles':[{'id':str(i),'start_ms':i*5000,'end_ms':(i+1)*5000,'text':text} for i,text in enumerate(texts)]}
    parts=[({'start_ms':0,'owned_start_ms':0,'owned_end_ms':10000},value([a,b],['A','B'])),
           ({'start_ms':10000,'owned_start_ms':10000,'owned_end_ms':20000},value([b,a],['B again','A again']))]
    doc=combine(parts,20000)
    assert [c.speaker_id for c in doc.subtitles]==['spk_0','spk_1','spk_1','spk_0']
    assert [c.start_ms for c in doc.subtitles]==[0,5000,10000,15000]


def test_global_cluster_scales_beyond_original_400_without_forced_split():
    from backend.services.long_speaker import global_labels
    assert set(global_labels([[1.,.01]]*1001))=={'spk_0'}
    labels=global_labels([[1.,0.] if i%2==0 else [0.,1.] for i in range(1001)])
    assert labels[0]==labels[1000] and labels[1]!=labels[0]


def test_overlap_cues_are_kept_once_and_existing_overlaps_preserved():
    from backend.services.long_speaker import combine
    from backend.services.speaker_subtitles import Cue
    parts=[({'start_ms':0,'owned_start_ms':0,'owned_end_ms':10000},{'windows':[],'embeddings':[],
             'subtitles':[{'id':'a','start_ms':9500,'end_ms':10500,'text':'跨段一句'}]}),
           ({'start_ms':6000,'owned_start_ms':10000,'owned_end_ms':20000},{'windows':[],'embeddings':[],
             'subtitles':[{'id':'b','start_ms':3500,'end_ms':4500,'text':'跨段一句'}]})]
    doc=combine(parts,20000)
    assert len(doc.subtitles)==1 and doc.subtitles[0].start_ms==9500
    original=[Cue(id='x',start_ms=9500,end_ms=10500,text='原句',layer=1),Cue(id='y',start_ms=9600,end_ms=10400,text='重叠')]
    doc=combine(parts,20000,original)
    assert len(doc.subtitles)==2 and doc.subtitles[0].layer==1


def test_invalid_checkpoint_embeddings_or_times_never_reused():
    from backend.services.long_speaker import validate_chunk
    part={'start_ms':0,'end_ms':1000}
    for value in [dict(duration_ms=1000,windows=[],embeddings=[[1]],subtitles=[]),
                  dict(duration_ms=1000,windows=[{'start_ms':0,'owned_start_ms':0,'owned_end_ms':1001,'end_ms':1001}],embeddings=[[1]],subtitles=[])]:
        with pytest.raises(ValueError):validate_chunk(value,part)


def test_cancellation_stops_actual_child_and_keeps_completed_chunks(root):
    from backend.services.long_audio import run_child
    from backend.core import project_cancellation as cancel
    from threading import Thread
    def stopper():
        time.sleep(.6);cancel.stop('p1')
    thread=Thread(target=stopper);thread.start()
    with cancel.bind('p1'):
        started=time.monotonic()
        with pytest.raises(cancel.JobStopped):
            run_child([sys.executable,'-c','import time; time.sleep(30)'],env=None,log=root/'child.log',timeout=60)
        assert time.monotonic()-started<5
    thread.join()


def test_pause_endpoint_marks_queued_job(client):
    from backend.services.speaker_integration import atomic_json,job_path
    atomic_json(job_path('p1'),{'job_id':'test-job','status':'queued'})
    from backend.services import speaker_integration as integration
    integration._active.add('test-job')
    try:
        assert client.post('/studio/p1/speaker-subtitles/cancel').status_code==200
        marker=json.loads(job_path('p1').with_name('speaker_stop.json').read_text(encoding='utf-8'))
        assert marker['job_id']=='test-job'
    finally:integration._active.discard('test-job')


def test_real_ffmpeg_chunk_extraction_pads_delayed_audio_and_offsets(root,source):
    import wave
    from backend.services.long_audio import probe,extract
    media=probe(source)
    path=root/'piece.wav'
    extract(source,path,{'start_ms':1000,'end_ms':2000},media)
    with wave.open(str(path),'rb') as audio:
        assert audio.getnframes()==16000 and audio.getframerate()==16000


def test_singing_chunks_merge_in_global_timeline(tmp_path,monkeypatch):
    from backend.services import long_singing as singing
    from backend.services import long_audio as audio
    monkeypatch.setattr(audio,'probe',lambda _: {'duration_ms':8716466})
    monkeypatch.setattr(audio,'identity',lambda *a:'key')
    monkeypatch.setattr(audio,'cache_directory',lambda *a:tmp_path)
    monkeypatch.setattr(audio,'process_chunks',lambda *a:[
        ({'start_ms':0,'owned_start_ms':0,'owned_end_ms':180000},{'windows':[{'start':170,'end':180,'singing':.9,'music':.9,'speech':.1}]}),
        ({'start_ms':176000,'owned_start_ms':180000,'owned_end_ms':360000},{'windows':[{'start':4,'end':14,'singing':.8,'music':.9,'speech':.1}]})])
    report=singing.analyze(Path('unused'),tmp_path,None)
    assert report.duration==8716.466 and len(report.segments)==1 and report.segments[0].start==169 and report.segments[0].end==191


@pytest.mark.parametrize('value',[None,[],{'status':'failed','duration':1,'windows':[]},{'status':'completed','duration':1,'windows':[None]}])
def test_bad_singing_cache_is_rejected_for_refetch(value):
    from backend.services.long_singing import validate_chunk
    with pytest.raises(ValueError):validate_chunk(value,{'start_ms':0,'end_ms':1000})


def test_real_extraction_keeps_delayed_audio_on_video_clock(root):
    import wave
    import struct
    from backend.utils.ffmpeg_utils import get_ffmpeg_path
    from backend.services.long_audio import probe,extract
    video=root/'delayed.mkv'
    subprocess.run([get_ffmpeg_path(),'-nostdin','-v','error','-y','-f','lavfi','-i','color=size=32x32:rate=10:duration=5',
                    '-itsoffset','2','-f','lavfi','-i','sine=frequency=1000:sample_rate=16000:duration=3',
                    '-c:v','libx264','-c:a','pcm_s16le',str(video)],check=True,timeout=30)
    output=root/'delayed.wav'
    extract(video,output,{'start_ms':1000,'end_ms':4000},probe(video))
    with wave.open(str(output),'rb') as audio:
        samples=struct.unpack('<'+'h'*audio.getnframes(),audio.readframes(audio.getnframes()))
    assert max(map(abs,samples[:12000]))<10
    assert max(map(abs,samples[20000:]))>100


def test_pause_request_records_resumable_state_without_erasing_drafts(client,monkeypatch):
    from backend.services.studio import jobs,store
    from backend.services.studio.models import Draft,Scene
    original=store.save_draft('p1',Draft(id='keep',title='Preserved',scenes=[Scene(id='s',start=0,end=2)]),create=True)
    store.change('p1',lambda data:data.update(analysis={'status':'running','run_id':'queued-run','phase':'screening','instance':store.INSTANCE},generation={'auto_start':True,'status':'screening'}))
    assert client.post('/studio/p1/pause-processing').status_code==200
    reached=[]
    @jobs._tracked('screening')
    def queued(project_id):
        reached.append(True)
    queued('p1')
    state=store.read('p1')
    assert reached==[] and state['analysis']['error_code']=='cancelled'
    assert state['drafts'][0]==original
    # A new run must not inherit the preceding run's pause.
    store.change('p1',lambda data:data.update(analysis={'status':'running','run_id':'new-run','instance':store.INSTANCE}))
    queued('p1')
    assert reached==[True]
