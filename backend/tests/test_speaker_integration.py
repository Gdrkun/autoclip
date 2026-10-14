"""Project persistence, local routing and real subtitle rendering; no paid providers."""
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from backend.services import speaker_integration as integration
from backend.services.speaker_subtitles import Cue, Speaker, SpeakerDocument
from backend.services.studio import store
from backend.services.studio.models import Draft, Scene
from backend.services.speaker_ass import scene_ass, draft_ass
from backend.services.ai_model_settings import Transcription


def document():
    return SpeakerDocument(duration_ms=2000, speakers=[Speaker(speaker_id='spk_0', color='#FF91BD'),
                                                     Speaker(speaker_id='spk_1', color='#C0A5FF')],
        subtitles=[Cue(id='a', start_ms=100, end_ms=1200, text='Speaker A', speaker_id='spk_0'),
                   Cue(id='b', start_ms=500, end_ms=1500, text='Speaker B', speaker_id='spk_1')])


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv('AUTOCLIP_DATA_DIR', str(tmp_path))
    directory = store.directory('speaker-test')
    directory.mkdir(parents=True)
    return directory


def test_legacy_models_keep_original_serialized_shape():
    draft = Draft(id='d1', title='Legacy', scenes=[Scene(id='s1', start=0, end=2)])
    assert 'speaker_subtitles' not in draft.model_dump()
    assert 'speaker_colors' not in draft.model_dump()
    selection = Transcription(provider='whisper_local', model='base')
    assert 'speaker_diarization' not in selection.model_dump()
    assert 'initial_prompt' not in selection.model_dump()


def test_source_sidecar_hydrates_drafts_and_edits_survive_reload(project):
    integration.atomic_json(integration.sidecar('speaker-test'), document().model_dump())
    first = store.save_draft('speaker-test', Draft(id='d1', title='Caption', scenes=[Scene(id='s1', start=0, end=2)]), create=True)
    loaded = Draft.model_validate(store.read('speaker-test')['drafts'][0])
    assert loaded.speaker_subtitles.speakers[0].color == '#FF91BD'
    changed = loaded.speaker_subtitles.model_copy(deep=True)
    changed.speakers[0].display_name = '心宜'
    changed.subtitles[0].text = '校对字幕'
    changed.subtitles[0].speaker_id = 'spk_1'
    store.save_draft('speaker-test', loaded.model_copy(update={'speaker_subtitles': changed}))
    again = Draft.model_validate(store.read('speaker-test')['drafts'][0])
    assert again.speaker_subtitles.speakers[0].display_name == '心宜'
    assert again.speaker_subtitles.subtitles[0].text == '校对字幕'
    assert again.speaker_subtitles.subtitles[0].speaker_id == 'spk_1'
    assert first['revision'] == 1


def test_disabled_and_corrupt_speaker_sidecars_preserve_legacy_mode(project):
    path = integration.sidecar('speaker-test')
    path.parent.mkdir(exist_ok=True)
    path.write_text('{broken', encoding='utf-8')
    assert integration.load_document('speaker-test') is None
    integration.atomic_json(path, document().model_dump())
    draft = Draft(id='d1', title='Off', scenes=[Scene(id='s1', start=0, end=2)], speaker_colors=False)
    assert integration.hydrate('speaker-test', draft).speaker_subtitles is None
    store.save_draft('speaker-test', draft, create=True)
    assert not store.read('speaker-test')['drafts'][0].get('speaker_subtitles')


def test_ass_colors_overlap_and_reordered_source_scene_mapping():
    doc = document()
    scene = Scene(id='s1', start=.3, end=1.3)
    ass = scene_ass(doc, scene, 320, 180)
    assert '&HBD91FF&' in ass and '&HFFA5C0&' in ass
    assert 'Dialogue: 0,0:00:00.00,0:00:00.90' in ass
    assert 'Dialogue: 1,0:00:00.20,0:00:01.00' in ass
    assert '\\pos(160,162)' in ass and '\\pos(160,140)' in ass
    complete = draft_ass(doc, [Scene(id='later', start=1, end=2), Scene(id='earlier', start=0, end=1)])
    assert '0:00:01.10' in complete  # second scene's source 0.1 maps to output 1.1


