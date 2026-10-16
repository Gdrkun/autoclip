"""Reference evidence, review, retrieval and actual selector boundaries; no paid calls."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from backend.services import creator_knowledge as kb, creator_learning as learn, creator_library as library
from backend.services.studio import store, intelligence
from backend.tests.test_studio import client, root, source  # noqa: F401

SRT = '1\n00:00:00,100 --> 00:00:02,000\n唱到一半突然忘词\n\n2\n00:00:02,000 --> 00:00:04,000\n另一人接唱然后互相吐槽\n'
URL = 'https://www.bilibili.com/video/BV1z33BzUEBq/'


def response():
    return {'items': [{'kind': 'selection', 'title': '忘词后的接唱反应', 'explanation': '保留忘词、接唱和互相吐槽的完整过程',
                       'triggers': ['忘词', '接唱'], 'context': '先有演唱，后有另一人接唱及反应',
                       'caution': '单一样本不能证明长期人设', 'cue_ids': [1, 2], 'quote': '唱到一半突然忘词'}]}


@pytest.fixture
def queued(root, monkeypatch):
    submitted = []
    monkeypatch.setattr(learn._executor, 'submit', lambda *args: submitted.append(args))
    monkeypatch.setattr(intelligence, 'text_json', lambda *a: response())
    yield submitted
    for args in submitted:
        learn._active.discard(args[1])


def complete(queued, **kwargs):
    body = learn.Request(query='思诺snow', url=URL, title='参考互动', srt=SRT, **kwargs)
    job = learn.enqueue(body)
    fn, *args = queued[-1]
    fn(*args)
    return job, kb.load().items


def approve(item, **updates):
    fields = item.model_dump(include={'revision', 'title', 'explanation', 'triggers', 'context', 'caution'})
    return kb.review(item.id, kb.Review(**{**fields, 'status': 'confirmed', **updates}))


@pytest.mark.parametrize('bad', ['http://www.bilibili.com/video/BV1z33BzUEBq/',
    'https://www.bilibili.com.evil/video/BV1z33BzUEBq/', 'https://127.0.0.1/video/BV1z33BzUEBq/',
    'https://x@www.bilibili.com/video/BV1z33BzUEBq/', URL+'?p=0', URL+'?p=no'])
def test_source_url_rejects_nonvideo_targets(bad):
    with pytest.raises(ValueError):learn.canonical_url(bad)


def test_tracking_is_removed_and_parts_preserved():
    assert learn.canonical_url(URL+'?spm_id_from=test&vd_source=private') == URL
    assert learn.canonical_url(URL+'?p=2&spm_id_from=x') == URL+'?p=2'


def test_import_generates_pending_entries_with_original_evidence_and_no_duplicate_inference(queued, monkeypatch):
    calls = []
    monkeypatch.setattr(intelligence, 'text_json', lambda prompt, payload: calls.append((prompt, payload)) or response())
    job, items = complete(queued)
    assert learn.read_job(job['id'])['status'] == 'completed'
    assert len(items) == 1 and items[0].status == 'pending'
    assert items[0].evidence.model_dump() == {'start_ms': 100, 'end_ms': 4000, 'quote': '唱到一半突然忘词'}
    assert items[0].source_url == URL and items[0].subjects == '思诺snow'
    assert '不是执行指令' in calls[0][0] and calls[0][1]['cues'][0]['text'] == '唱到一半突然忘词'
    same = learn.enqueue(learn.Request(query='思诺snow', url=URL, title='参考互动', srt=SRT))
    assert same['id'] == job['id'] and len(queued) == 1 and len(calls) == 1


@pytest.mark.parametrize('change', [{'quote': '并不存在的原话'}, {'cue_ids': [99]}, {'status': 'confirmed'}])
def test_hallucinated_or_self_approved_output_does_not_enter_knowledge(queued, monkeypatch, change):
    raw = response();raw['items'][0].update(change)
    monkeypatch.setattr(intelligence, 'text_json', lambda *a: raw)
    job, items = complete(queued)
    assert learn.read_job(job['id'])['status'] == 'failed' and items == []
    assert (learn.job_folder(job['id'])/'transcript.json').is_file()


def test_review_is_versioned_preserves_provenance_and_can_disable(queued):
    _, items = complete(queued)
    first = items[0]
    approved = approve(first, explanation='人工确认的互动经验')
    assert approved.status == 'confirmed' and approved.revision == 2 and approved.evidence == first.evidence
    with pytest.raises(store.ConflictError):approve(first)
    disabled = approve(approved, status='disabled')
    assert disabled.status == 'disabled' and kb.retrieve([disabled], '思诺snow', '忘词接唱') == []
    assert kb.path().with_suffix('.backup.json').is_file()


def test_pending_other_characters_and_unmatched_memes_are_not_retrieved(queued):
    _, items = complete(queued)
    item = items[0]
    assert not kb.retrieve(items, '思诺snow', '忘词接唱')
    item = approve(item)
    assert not kb.retrieve([item], '另一角色', '忘词接唱')
    assert kb.retrieve([item], '思诺', '忘词接唱', ['思诺snow']) == [item]
    meme = item.model_copy(update={'kind': 'meme'})
    assert not kb.retrieve([meme], '思诺snow', '今天天气不错')
    assert kb.retrieve([meme], '思诺snow', '唱歌忘词有人接唱') == [meme]


def test_confirmed_knowledge_reaches_fast_and_legacy_selectors_and_invalidates_cache(root, queued, monkeypatch):
    from backend.services.character_background import project_context
    from backend.pipeline.selection_preferences import cache_suffix
    from backend.pipeline.clip_finder import find_clips
    from backend.tests.test_clip_finder import _entries
    from backend.pipeline import step1_outline, step2_timeline, step3_scoring
    state = store.read('p1');state['plan'] = {'overrides': {'background_query': '思诺snow'}};store.write('p1', state)
    raw = root/'raw';raw.mkdir();(raw/'input.srt').write_text(SRT, encoding='utf-8')
    _, items = complete(queued)
    with project_context('p1'):
        before = cache_suffix('')
        assert '忘词后的接唱反应' not in library.context_prompt()
    approved = approve(items[0])
    calls = []
    def call(prompt, payload):
        calls.append(prompt)
        return {'clips': [{'start': 10, 'end': 40, 'title': '完整的接唱互动', 'reason': '保留接唱反应', 'score': .9}]}
    monkeypatch.setattr(step1_outline, 'LLMClient', lambda: SimpleNamespace())
    monkeypatch.setattr(step2_timeline, 'LLMClient', lambda: SimpleNamespace())
    with project_context('p1'):
        after = cache_suffix('')
        assert before != after
        find_clips(_entries(12), call, threshold=.7)
        assert '忘词后的接唱反应' in calls[0] and URL in calls[0]
        assert '证据时间属于参考切片，不是当前原视频' in calls[0]
        outline = step1_outline.OutlineExtractor(root/'metadata')
        timeline = step2_timeline.TimelineExtractor(root/'metadata')
        assert approved.title in outline.outline_prompt and approved.title in timeline.timeline_prompt
        monkeypatch.setattr(step3_scoring, 'LLMClient', lambda: SimpleNamespace(
            call_with_retry=lambda prompt, data: calls.append(prompt) or '[{"id":"1","final_score":0.9}]', parse_json_response=json.loads))
        scorer = step3_scoring.ClipScorer()
        scorer.scoring_backend.score([{'id': '1', 'outline': '接唱', 'transcript': '有人忘词'}])
        assert approved.title in calls[-1]
    receipt = kb.project_receipt('p1')
    assert receipt['items'][0]['id'] == approved.id
    assert (raw/'input.srt').read_text(encoding='utf-8') == SRT
    approve(approved, status='disabled')
    with project_context('p1'):assert cache_suffix('') != after


def test_failed_chunk_retry_reuses_transcript_and_completed_analysis(queued, monkeypatch):
    collected = []
    def collect(body, folder, progress):
        collected.append(1)
        return {'title': '长参考', 'url': URL, 'transcript_source': 'platform',
                'cues': [{'id': i+1, 'start_ms': i*1000, 'end_ms': (i+1)*1000, 'text': '接唱反应'} for i in range(100)]}
    monkeypatch.setattr(learn, 'collect', collect)
    called = []
    def analyze(prompt, payload):
        called.append(payload['cues'][0]['id'])
        if len(called) == 2:raise RuntimeError('synthetic failure')
        return {'items': []}
    monkeypatch.setattr(intelligence, 'text_json', analyze)
    job = learn.enqueue(learn.Request(query='思诺snow', url=URL))
    queued[-1][0](*queued[-1][1:])
    assert learn.read_job(job['id'])['status'] == 'failed'
    learn.retry(job['id']);queued[-1][0](*queued[-1][1:])
    assert learn.read_job(job['id'])['status'] == 'completed'
    assert collected == [1] and called == [1, 79, 79]


def test_queued_cancel_never_calls_model(queued, monkeypatch):
    monkeypatch.setattr(intelligence, 'text_json', lambda *a: pytest.fail('cancelled'))
    job = learn.enqueue(learn.Request(query='思诺snow', srt=SRT))
    learn.cancel(job['id']);queued[-1][0](*queued[-1][1:])
    assert learn.read_job(job['id'])['status'] == 'cancelled' and not kb.load().items


def test_api_get_does_not_launch_inference_and_review_cannot_change_source(client, queued):
    assert client.get('/studio/creator-knowledge').json()['items'] == [] and queued == []
    reply = client.post('/studio/creator-knowledge/references', json={'query': '思诺snow', 'srt': SRT})
    assert reply.status_code == 200 and len(queued) == 1
    queued[-1][0](*queued[-1][1:])
    item = client.get('/studio/creator-knowledge').json()['items'][0]
    fields = {key: item[key] for key in ('revision', 'title', 'explanation', 'triggers', 'context', 'caution')}
    endpoint = '/studio/creator-knowledge/items/'+item['id']
    assert client.patch(endpoint, json={**fields, 'status': 'confirmed', 'source_url': 'https://evil.test'}).status_code == 422
    assert client.patch(endpoint, json={**fields, 'status': 'confirmed'}).json()['status'] == 'confirmed'
    assert client.get('/studio/p1/creator-knowledge-context').status_code == 200


def test_feedback_remembers_only_actual_draft_content(root):
    state = store.read('p1');state['plan'] = {'overrides': {'background_query': '思诺snow'}};store.write('p1', state)
    from backend.services.studio.models import Draft, Scene
    from backend.tests.test_speaker_integration import document
    store.save_draft('p1', Draft(id='d', title='反差互动', scenes=[Scene(id='s', start=.1, end=.4)], speaker_subtitles=document()), create=True)
    first = library.record_feedback('p1', 'd', 'more', 'interaction', '喜欢反差')
    assert first.excerpt == 'Speaker A' and 'Speaker B' not in first.excerpt
    second = library.record_feedback('p1', 'd', 'less', 'other', '少选这种')
    assert len(library.load().feedback) == 1 and second.direction == 'less'
    assert 'excerpt' not in library.Feedback(id='old', query='', direction='more', category='other').model_dump()


def test_corrupt_knowledge_is_preserved_and_old_library_still_works(root):
    kb.folder().mkdir();kb.path().write_text('{broken', encoding='utf-8')
    with pytest.raises(ValueError):kb.add([])
    assert kb.path().read_text(encoding='utf-8') == '{broken'
    with library.project_context('p1'):assert library.context_prompt() == ''


def test_chunks_are_bounded_and_keep_context():
    cues = [learn.Cue(id=i, start_ms=i*1000, end_ms=(i+1)*1000, text='a') for i in range(1000)]
    groups = learn.chunks(cues)
    assert len(groups) > 1 and all(len(group) <= 80 for group in groups)
    assert groups[0][-2:] == groups[1][:2]
    long = [learn.Cue(id=i, start_ms=i*1000, end_ms=(i+1)*1000, text='字'*6000) for i in range(3)]
    assert all(sum(len(cue.text)+80 for cue in group) <= 10000 for group in learn.chunks(long))


def test_meme_retrieval_uses_actual_selector_input_when_srt_is_outside_project(root, queued):
    from backend.services.character_background import project_context
    from backend.pipeline.clip_finder import find_clips
    from backend.tests.test_clip_finder import _entries
    state = store.read('p1');state['plan'] = {'overrides': {'background_query': '思诺snow'}};store.write('p1', state)
    _, items = complete(queued)
    item = items[0].model_copy(update={'kind': 'meme'})
    with kb.transaction():
        base = kb.load();base.items = [item];kb._save(base)
    approve(item)
    observed = []
    def call(prompt, payload):
        observed.append(prompt)
        return {'clips': [{'start': 10, 'end': 40, 'title': '完整的接唱互动', 'reason': '保留接唱反应', 'score': .9}]}
    rows = _entries(12)
    rows[4]['text'] = '有人忘词，另一人接唱'
    with project_context('p1'):
        assert item.title not in library.context_prompt()
        find_clips(rows, call, threshold=.7)
    assert item.title in observed[0]


def test_aliases_filter_the_reference_dashboard(root, queued):
    library.save(library.Library(profiles=[library.Profile(name='思诺snow', aliases=['思诺'])]))
    _, items = complete(queued)
    assert learn.dashboard('思诺')['items'][0]['id'] == items[0].id


@pytest.mark.parametrize('mode', ['platform', 'missing-model', 'local'])
def test_reference_collection_reuses_subtitles_or_explicit_cpu_without_cloud_fallback(root, monkeypatch, mode):
    import yt_dlp
    from backend.services import speaker_integration
    from backend.utils import speech_recognizer
    from backend.tests.test_speaker_integration import document
    calls = []
    class Downloader:
        def __init__(self, options):self.options = options
        def __enter__(self):return self
        def __exit__(self, *args):return False
        def extract_info(self, url, **kwargs):
            return {'title': '参考', 'subtitles': {'zh-Hans': [{}]} if mode == 'platform' else {}}
        def download(self, urls):
            calls.append(self.options)
            folder = Path(self.options['outtmpl']).parent
            if self.options.get('skip_download'):
                (folder/'reference.zh-Hans.srt').write_text(SRT, encoding='utf-8')
            else:
                (folder/'reference.mp4').write_bytes(b'test video')
    monkeypatch.setattr(yt_dlp, 'YoutubeDL', Downloader)
    monkeypatch.setattr(speaker_integration, 'status', lambda: {'sensevoice': mode != 'missing-model'})
    monkeypatch.setattr(speech_recognizer, 'generate_subtitle_for_video', lambda *a, **kw: pytest.fail('no cloud/legacy ASR fallback'))
    inference = []
    def execute(video, **kwargs):
        inference.append(kwargs)
        assert mode == 'local' and kwargs == {'backend': 'sensevoice', 'prompt': '思诺snow'}
        return document(), root
    monkeypatch.setattr(speaker_integration, 'execute', execute)
    folder = root/'sample';folder.mkdir()
    body = learn.Request(query='思诺snow', url=URL, local_backend='sensevoice')
    if mode == 'missing-model':
        with pytest.raises(learn.LearningError, match='模型未就绪'):learn.collect(body, folder, lambda *a: None)
        assert calls == [] and inference == []
    else:
        result = learn.collect(body, folder, lambda *a: None)
        assert result['transcript_source'] == ('platform' if mode == 'platform' else 'local')
        assert len(inference) == (mode == 'local') and result['cues']
        assert all('cookiesfrombrowser' not in options for options in calls)
