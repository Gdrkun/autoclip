"""Offline contracts and orchestration; synthetic embeddings are not model acceptance."""
import importlib.util
import json
import socket
import subprocess
import sys
from pathlib import Path
import wave

import pytest
from pydantic import ValidationError

from scripts import speaker_poc as cli
from speaker_subtitles import (Cue, Speaker, SpeakerDocument, Turn, associate_cues,
                               cluster_embeddings, embedding_windows, vad_intervals,
                               windows_to_turns, attach_punctuation)

pytestmark = pytest.mark.stdlib_only


def worker_module():
    spec = importlib.util.spec_from_file_location('speaker_worker_test', cli.SERVICES / 'speaker_worker.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cue(start=0, end=1000, **kwargs):
    return Cue(id=kwargs.pop('id', 'cue_1'), start_ms=start, end_ms=end, text=kwargs.pop('text', '测试字幕'), **kwargs)


def turn(start, end, label='spk_0'):
    return Turn(start_ms=start, end_ms=end, speaker_id=label)


def test_two_synthetic_speakers_and_stable_anonymous_ids():
    labels = cluster_embeddings([[1., 0.], [0., 1.], [1., .01], [.01, 1.]], max_speakers=2)
    assert labels == ['spk_0', 'spk_1', 'spk_0', 'spk_1']


def test_count_hint_does_not_split_single_speaker():
    assert cluster_embeddings([[1., 0.]] * 4, max_speakers=2) == ['spk_0'] * 4
    assert cluster_embeddings([]) == []
    assert cluster_embeddings([[0., 1.]]) == ['spk_0']


def test_count_cap_and_unforced_automatic_count():
    vectors = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]
    assert len(set(cluster_embeddings(vectors))) == 3
    assert len(set(cluster_embeddings(vectors, max_speakers=2))) == 2


@pytest.mark.parametrize('vectors', [[[0., 0.]], [[float('nan')]], [[float('inf')]],
                                    [[1.], [1., 0.]], [[True]], [[]], [[1e308, 1e308]]])
def test_invalid_embedding_rejected(vectors):
    with pytest.raises(ValueError):
        cluster_embeddings(vectors)


def test_vad_silence_and_frame_rounding():
    assert vad_intervals([{'value': []}], 1000) == []
    assert vad_intervals([{'value': [[0, 500], [400, 1005]]}], 1000) == [(0, 1000)]


@pytest.mark.parametrize('result', [[], [{}], [{'value': [[-1, 200]]}], [{'value': [[0, 1101]]}],
                                   [{'value': [[0, 1.5]]}], [{'value': [[0, float('nan')]]}]])
def test_vad_does_not_guess_units_or_accept_invalid_results(result):
    with pytest.raises(ValueError):
        vad_intervals(result, 1000)


def test_windows_cover_vad_without_duplicate_owned_times():
    windows = embedding_windows([(0, 8000), (10000, 12000), (13000, 13200)])
    turns = windows_to_turns(windows, ['spk_0'] * len(windows))
    assert [t.model_dump() for t in turns] == [
        {'start_ms': 0, 'end_ms': 8000, 'speaker_id': 'spk_0'},
        {'start_ms': 10000, 'end_ms': 12000, 'speaker_id': 'spk_0'}]
    assert all(w['end_ms'] - w['start_ms'] <= 3000 for w in windows)
    assert sum(t.end_ms - t.start_ms for t in turns) == 10000


def test_clear_cue_preserves_text_time_id_and_layer():
    original = cue(100, 900, text='原文\n第二行', layer=1)
    result = associate_cues([original], [turn(0, 1000)])[0]
    assert result.speaker_id == 'spk_0' and result.assignment_reason == 'matched'
    assert (result.id, result.text, result.start_ms, result.end_ms, result.layer) == (
        original.id, original.text, original.start_ms, original.end_ms, original.layer)
    assert original.speaker_id is None


def test_unknown_for_silence_low_coverage_and_turn_boundary():
    assert associate_cues([cue()], [])[0].assignment_reason == 'no_speech'
    assert associate_cues([cue()], [turn(0, 300)])[0].assignment_reason == 'insufficient_coverage'
    mixed = associate_cues([cue()], [turn(0, 500), turn(500, 1000, 'spk_1')])[0]
    assert mixed.speaker_id is None and mixed.assignment_reason == 'ambiguous'


def test_duplicate_windows_do_not_inflate_coverage():
    result = associate_cues([cue()], [turn(0, 300)] * 3)[0]
    assert result.speaker_id is None
    assert result.assignment_reason == 'insufficient_coverage'