def test_enabled_local_transcription_dispatches_without_legacy_or_cloud(monkeypatch, tmp_path):
    from backend.services import ai_model_settings
    from backend.utils import speech_recognizer
    selection = Transcription(provider='whisper_local', model='medium', speaker_diarization=True, initial_prompt='心宜，思诺')
    monkeypatch.setattr(ai_model_settings, 'load', lambda: SimpleNamespace(transcription=selection))
    from backend.pipeline import media_precheck
    monkeypatch.setattr(media_precheck, 'has_audio', lambda *_: True)
    calls = []
    monkeypatch.setattr(integration, 'transcribe_local', lambda *args: calls.append(args) or tmp_path / 'captions.srt')
    monkeypatch.setattr(speech_recognizer, 'SpeechRecognizer', lambda: pytest.fail('Local speaker path must not reach provider fallback'))
    assert speech_recognizer.generate_subtitle_for_video(tmp_path / 'video.mp4') == tmp_path / 'captions.srt'
    assert calls[0][2].initial_prompt == '心宜，思诺'


def test_whisper_is_cpu_int8_and_local_only(monkeypatch, tmp_path):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
    from speaker_whisper import transcribe
    for name in ('model.bin', 'config.json', 'tokenizer.json'):
        (tmp_path / name).write_bytes(b'fixture')
    observed = {}
    class Model:
        def __init__(self, path, **kwargs):
            observed.update(kwargs)
        def transcribe(self, samples, **kwargs):
            observed['options'] = kwargs
            return iter([SimpleNamespace(start=.1, end=1.1, text=' 识别文本 ')]), None
    monkeypatch.setitem(sys.modules, 'faster_whisper', SimpleNamespace(WhisperModel=Model))
    cues, raw = transcribe([], tmp_path, 2000, 'zh', 4, '心宜')
    assert observed['device'] == 'cpu' and observed['compute_type'] == 'int8' and observed['local_files_only']
    assert observed['options']['initial_prompt'] == '心宜'
    assert observed['options']['vad_filter'] is False
    assert cues[0].text == '识别文本' and cues[0].start_ms == 100
    assert raw[0]['text'] == ' 识别文本 '


def test_real_studio_export_burns_two_colors_and_keeps_audio(project, monkeypatch):
    from backend.services.studio import render
    video = project / 'source.mp4'
    generated = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
        'color=c=blue:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
        '-shortest', '-c:v', 'libx264', '-c:a', 'aac', str(video)], capture_output=True, timeout=30)
    assert generated.returncode == 0
    monkeypatch.setattr(render, 'text_json', lambda *_: pytest.fail('Color edits must not call a paid model'))
    draft = Draft(id='d1', title='Two colors', scenes=[Scene(id='s1', start=0, end=2)], speaker_subtitles=document())
    render.render_draft('speaker-test', video, draft, 'speaker-render', lambda *_: None)
    output = project / 'output/studio/speaker-render.mp4'
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', str(output)]))
    assert {'video', 'audio'} <= {s['codec_type'] for s in info['streams']}
    assert float(info['format']['duration']) == pytest.approx(2, abs=.1)
    frame = project / 'frame.png'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-ss', '0.8', '-i', str(output), '-frames:v', '1', str(frame)], check=True, timeout=30)
    from PIL import Image
    pixels = list(Image.open(frame).convert('RGB').getdata())
    assert sum(r > 190 and 70 < g < 195 and 115 < b < 235 for r, g, b in pixels) > 3
    assert sum(130 < r < 235 and 95 < g < 210 and b > 210 for r, g, b in pixels) > 3


def test_whisper_word_times_split_a_segment_at_speaker_change(monkeypatch, tmp_path):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'services'))
    from speaker_whisper import transcribe
    from backend.services.speaker_subtitles import Turn
    for name in ('model.bin', 'config.json', 'tokenizer.json'):
        (tmp_path / name).write_bytes(b'fixture')
    words = [SimpleNamespace(word='你好', start=.1, end=.8), SimpleNamespace(word='世界', start=1.2, end=1.8)]
    class Model:
        def __init__(self, *args, **kwargs):
            pass
        def transcribe(self, *args, **kwargs):
            return iter([SimpleNamespace(start=.1, end=1.8, text='你好世界', words=words)]), None
    monkeypatch.setitem(sys.modules, 'faster_whisper', SimpleNamespace(WhisperModel=Model))
    cues, _ = transcribe([], tmp_path, 2000, 'zh', 4, turns=[Turn(start_ms=0, end_ms=1000, speaker_id='spk_0'),
                                                         Turn(start_ms=1000, end_ms=2000, speaker_id='spk_1')])
    assert [(c.start_ms, c.end_ms, c.text) for c in cues] == [(100, 800, '你好'), (1200, 1800, '世界')]


def test_restarted_recognition_keeps_previous_document(project):
    original = document().model_dump()
    integration.atomic_json(integration.sidecar('speaker-test'), original)
    integration.atomic_json(integration.job_path('speaker-test'), {'job_id': 'old-job', 'status': 'running'})
    state = integration.job_state('speaker-test')
    assert state['status'] == 'failed'
    assert integration.load_document('speaker-test').model_dump() == original
