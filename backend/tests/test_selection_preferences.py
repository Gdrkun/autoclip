"""Preference delivery to actual AI boundaries, fallback and stale cache isolation; no network."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from backend.tests.test_studio import client, root, source  # noqa: F401
from backend.tests.test_clips_only_project_status import db  # noqa: F401

REQUEST = '优先唱歌、搞笑、网络流行梗和迷因，少选普通闲聊；保留完整笑点。'


def test_http_import_and_actual_content_selection_keep_the_request(client, source, monkeypatch):
    from backend.services.studio import jobs
    captured = []
    monkeypatch.setattr(jobs, 'inspect_project', lambda pid, prefs, *a, **kw: captured.append((pid, prefs)))
    response = client.post('/studio/import', data={'instruction': REQUEST, 'goal':'content'},
                           files={'video': ('source.mp4', source.read_bytes(), 'video/mp4')})
    assert response.status_code == 200, response.text
    assert captured[0][1].instruction == REQUEST
    calls = []
    monkeypatch.setattr(jobs, 'run_content', lambda *args, **kwargs: calls.append(kwargs) or [
        {'generated_title':'完整互动','start_time_seconds':.2,'end_time_seconds':1.5}])
    plan = {'recommended_analysis':'subtitle','preferences':{'goal':'content'},'overrides':{'instruction':REQUEST}}
    assert jobs._content_drafts(captured[0][0], plan, source)
    assert calls == [{'instruction': REQUEST}]


def test_one_pass_retries_receive_the_complete_preference(tmp_path):
    from backend.pipeline import clip_finder
    from backend.tests.test_clip_finder import _entries
    calls = []
    def call(prompt, data):
        calls.append((prompt, dict(data)))
        if len(calls) == 1:
            return {'invalid': True}
        return {'clips': [{'start': 10, 'end': 40, 'title': '一个完整的搞笑互动', 'reason': '保留了铺垫和包袱', 'score': .9}]}
    result = clip_finder.find_clips(_entries(12), call, threshold=.7, metadata_dir=tmp_path, selection_instruction=REQUEST)
    assert result and all(REQUEST in prompt for prompt, _ in calls)
    assert all('不得只影响标题或文案' in prompt and '不编造梗' in prompt for prompt, _ in calls)
    assert 'previous_error' in calls[1][1]


def test_studio_content_task_receives_exact_text_and_explicit_empty_clears_old(monkeypatch, tmp_path):
    from backend.services.studio import jobs
    import sys
    calls = []
    task = SimpleNamespace(apply=lambda **kwargs: calls.append(kwargs['kwargs']) or SimpleNamespace(
        get=lambda: {'success': True, 'result': {'result': {'titled_clips': [{'id': '1'}]}}}))
    monkeypatch.setitem(sys.modules, 'backend.tasks.processing', SimpleNamespace(process_video_pipeline=task))
    jobs.run_content('p', tmp_path/'input.mp4', instruction=REQUEST)
    jobs.run_content('p', tmp_path/'input.mp4', instruction='')
    assert [value['selection_instruction'] for value in calls] == [REQUEST, '']
    assert all(value['clips_only'] for value in calls)


@pytest.mark.parametrize('provided', [None, REQUEST, ''])
def test_actual_task_delivers_saved_or_explicit_instruction(db, monkeypatch, provided):
    from backend.tasks import processing
    from backend.models.project import Project
    with db() as session:
        project = session.get(Project, 'p')
        project.processing_config = {'smart_import': {'instruction': '优先唱歌'}}
        session.commit()
    observed = []
    class Adapter:
        async def process_project_sync(self, video, srt, **kwargs):
            observed.append(kwargs.get('selection_instruction', ''))
            return {'status':'succeeded', 'result':{'titled_clips':[{'id':'1'}]}}
    monkeypatch.setattr('backend.services.simple_pipeline_adapter.create_simple_pipeline_adapter', lambda *a: Adapter())
    kwargs={'project_id':'p','input_video_path':'local-fixture.mp4','clips_only':True}
    if provided is not None:
        kwargs['selection_instruction']=provided
    result=processing.process_video_pipeline.apply(kwargs=kwargs).get()
    assert result['success'] is True
    assert observed == ['优先唱歌' if provided is None else provided]


@pytest.mark.parametrize('mode', ['fast', 'fallback'])
def test_adapter_keeps_preference_when_fast_selection_falls_back(tmp_path, monkeypatch, mode):
    from backend.services import simple_pipeline_adapter as mod
    from backend.pipeline import media_precheck
    monkeypatch.setenv('AUTOCLIP_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(mod, 'clear_progress', lambda *a: None)
    monkeypatch.setattr(mod, 'emit_progress', lambda *a, **kw: None)
    monkeypatch.setattr(media_precheck, 'subtitle_route_failure', lambda *a, **kw: None)
    monkeypatch.setattr(mod.SimplePipelineAdapter, '_preflight_llm', lambda *a: None)
    monkeypatch.setattr(mod.SimplePipelineAdapter, '_prompt_files', lambda *a: {})
    from backend.services.data_sync_service import DataSyncService
    monkeypatch.setattr(DataSyncService, 'sync_project_from_filesystem', lambda *a: {'success': True})
    srt = tmp_path/'input.srt'; srt.write_text('1\n00:00:00,000 --> 00:00:30,000\nTest\n')
    seen = []
    clips = [{'id': '1', 'generated_title': '完整笑点', 'final_score': .9}]
    def fast(self, *args, **kwargs):
        seen.append(('fast', kwargs['selection_instruction']))
        return clips if mode == 'fast' else None
    monkeypatch.setattr(mod.SimplePipelineAdapter, '_find_clips_in_one_pass', fast)
    for name, label in [('run_step1_outline', 'outline'), ('run_step2_timeline', 'timeline'), ('run_step3_scoring', 'scoring')]:
        def step(*args, _label=label, **kwargs):
            seen.append((_label, kwargs['selection_instruction']))
            return [{'id':'1', 'title':'topic'}]
        monkeypatch.setattr(mod, name, step)
    monkeypatch.setattr(mod, 'run_step4_title', lambda *a, **kw: clips)
    result = asyncio.run(mod.SimplePipelineAdapter('test-preference', 'task').process_project_sync(
        'input.mp4', str(srt), clips_only=True, selection_instruction=REQUEST))
    assert result['status'] == 'succeeded', result
    assert seen == [(name, REQUEST) for name in (['fast'] if mode == 'fast' else ['fast','outline','timeline','scoring'])]


def test_outline_timeline_and_scoring_prompts_all_include_preference(tmp_path, monkeypatch):
    from backend.pipeline import step1_outline, step2_timeline, step3_scoring
    from backend.core.shared_config import get_prompt_files
    calls = []
    fake = SimpleNamespace(call_with_retry=lambda prompt, data: calls.append((prompt, data)) or '[{"id":"1","outline":"topic","final_score":0.9,"recommend_reason":"命中搞笑"}]', parse_json_response=json.loads)
    monkeypatch.setattr(step1_outline, 'LLMClient', lambda: fake)
    monkeypatch.setattr(step2_timeline, 'LLMClient', lambda: fake)
    monkeypatch.setattr(step3_scoring, 'LLMClient', lambda: fake)
    prompts = get_prompt_files()
    outline = step1_outline.OutlineExtractor(tmp_path, prompts, selection_instruction=REQUEST)
    timeline = step2_timeline.TimelineExtractor(tmp_path, prompts, selection_instruction=REQUEST)
    scorer = step3_scoring.ClipScorer(prompts, metadata_dir=tmp_path, selection_instruction=REQUEST)
    assert REQUEST in outline.outline_prompt and REQUEST in timeline.timeline_prompt
    result = scorer.scoring_backend.score([{'id':'1','outline':'topic','transcript':'actual joke'}])
    assert result[0]['final_score'] == .9 and REQUEST in calls[0][0]


def test_changed_request_does_not_replay_old_timeline_cache(tmp_path, monkeypatch):
    from backend.pipeline import step2_timeline
    calls = []
    monkeypatch.setattr(step2_timeline, 'LLMClient', lambda: SimpleNamespace(
        call_with_retry=lambda prompt, data: calls.append(prompt) or 'current reply'))
    extractor = step2_timeline.TimelineExtractor(tmp_path, selection_instruction=REQUEST)
    extractor.srt_chunks_dir.mkdir(exist_ok=True)
    (extractor.srt_chunks_dir/'chunk_0.json').write_text(json.dumps([
        {'index':1,'start_time':'00:00:00,000','end_time':'00:00:30,000','text':'current material'}]))
    extractor.llm_raw_output_dir.mkdir(exist_ok=True)
    stale = extractor.llm_raw_output_dir/'chunk_0.txt'; stale.write_text('old no-preference answer')
    monkeypatch.setattr(extractor, '_parse_and_validate_response', lambda *a: [
        {'outline':'current','start_time':'00:00:00,000','end_time':'00:00:30,000','chunk_index':0}])
    extractor._last_parse_diagnostics = {}
    result = extractor.extract_timeline([{'title':'current','chunk_index':0}])
    assert result and len(calls) == 1 and REQUEST in calls[0]
    assert stale.read_text() == 'old no-preference answer'
    other = step2_timeline.TimelineExtractor(tmp_path, selection_instruction='优先唱歌')
    assert other.selection_cache_suffix != extractor.selection_cache_suffix


@pytest.mark.parametrize('value', [True, {}, 'x'*1001])
def test_invalid_preference_is_rejected_before_model_calls(value):
    from backend.pipeline.selection_preferences import normalize_instruction
    with pytest.raises(ValueError): normalize_instruction(value)


def test_empty_preference_keeps_old_prompt_and_cache_names():
    from backend.pipeline.selection_preferences import selection_prompt, cache_suffix
    assert selection_prompt('  ') == '' and cache_suffix('') == ''