def test_conflicting_overlapping_turns_are_unknown():
    result = associate_cues([cue()], [turn(0, 1000), turn(500, 600, 'spk_1')])[0]
    assert result.speaker_id is None and result.assignment_reason == 'ambiguous'


def test_schema_allows_manual_overlap_and_unknown_legacy_cues():
    document = SpeakerDocument(duration_ms=1000, speakers=[Speaker(speaker_id='spk_0')],
                               subtitles=[cue(), cue(id='cue_2', layer=1, speaker_id='spk_0', assignment_reason='manual')])
    assert SpeakerDocument.model_validate_json(document.model_dump_json()) == document
    assert document.subtitles[0].speaker_id is None
    assert document.speakers[0].display_name == ''


@pytest.mark.parametrize('change', [{'end_ms': 1001}, {'start_ms': 1000}, {'speaker_id': 'spk_2'},
                                   {'start_ms': .2}, {'end_ms': True}, {'layer': 2}, {'text': ' '}])
def test_schema_rejects_invalid_bounds_ids_and_units(change):
    data = cue().model_dump()
    data.update(change)
    with pytest.raises(ValidationError):
        SpeakerDocument(duration_ms=1000, subtitles=[data])


def test_schema_rejects_duplicate_ids_bad_color_and_source_timebase():
    with pytest.raises(ValidationError):
        SpeakerDocument(duration_ms=1000, subtitles=[cue(), cue()])
    with pytest.raises(ValidationError):
        Speaker(speaker_id='spk_0', color='red')
    with pytest.raises(ValidationError):
        SpeakerDocument(duration_ms=1000, time_base='source')


def test_existing_srt_keeps_multiline_and_overlap(tmp_path):
    path = tmp_path / 'input.srt'
    path.write_text('1\n00:00:00,000 --> 00:00:01,000\n第一行\n第二行\n\n2\n00:00:00,500 --> 00:00:01,000\n另一个人\n', encoding='utf-8')
    cues = cli.load_cues(path, 1000)
    assert len(cues) == 2 and cues[0].text == '第一行\n第二行'
    with pytest.raises(ValidationError):
        cli.load_cues(path, 999)


def test_raw_asr_json_requires_explicit_clip_contract(tmp_path):
    path = tmp_path / 'input.json'
    path.write_text(json.dumps([{'start': 0, 'end': 1, 'text': 'test'}]), encoding='utf-8')
    with pytest.raises(ValueError, match='units are not guessed'):
        cli.load_cues(path, 1000)


def test_model_alias_or_incomplete_directory_cannot_download(tmp_path):
    with pytest.raises(ValueError):
        worker_module().local_model(tmp_path / 'missing')
    assert cli.main(['--video', str(tmp_path / 'missing.mp4'), '--cam-model', 'cam++',
                     '--vad-model', 'fsmn-vad', '--output-dir', str(tmp_path / 'new')]) == 1
    assert not (tmp_path / 'new').exists()


def test_official_modelscope_cam_checkpoint_name_is_supported(tmp_path):
    (tmp_path / 'config.yaml').write_text('model: CAMPPlus', encoding='utf-8')
    (tmp_path / 'campplus_cn_common.bin').write_bytes(b'fixture, not weights')
    (tmp_path / 'configuration.json').write_text(json.dumps({
        'file_path_metas': {'init_param': 'campplus_cn_common.bin', 'config': 'config.yaml'}}), encoding='utf-8')
    assert worker_module().local_model(tmp_path) == tmp_path.resolve()


@pytest.mark.parametrize('checkpoint', ['../outside.bin', 'missing.bin', 42])
def test_model_checkpoint_must_be_present_inside_model_directory(tmp_path, checkpoint):
    model = tmp_path / 'model'
    model.mkdir()
    (tmp_path / 'outside.bin').write_bytes(b'outside')
    (model / 'config.yaml').write_text('model: CAMPPlus', encoding='utf-8')
    (model / 'configuration.json').write_text(json.dumps({'file_path_metas': {'init_param': checkpoint}}), encoding='utf-8')
    with pytest.raises(ValueError):
        worker_module().local_model(model)


