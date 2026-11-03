"""Exercise stale-editor saves against real local persistence, without remote calls."""
import json
from copy import deepcopy

import pytest

from backend.services import creator_library as lib
from backend.tests.test_studio import client, root, source  # noqa: F401


def initial():
    return lib.save(lib.Library(profiles=[lib.Profile(id='a', name='角色甲', background='原背景'),
                                          lib.Profile(id='b', name='角色乙')]))


def test_merge_unrelated_profile_updates_keeps_new_feedback(root):
    base = initial()
    edited = base.model_copy(deep=True)
    edited.profiles[0].background = '本页修订'
    other = base.model_copy(deep=True)
    other.profiles[1].memes = '另一页补充'
    other.feedback.append(lib.Feedback(id='f1', query='', direction='more', category='humor', title='新记忆'))
    lib.save(other)
    saved = lib.apply_changes(lib.Changes(base=base, draft=edited))
    assert [profile.background for profile in saved.profiles] == ['本页修订', '']
    assert saved.profiles[1].memes == '另一页补充'
    assert saved.feedback[0].title == '新记忆'
    assert saved.revision == 3


def test_different_fields_of_same_profile_merge_and_timestamps_are_server_owned(root):
    base = initial()
    local = base.model_copy(deep=True); local.profiles[0].background = '本地背景'
    remote = base.model_copy(deep=True); remote.profiles[0].memes = '远端梗'; lib.save(remote)
    saved = lib.apply_changes(lib.Changes(base=base, draft=local))
    assert saved.profiles[0].background == '本地背景' and saved.profiles[0].memes == '远端梗'
    assert saved.updated_at and saved.profiles[0].updated_at
    assert saved.profiles[1].updated_at == base.profiles[1].updated_at
    assert lib.load() == saved


def test_overlapping_field_conflict_is_actionable_and_never_changes_files(client):
    base = initial().model_dump()
    local = deepcopy(base); local['profiles'][0]['background'] = '我的校对'
    remote = deepcopy(base); remote['profiles'][0]['background'] = '另一页校对'
    lib.save(lib.Library.model_validate(remote))
    before = lib.path().read_bytes()
    response = client.post('/studio/creator-library/changes', json={'base': base, 'draft': local})
    assert response.status_code == 409
    detail = response.json()['detail']
    assert detail['code'] == 'creator_library_conflict'
    assert detail['conflicts'] == [{'section': 'profiles', 'id': 'a', 'field': 'background'}]
    assert detail['current']['profiles'][0]['background'] == '另一页校对'
    assert lib.path().read_bytes() == before
    # An explicit resolution still uses the latest baseline, never a forced overwrite.
    resolved = deepcopy(detail['current']); resolved['profiles'][0]['background'] = '我的校对'
    assert client.post('/studio/creator-library/changes', json={'base': detail['current'], 'draft': resolved}).status_code == 200


def test_deletion_conflicts_with_new_edits_but_unrelated_new_profiles_survive(root):
    base = initial()
    local = base.model_copy(deep=True); local.profiles = local.profiles[1:]
    remote = base.model_copy(deep=True); remote.profiles[0].memes = '尚未看过的修订'; lib.save(remote)
    with pytest.raises(lib.MergeConflict): lib.apply_changes(lib.Changes(base=base, draft=local))
    assert len(lib.load().profiles) == 2
    latest = lib.load(); local = latest.model_copy(deep=True); local.profiles = local.profiles[1:]
    new = latest.model_copy(deep=True); new.profiles.append(lib.Profile(id='c', name='新角色')); lib.save(new)
    saved = lib.apply_changes(lib.Changes(base=latest, draft=local))
    assert [profile.id for profile in saved.profiles] == ['b', 'c']


def test_duplicate_alias_and_concurrent_vocabulary_never_silently_overwrite(client):
    base = initial().model_dump()
    local = deepcopy(base); local['terms'] = [{'correct': '心宜', 'variants': ['心仪'], 'scope': ''}]
    remote = deepcopy(base); remote['terms'] = [{'correct': '思诺', 'variants': ['斯诺'], 'scope': ''}]
    lib.save(lib.Library.model_validate(remote))
    assert client.post('/studio/creator-library/changes', json={'base': base, 'draft': local}).status_code == 409
    local = deepcopy(base); local['profiles'][0]['aliases'] = ['角色乙']
    assert client.post('/studio/creator-library/changes', json={'base': base, 'draft': local}).status_code == 422


def test_legacy_data_stays_readable_and_failed_save_preserves_last_saved_copy(root, monkeypatch):
    lib.path().write_text(json.dumps({'schema_version': 1, 'revision': 4, 'profiles': [], 'terms': [], 'feedback': []}), encoding='utf-8')
    assert lib.load().revision == 4 and lib.load().updated_at is None
    previous = lib.path().read_bytes()
    def fail(*args, **kwargs): raise OSError('isolated disk failure')
    monkeypatch.setattr('backend.services.speaker_integration.atomic_json', fail)
    draft = lib.load(); draft.profiles.append(lib.Profile(name='新档案'))
    with pytest.raises(OSError): lib.apply_changes(lib.Changes(base=lib.load(), draft=draft))
    assert lib.path().read_bytes() == previous