def test_offline_guard_blocks_dns_and_connections(monkeypatch):
    for name in ('create_connection', 'getaddrinfo'):
        monkeypatch.setattr(socket, name, getattr(socket, name))
    for name in ('connect', 'connect_ex'):
        monkeypatch.setattr(socket.socket, name, getattr(socket.socket, name))
    worker_module().deny_network()
    with pytest.raises(RuntimeError, match='offline'):
        socket.getaddrinfo('example.test', 443)
    with socket.socket() as client:
        with pytest.raises(RuntimeError, match='offline'):
            client.connect(('127.0.0.1', 1))


def test_environment_isolates_credentials_and_does_not_mutate_parent(monkeypatch, tmp_path):
    monkeypatch.setenv('OPENAI_API_KEY', 'fixture-secret')
    monkeypatch.setenv('SENTRY_DSN', 'fixture-dsn')
    monkeypatch.setenv('PYTHONPATH', 'unsafe-import-path')
    env = cli.isolated_env(tmp_path)
    assert 'OPENAI_API_KEY' not in env and 'SENTRY_DSN' not in env and 'PYTHONPATH' not in env
    assert env['HF_HUB_OFFLINE'] == '1' and env['CUDA_VISIBLE_DEVICES'] == ''
    import os
    assert os.environ['OPENAI_API_KEY'] == 'fixture-secret'


def test_worker_help_under_isolated_interpreter_and_lazy_model_imports():
    result = subprocess.run([sys.executable, '-I', str(cli.SERVICES / 'speaker_worker.py'), '--help'],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0 and '--cam-model' in result.stdout


def model_directories(tmp_path):
    paths = []
    for name in ('cam', 'vad'):
        folder = tmp_path / name
        folder.mkdir()
        (folder / 'model.pt').write_bytes(b'fixture, not model weights')
        (folder / 'config.yaml').write_text('fixture', encoding='utf-8')
        paths.append(folder)
    return paths


def cli_args(tmp_path, output, cam, vad):
    video = tmp_path / 'fixture.mp4'
    video.write_bytes(b'fixture, not a video')
    return ['--video', str(video), '--cam-model', str(cam), '--vad-model', str(vad),
            '--output-dir', str(output), '--ffmpeg', sys.executable]


def test_existing_output_and_input_are_preserved(tmp_path):
    cam, vad = model_directories(tmp_path)
    output = tmp_path / 'existing'
    output.mkdir()
    saved = output / 'speaker_subtitles.json'
    saved.write_text('keep', encoding='utf-8')
    assert cli.main(cli_args(tmp_path, output, cam, vad)) == 1
    assert saved.read_text() == 'keep'
    assert (tmp_path / 'fixture.mp4').read_bytes() == b'fixture, not a video'


def test_failed_inference_records_failure_without_success_result(tmp_path, monkeypatch):
    cam, vad = model_directories(tmp_path)
    output = tmp_path / 'new'
    def failed(*args, **kwargs):
        raise TimeoutError('fixture timeout')
    monkeypatch.setattr(cli, 'run_monitored', failed)
    monkeypatch.setattr(cli, 'probe_clip', lambda *a: {'duration_ms': 1000, 'video_start_seconds': 0})
    assert cli.main(cli_args(tmp_path, output, cam, vad)) == 1
    report = json.loads((output / 'metrics.json').read_text())
    assert report['status'] == 'failed' and report['error_type'] == 'TimeoutError'
    assert not (output / 'speaker_subtitles.json').exists()
    assert not list(output.glob('audio-*'))


def test_orchestration_with_synthetic_worker_response(tmp_path, monkeypatch):
    cam, vad = model_directories(tmp_path)
    output = tmp_path / 'new'
    srt = tmp_path / 'fixture.srt'
    srt.write_text('1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n', encoding='utf-8')
    def fixture(command, **kwargs):
        if '--audio' not in command:
            with wave.open(command[-1], 'wb') as source:
                source.setparams((1, 2, 16000, 16000, 'NONE', 'not compressed'))
                source.writeframes(b'\0\0' * 16000)
        else:
            assert command[1] == '-I' and kwargs['env']['HF_HUB_OFFLINE'] == '1'
            result = {'duration_ms': 1000, 'turns': [turn(0, 1000).model_dump()], 'subtitles': [],
                      'metrics': {'device': 'cpu', 'versions': {'fixture': 'synthetic'}}}
            Path(command[command.index('--result') + 1]).write_text(json.dumps(result), encoding='utf-8')
        return {'sampled_peak_tree_rss_mib': 1, 'memory_samples': 1}
    monkeypatch.setattr(cli, 'run_monitored', fixture)
    monkeypatch.setattr(cli, 'probe_clip', lambda *a: {'duration_ms': 1000, 'video_start_seconds': 0})
    assert cli.main([*cli_args(tmp_path, output, cam, vad), '--subtitles', str(srt)]) == 0
    document = SpeakerDocument.model_validate_json((output / 'speaker_subtitles.json').read_text(encoding='utf-8'))
    assert document.subtitles[0].speaker_id == 'spk_0'
    assert document.speakers[0].display_name == ''
    report = json.loads((output / 'metrics.json').read_text())
    assert report['quality'] == 'not_evaluated' and report['overlap_separation'] is False
    assert not list(output.glob('audio-*'))


def test_real_ffmpeg_preserves_delayed_audio_on_video_timeline(tmp_path):
    import array
    import shutil
    ffmpeg, ffprobe = shutil.which('ffmpeg'), shutil.which('ffprobe')
    assert ffmpeg and ffprobe, 'Media dependencies required; do not silently skip'
    video, audio = tmp_path / 'delayed.mp4', tmp_path / 'audio.wav'
    generated = subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-y',
                                '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=25:d=2',
                                '-itsoffset', '0.4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.6',
                                '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-c:a', 'aac',
                                '-t', '2', str(video)], capture_output=True, timeout=30)
    assert generated.returncode == 0, generated.stderr.decode(errors='replace')
    env = cli.isolated_env(tmp_path / 'cache')
    media = cli.probe_clip(video, ffprobe, env)
    memory = cli.run_monitored(cli.extraction_command(ffmpeg, video, audio, media),
                               env=env, log=tmp_path / 'extract.log', timeout=30)
    assert media['duration_ms'] == 2000
    # Restricted Windows process inspection or a very short process can yield
    # no sample; null must not masquerade as a measured zero-memory process.
    if memory['memory_samples'] == 0:
        assert memory['sampled_peak_tree_rss_mib'] is None
    with wave.open(str(audio), 'rb') as source:
        assert source.getnframes() / source.getframerate() == pytest.approx(2, abs=.001)
        samples = array.array('h', source.readframes(source.getnframes()))
    def rms(values):
        return (sum(v * v for v in values) / len(values)) ** .5 / 32768
    assert rms(samples[:int(.3 * 16000)]) < .002
    assert rms(samples[int(.6 * 16000):int(1.0 * 16000)]) > .02


def test_timeout_terminates_owned_worker_when_process_inspection_is_denied(tmp_path, monkeypatch):
    import psutil
    captured = []
    original = subprocess.Popen
    def capture(*args, **kwargs):
        process = original(*args, **kwargs)
        captured.append(process)
        return process
    def denied(*args, **kwargs):
        raise psutil.AccessDenied()
    monkeypatch.setattr(cli.subprocess, 'Popen', capture)
    monkeypatch.setattr(psutil, 'Process', denied)
    with pytest.raises(TimeoutError):
        cli.run_monitored([sys.executable, '-I', '-c', 'import time; time.sleep(30)'],
                          env=cli.isolated_env(tmp_path), log=tmp_path / 'worker.log', timeout=.1)
    assert captured and captured[0].poll() is not None


def test_ctc_late_punctuation_does_not_become_a_separate_flash_caption():
    original = [cue(100, 900, text='歌词'), cue(5000, 5060, text='。', id='punctuation'),
                cue(6000, 6300, text='好', id='one_character')]
    result = attach_punctuation(original)
    assert [c.text for c in result] == ['歌词。', '好']
    assert result[0].end_ms == 900 and result[1].start_ms == 6000
    assert ''.join(c.text for c in result) == ''.join(c.text for c in original)
    assert original[0].text == '歌词'


def test_leading_or_all_punctuation_preserves_speech_and_has_no_false_speech_cue():
    assert [c.text for c in attach_punctuation([cue(text='“'), cue(1000, 2000, text='你好', id='speech')])] == ['“你好']
    assert attach_punctuation([cue(text='。')]) == []


def test_exported_srt_preserves_overlap_and_unicode(tmp_path):
    document = SpeakerDocument(duration_ms=2000, subtitles=[cue(100, 1500, text='第一行\n第二行'),
                                                          cue(900, 1900, text='另一人', id='overlap', layer=1)])
    path = tmp_path / 'subtitles.srt'
    path.write_text(cli.subtitle_srt(document), encoding='utf-8')
    loaded = cli.load_cues(path, 2000)
    assert [(c.start_ms, c.end_ms, c.text) for c in loaded] == [(c.start_ms, c.end_ms, c.text) for c in document.subtitles]
