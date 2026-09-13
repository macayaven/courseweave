import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from test_v2_foundation import course
from courseweave.contracts import CourseManifest
from courseweave.engine import curriculum_digest
from courseweave.manifest import parse_manifest_data, ManifestValidationError
from courseweave.store import CourseStore, InvalidProposalError, RevisionMismatchError
from courseweave.api import create_app


def setup(tmp_path):
    root = tmp_path / 'course'; root.mkdir()
    (root / 'lesson.md').write_text('Lesson')
    data = course()
    (root / 'courseweave.json').write_text(json.dumps(data))
    return root, data


def put(data, **extra):
    return {'type': 'put_record', 'coordinate': {'module_id':'intro','phase_id':'predict','requirement_id':'prediction'}, 'value': {'text':'Attempt'}, 'curriculum_digest':curriculum_digest(CourseManifest.model_validate(data)), **extra}


def test_runtime_uses_only_canonical_contract(tmp_path):
    assert isinstance(parse_manifest_data(course(), tmp_path), CourseManifest)
    with pytest.raises(ManifestValidationError, match='migrat'):
        parse_manifest_data({'schema_version':1}, tmp_path)


@pytest.mark.parametrize('explicit', [False, True])
@pytest.mark.parametrize('initialized', [False, True])
def test_unsaved_author_proposal_is_listed_and_resumes_after_restart(tmp_path, explicit, initialized):
    root = tmp_path / 'blank'; root.mkdir()
    options = {'state_dir': tmp_path / 'state'} if explicit else {}
    data = course(); data['id'] = 'chosen-course'
    request = {'id':'initial-course', 'type':'manifest_replace', 'origin':'student_requested',
               'summary':'Create course', 'target':'courseweave.json', 'payload':{'manifest':data}, 'target_hash':None}
    with TestClient(create_app(root, capability_token='test', **options), headers={'Authorization':'Bearer test'}) as client:
        if initialized:
            assert client.get('/api/state').status_code == 200
            assert client.get('/api/context', params={'source_id':'author'}).status_code == 404
        created = client.post('/api/proposals', json=request, headers={'Idempotency-Key':'create'})
        assert created.status_code == 201
        assert [p['id'] for p in client.get('/api/proposals').json()] == ['initial-course']
        assert client.get('/api/course').json()['id'] == 'chosen-course'
        assert client.get('/api/context', params={'source_id':'author'}).status_code == 404
        assert client.app.state.context_registry.manifest.id == 'chosen-course'
    assert not (root / 'courseweave.json').exists()
    app = create_app(root, capability_token='test', **options)
    from courseweave.providers import ProviderConfig
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None)
    with TestClient(app, headers={'Authorization':'Bearer test'}) as client:
        assert client.get('/api/course').json()['id'] == 'chosen-course'
        listed = client.get('/api/proposals')
        assert listed.status_code == 200
        assert [p['id'] for p in listed.json()] == ['initial-course']
        draft = client.get('/api/bootstrap').json()
        assert draft['manifest']['id'] == draft['course_id'] == 'chosen-course'
        assert client.get('/api/state').json()['course_id'] == 'chosen-course'
        guide = client.post('/api/author/guide', json={'threadId':'thread','runId':'run','messages':[{'id':'user','role':'user','content':'Hello'}],'tools':[],'context':[],'forwardedProps':{},'state':{}})
        assert guide.status_code == 409  # Provider deliberately unconfigured.
        assert app.state.context_registry.manifest.id == app.state.course_store.course_id == 'chosen-course'
        accepted = client.post('/api/proposals/initial-course/accept', json={'expected_revision':1}, headers={'Idempotency-Key':'accept'})
        assert accepted.status_code == 200
    assert json.loads((root / 'courseweave.json').read_text())['id'] == 'chosen-course'


def test_empty_author_state_and_mutation_project_canonical_draft(tmp_path):
    root = tmp_path / 'blank'; root.mkdir()
    with TestClient(create_app(root, capability_token='test'), headers={'Authorization':'Bearer test'}) as client:
        state = client.get('/api/state')
        assert state.status_code == 200
        assert state.json()['revision'] == 0
        bootstrap = client.get('/api/bootstrap')
        assert bootstrap.status_code == 200
        assert bootstrap.json()['manifest']['id'] == state.json()['course_id'] == 'blank'
        response = client.patch('/api/state', json={'origin':'student_requested', 'expected_revision':0,
            'operation':{'type':'set_time_budget', 'minutes':30}}, headers={'Idempotency-Key':'budget'})
        assert response.status_code == 200
        assert response.json()['revision'] == 1
        assert client.get('/api/bootstrap').json()['revision'] == 1
    assert list(root.iterdir()) == []


@pytest.mark.parametrize('location', ['explicit', 'environment', 'default', 'lock', 'registry', 'database'])
def test_state_paths_resolve_before_writing_inside_source(tmp_path, monkeypatch, location):
    from pathlib import Path
    from courseweave.store import resolve_state_dir
    root, data = setup(tmp_path)
    base = tmp_path / 'personal'
    alias = tmp_path / 'alias'
    options = {}
    if location == 'default':
        monkeypatch.delenv('COURSEWEAVE_STATE_HOME')
        monkeypatch.setattr('courseweave.store.sys.platform', 'darwin')
        monkeypatch.setattr(Path, 'home', lambda: tmp_path / 'home')
        alias = tmp_path / 'home' / 'Library' / 'Application Support' / 'CourseWeave'
        alias.parent.mkdir(parents=True)
        alias.symlink_to(root, target_is_directory=True)
    elif location in {'environment', 'explicit'}:
        alias.symlink_to(root, target_is_directory=True)
        if location == 'explicit': options['state_dir'] = alias
        else: monkeypatch.setenv('COURSEWEAVE_STATE_HOME', str(alias))
    else:
        monkeypatch.setenv('COURSEWEAVE_STATE_HOME', str(base))
        base.mkdir()
        if location == 'lock':
            (base / 'locks').symlink_to(root, target_is_directory=True)
        elif location == 'registry':
            (base / 'roots').symlink_to(root, target_is_directory=True)
        else:
            directory = resolve_state_dir(root, data['id']); directory.mkdir(parents=True)
            (directory / 'courseweave.db').symlink_to(root / 'state.db')
    before = sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob('*'))
    with pytest.raises(InvalidProposalError, match='outside course source'):
        CourseStore(root, **options)
    assert sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob('*')) == before


@pytest.mark.parametrize('explicit', [False, True])
def test_external_alias_is_supported(tmp_path, monkeypatch, explicit):
    root, _ = setup(tmp_path)
    target = tmp_path / 'personal'; target.mkdir()
    alias = tmp_path / 'alias'; alias.symlink_to(target, target_is_directory=True)
    options = {'state_dir': alias} if explicit else {}
    if not explicit: monkeypatch.setenv('COURSEWEAVE_STATE_HOME', str(alias))
    store = CourseStore(root, **options)
    assert store.db_path.is_relative_to(target)
    assert store.get_state().revision == 0


@pytest.mark.parametrize('explicit', [False, True])
def test_draft_rebind_rejects_stale_store_writer(tmp_path, explicit):
    from courseweave.store import CourseIdentityChangedError
    root = tmp_path / 'blank'; root.mkdir()
    options = {'state_dir': tmp_path / 'state'} if explicit else {}
    first = CourseStore(root, **options)
    stale = CourseStore(root, **options)
    first.rebind_empty_draft('chosen-course')
    with pytest.raises(CourseIdentityChangedError, match='identity changed'):
        stale.apply_state({'type':'set_time_budget', 'minutes':30}, 0, 'stale')
    reopened = CourseStore(root, **options)
    assert reopened.course_id == 'chosen-course'
    assert reopened.get_state().revision == 0


def test_untouched_author_listing_does_not_materialize_personal_state(tmp_path, monkeypatch):
    root = tmp_path / 'blank'; root.mkdir()
    personal = tmp_path / 'personal'
    monkeypatch.setenv('COURSEWEAVE_STATE_HOME', str(personal))
    with TestClient(create_app(root, capability_token='test'), headers={'Authorization':'Bearer test'}) as client:
        assert client.get('/api/proposals').json() == []
        assert client.get('/api/course').json()['id'] == 'blank'
    assert not personal.exists()
    assert list(root.iterdir()) == []


@pytest.mark.parametrize('explicit', [False, True])
@pytest.mark.parametrize('interruption', ['before_registry', 'after_registry'])
def test_interrupted_draft_identity_handoff_reopens(tmp_path, monkeypatch, explicit, interruption):
    root = tmp_path / 'blank'; root.mkdir()
    options = {'state_dir': tmp_path / 'state'} if explicit else {}
    store = CourseStore(root, **options)
    if explicit:
        # A prior version wrote this redundant cache; it must not override SQLite.
        store.registry_path.write_text(json.dumps({'course_id':'blank', 'root_fingerprint':store.root_fingerprint}))
    persist = store._persist_identity

    def interrupt():
        if interruption == 'after_registry':
            persist()
        raise RuntimeError('injected identity handoff interruption')

    monkeypatch.setattr(store, '_persist_identity', interrupt)
    with pytest.raises(RuntimeError, match='identity handoff'):
        store.rebind_empty_draft('chosen-course')
    reopened = CourseStore(root, **options)
    expected_id = 'chosen-course' if explicit or interruption == 'after_registry' else 'blank'
    assert reopened.get_state().course_id == expected_id
    assert reopened.get_state().revision == 0
    if reopened.course_id != 'chosen-course':
        reopened.rebind_empty_draft('chosen-course')
    data = course(); data['id'] = 'chosen-course'
    reopened.create_proposal({'id':'initial-course', 'type':'manifest_replace', 'origin':'student_requested',
        'summary':'Create course', 'target':'courseweave.json', 'payload':{'manifest':data}, 'target_hash':None}, 'create')
    restarted = CourseStore(root, **options)
    assert [p.id for p in restarted.list_proposals()] == ['initial-course']
    assert restarted.accept_proposal('initial-course', 1, 'accept').status == 'accepted'


def test_explicit_draft_identity_rolls_back_with_sqlite_transaction(tmp_path, monkeypatch):
    root = tmp_path / 'blank'; root.mkdir()
    store = CourseStore(root, state_dir=tmp_path / 'state')
    write = store._write_state

    def interrupt(connection, state):
        write(connection, state)
        raise RuntimeError('injected before identity commit')

    monkeypatch.setattr(store, '_write_state', interrupt)
    with pytest.raises(RuntimeError, match='before identity commit'):
        store.rebind_empty_draft('chosen-course')
    assert CourseStore(root, state_dir=tmp_path / 'state').get_state().course_id == 'blank'


def test_explicit_database_identity_preserves_foreign_root_guard(tmp_path):
    from courseweave.store import StoreCorruptError
    root = tmp_path / 'blank'; root.mkdir()
    other = tmp_path / 'other'; other.mkdir()
    store = CourseStore(root, state_dir=tmp_path / 'state')
    before = store.db_path.read_bytes()
    with pytest.raises(StoreCorruptError, match='another course root'):
        CourseStore(other, state_dir=tmp_path / 'state')
    assert store.db_path.read_bytes() == before
    assert list(other.iterdir()) == []


@pytest.mark.parametrize('explicit', [False, True])
@pytest.mark.parametrize('read', ['get_state', 'list_proposals', 'proposal_history', 'get_manifest', 'state_view'])
def test_draft_rebind_rejects_stale_store_readers(tmp_path, explicit, read):
    from courseweave.store import CourseIdentityChangedError
    root = tmp_path / 'blank'; root.mkdir()
    options = {'state_dir': tmp_path / 'state'} if explicit else {}
    selected = CourseStore(root, **options)
    stale = CourseStore(root, **options)
    selected.rebind_empty_draft('chosen-course')
    data = course(); data['id'] = 'chosen-course'
    selected.create_proposal({'id':'initial-course', 'type':'manifest_replace', 'origin':'student_requested',
        'summary':'Create course', 'target':'courseweave.json', 'payload':{'manifest':data}, 'target_hash':None}, 'create')
    arguments = ('initial-course',) if read == 'proposal_history' else ()
    with pytest.raises(CourseIdentityChangedError, match='identity changed; reopen'):
        getattr(stale, read)(*arguments)
    assert [p.id for p in CourseStore(root, **options).list_proposals()] == ['initial-course']


@pytest.mark.parametrize('explicit', [False, True])
def test_preopened_author_app_returns_actionable_identity_conflict(tmp_path, explicit):
    root = tmp_path / 'blank'; root.mkdir()
    options = {'state_dir': tmp_path / 'state'} if explicit else {}
    app = create_app(root, capability_token='test', **options)
    with TestClient(app, headers={'Authorization':'Bearer test'}) as client:
        assert client.get('/api/state').status_code == 200
        selected = CourseStore(root, **options)
        selected.rebind_empty_draft('chosen-course')
        data = course(); data['id'] = 'chosen-course'
        selected.create_proposal({'id':'initial-course', 'type':'manifest_replace', 'origin':'student_requested',
            'summary':'Create course', 'target':'courseweave.json', 'payload':{'manifest':data}, 'target_hash':None}, 'create')
        paths = ['/api/state', '/api/state/export', '/api/bootstrap', '/api/proposals', '/api/course', '/api/context?source_id=author']
        for path in paths:
            response = client.get(path)
            assert response.status_code == 409, path
            assert response.json()['code'] == 'course_identity_changed'
            assert response.json()['message'] == 'The draft identity changed; reopen the course to load its current state.'
        guide = client.post('/api/author/guide', json={'threadId':'thread','runId':'run','messages':[{'id':'user','role':'user','content':'Hello'}],'tools':[],'context':[],'forwardedProps':{},'state':{}})
        assert guide.status_code == 409
        assert guide.json()['code'] == 'course_identity_changed'
    with TestClient(create_app(root, capability_token='test', **options), headers={'Authorization':'Bearer test'}) as client:
        assert [p['id'] for p in client.get('/api/proposals').json()] == ['initial-course']
        assert client.get('/api/state').json()['course_id'] == 'chosen-course'


def test_external_state_bound_records_replay_and_invalidation(tmp_path):
    root, data = setup(tmp_path)
    store = CourseStore(root, state_dir=tmp_path / 'state')
    assert not (root / '.courseweave').exists()
    state = store.apply_state(put(data), 0, 'one')
    assert state.records[0].origin == 'direct_learner'
    assert store.state_view()['progress']['required_complete'] == 1
    store.apply_state({'type':'set_time_budget','minutes':25}, 1, 'two')
    assert store.apply_state(put(data), 0, 'one') == state
    data['title'] = 'Cosmetic'
    (root / 'courseweave.json').write_text(json.dumps(data))
    assert store.state_view()['progress']['required_complete'] == 1
    data['modules'][0]['phases'][0]['completion']['requirements'][0]['prompt'] = 'New task'
    (root / 'courseweave.json').write_text(json.dumps(data))
    assert store.state_view()['progress']['records'][0]['status'] == 'stale'
    assert store.state_view()['progress']['required_complete'] == 0
    assert store.apply_state(put(course()), 0, 'one') == state


@pytest.mark.parametrize('extra', [{'kind':'text'}, {'origin':'direct_learner'}, {'requirement_digest':'sha256:'+'0'*64}, {'value':{'text':'Attempt','attested':True}}, {'coordinate':{'module_id':'intro','phase_id':'predict','requirement_id':'fake'}}, {'curriculum_digest':'sha256:'+'0'*64}])
def test_reject_forged_stale_and_arbitrary_records(tmp_path, extra):
    root, data = setup(tmp_path); store = CourseStore(root, state_dir=tmp_path / 'state')
    with pytest.raises((InvalidProposalError, RevisionMismatchError)):
        store.apply_state(put(data, **extra), 0, 'bad')
    assert store.get_state().revision == 0


def test_cas_concurrency(tmp_path):
    root, data = setup(tmp_path); store = CourseStore(root, state_dir=tmp_path / 'state')
    def write(i):
        try: return store.apply_state(put(data), 0, str(i)).revision
        except RevisionMismatchError: return 'stale'
    with ThreadPoolExecutor(2) as pool: results = list(pool.map(write, range(2)))
    assert sorted(results, key=str) == [1, 'stale']


def test_state_api_closed_body_and_bootstrap(tmp_path):
    root, data = setup(tmp_path); app = create_app(root, state_dir=tmp_path / 'state', capability_token='test')
    with TestClient(app, headers={'Authorization':'Bearer test'}) as client:
        body = {'origin':'student_requested', 'expected_revision':0, 'operation':put(data)}
        assert client.patch('/api/state', json={**body, 'records':[]}, headers={'Idempotency-Key':'bad'}).status_code == 422
        result = client.patch('/api/state', json=body, headers={'Idempotency-Key':'one'})
        assert result.status_code == 200
        assert result.json()['progress']['required_complete'] == 1
        assert client.get('/api/bootstrap').json()['curriculum_digest'] == put(data)['curriculum_digest']


def test_import_is_copy_only_and_unbound_until_resubmission(tmp_path):
    import sqlite3
    root, data = setup(tmp_path)
    legacy_dir = root / '.courseweave'; legacy_dir.mkdir()
    source = legacy_dir / 'courseweave.db'
    legacy = {'schema_version':1, 'revision':3, 'predictions':{'intro/predict/prediction':{'type':'record_prediction','module_id':'intro','phase_id':'predict','record_id':'prediction','text':'Old attempt'}}, 'reflections':{'gone/phase/record':{'text':'Unmapped'}}, 'profile':{}, 'audit':[]}
    with sqlite3.connect(source) as connection:
        connection.execute('CREATE TABLE learner_state(singleton INTEGER, json TEXT)')
        connection.execute('INSERT INTO learner_state VALUES (1, ?)', (json.dumps(legacy),))
    before = source.read_bytes()
    store = CourseStore(root, state_dir=tmp_path / 'state')
    assert store.get_state().imports == ()
    result = store.import_legacy(source, {'predictions:intro/predict/prediction':put(data)['coordinate']}, 0, 'import')
    assert [i.status for i in result.imports] == ['unbound', 'orphan']
    assert source.read_bytes() == before
    assert store.state_view()['progress']['required_complete'] == 0
    store.apply_state(put(data), 1, 'resubmit')
    assert store.state_view()['progress']['required_complete'] == 1


def test_formative_consent_export_reset_and_delete(tmp_path):
    from test_v2_learning import learning
    root, data = setup(tmp_path)
    data['modules'][0]['phases'][0]['learning'] = learning()
    (root / 'courseweave.json').write_text(json.dumps(data))
    store = CourseStore(root, state_dir=tmp_path / 'state')
    check = data['modules'][0]['phases'][0]['learning']['checks'][0]
    operation = {'type':'check_attempt', 'module_id':'intro','phase_id':'predict','check_id':check['id'], 'option_id':check['options'][0]['id'], 'curriculum_digest':put(data)['curriculum_digest']}
    with pytest.raises(InvalidProposalError): store.apply_state({**operation, 'option_id':'made-up'}, 0, 'bad')
    state = store.apply_state(operation, 0, 'check')
    assert state.attempts[0].check_digest.startswith('sha256:')
    assert state.attempts[0].feedback == check['options'][0]['feedback']
    assert not state.preferences.enabled
    assert store.state_view()['progress']['required_complete'] == 0
    state = store.apply_state({'type':'set_preferences','preferences':{'enabled':True, 'explanation':'detailed','practice':'extra'}}, 1, 'consent')
    assert state.preferences.enabled
    state = store.apply_state({'type':'set_preferences','preferences':{'enabled':False}}, 2, 'revoke')
    assert not state.preferences.enabled
    exported = state.model_dump_json()
    assert 'chat' not in exported and 'secret' not in exported
    store.apply_state(put(data, value={'text':'PRIVATE_LEARNER_RECORD'}), 3, 'record')
    state = store.apply_state({'type':'delete_state'}, 4, 'delete')
    assert state.records == () and state.attempts == () and state.imports == ()
    with store._connect() as connection:
        assert all('PRIVATE_LEARNER_RECORD' not in row['response_json'] for row in connection.execute('SELECT response_json FROM idempotency'))
    assert b'PRIVATE_LEARNER_RECORD' not in store.db_path.read_bytes()


def test_artifact_removed_recomputed_and_clear_is_closed(tmp_path):
    root, data = setup(tmp_path)
    data['modules'][0]['phases'][0]['completion']['requirements'].append({'id':'artifact','type':'artifact_exists','path':'output.txt','prompt':'Create output'})
    (root / 'courseweave.json').write_text(json.dumps(data)); (root / 'output.txt').write_text('Result')
    store = CourseStore(root, state_dir=tmp_path / 'state')
    store.apply_state(put(data), 0, 'record')
    assert store.state_view()['progress']['required_complete'] == 1
    (root / 'output.txt').unlink()
    assert store.state_view()['progress']['required_complete'] == 0
    operation = put(data); operation.pop('value'); operation['type'] = 'clear_record'
    assert store.apply_state(operation, 1, 'clear').records == ()


def test_union_issue_points_to_actual_field(tmp_path):
    data = course(); data['modules'][0]['phases'][0]['surfaces'][0]['path'] = '../escape'
    with pytest.raises(ManifestValidationError) as error: parse_manifest_data(data, tmp_path)
    assert error.value.issues[0]['path'] == '/modules/0/phases/0/surfaces/0/path'


def test_external_identity_binding(tmp_path):
    root, data = setup(tmp_path)
    store = CourseStore(root, state_dir=tmp_path / 'state')
    data['id'] = 'other'; (root / 'courseweave.json').write_text(json.dumps(data))
    with pytest.raises(InvalidProposalError): store.state_view()
    from courseweave.store import StoreCorruptError
    with pytest.raises(StoreCorruptError): CourseStore(root, state_dir=tmp_path / 'state').get_state()


def test_new_author_manifest_state_reopens_under_saved_identity(tmp_path):
    from courseweave.manifest import manifest_etag
    root = tmp_path / 'new-course'; root.mkdir()
    app = create_app(root, state_dir=tmp_path / 'state', capability_token='test')
    with TestClient(app, headers={'Authorization':'Bearer test'}) as client:
        response = client.put('/api/course', json=course(), headers={'If-Match':'""','Idempotency-Key':'save','X-Courseweave-Origin':'student_requested'})
        assert response.status_code == 200
        assert client.get('/api/state').json()['course_id'] == 'demo'
    assert CourseStore(root, state_dir=tmp_path / 'state').get_state().course_id == 'demo'


def test_migrate_cli_preview_copy_apply_and_v1_error(tmp_path):
    from typer.testing import CliRunner
    from courseweave.cli import app
    from courseweave.migration.legacy_models import CourseManifest as LegacyManifest
    legacy = {'schema_version':1, 'id':'legacy','title':'Legacy','description':'','entry_module_id':None,'policies':{'content_sharing':'explicit_only','durable_mutation':'proposal_or_direct_student_action','terminal_execution':'student_only','conversation_memory':'session_only','max_shared_chars':8192,'workspace_write_globs':[]},'modules':[]}
    source = tmp_path / 'courseweave.json'; source.write_text(json.dumps(legacy)); before = source.read_bytes()
    runner = CliRunner(); preview = runner.invoke(app, ['migrate','--source',str(source)])
    assert preview.exit_code == 0
    assert 'mappings' in preview.output
    output = tmp_path / 'courseweave.v2.json'
    assert not output.exists()
    result = runner.invoke(app, ['migrate','--source',str(source),'--apply','--output',str(output)])
    assert result.exit_code == 0
    assert json.loads(output.read_text())['schema_version'] == 2
    assert source.read_bytes() == before
    assert runner.invoke(app, ['migrate','--source',str(source),'--apply','--output',str(source)]).exit_code != 0
    error = runner.invoke(app,['validate','--course-root',str(tmp_path)])
    assert error.exit_code == 1 and 'migrate' in error.output


def test_state_cli_inspect_export_reset(tmp_path):
    from typer.testing import CliRunner
    from courseweave.cli import app
    root, data = setup(tmp_path); directory = tmp_path / 'state'
    store = CourseStore(root, state_dir=directory); store.apply_state(put(data), 0, 'record')
    runner = CliRunner(); args=['--course-root',str(root),'--state-dir',str(directory)]
    result = runner.invoke(app,['state','inspect',*args]); assert result.exit_code == 0
    assert json.loads(result.output)['records'][0]['origin'] == 'direct_learner'
    exported = tmp_path / 'export.json'
    assert runner.invoke(app,['state','export',*args,'--output',str(exported)]).exit_code == 0
    assert json.loads(exported.read_text())['schema_version'] == 2
    assert runner.invoke(app,['state','reset',*args]).exit_code == 0
    assert store.get_state().records == ()


@pytest.mark.parametrize('changes', [{'chat_history':'Raw conversation'}, {'api_key':'fake-secret'}, {'personality':'inferred'}, {'explanation':'invented'}])
def test_profile_proposals_are_closed_preferences(tmp_path, changes):
    root, _ = setup(tmp_path); store = CourseStore(root, state_dir=tmp_path / 'state')
    with pytest.raises(InvalidProposalError):
        store.create_proposal({'type':'profile_patch','origin':'student_requested','summary':'Preference','target':'learner_profile','payload':{'changes':changes}}, 'profile')


def test_profile_proposal_requires_visible_adaptation_consent(tmp_path):
    root, _ = setup(tmp_path); store = CourseStore(root, state_dir=tmp_path / 'state')
    proposal = store.create_proposal({'type':'profile_patch','origin':'student_requested','summary':'Preference','target':'learner_profile','payload':{'changes':{'explanation':'concise'}}}, 'profile')
    with pytest.raises(InvalidProposalError): store.accept_proposal(proposal.id, 1, 'accept')
    assert store.get_state().revision == 0
    store.apply_state({'type':'set_preferences','preferences':{'enabled':True}}, 0, 'consent')
    store.accept_proposal(proposal.id, 1, 'accept')
    assert store.get_state().preferences.explanation == 'concise'


def test_active_api_cannot_apply_old_workspace_proposal(tmp_path):
    root, data = setup(tmp_path)
    data['policies']['workspace_write_globs'] = ['notes/*.md']; (root / 'courseweave.json').write_text(json.dumps(data))
    store = CourseStore(root, state_dir=tmp_path / 'state')
    proposal = store.create_proposal({'type':'workspace_file_replace','origin':'student_requested','summary':'Old file change','target':{'path':'notes/x.md'},'payload':{'content':'change','diff':'+change'},'target_hash':None}, 'old')
    with TestClient(create_app(root, state_dir=tmp_path / 'state', capability_token='test'), headers={'Authorization':'Bearer test'}) as client:
        response = client.post(f'/api/proposals/{proposal.id}/accept', headers={'Idempotency-Key':'accept'},json={'expected_revision':1})
        assert response.status_code == 403
    assert not (root / 'notes/x.md').exists()


def test_empty_author_session_can_choose_initial_id_and_reopen(tmp_path):
    root = tmp_path / 'blank'; root.mkdir()
    app = create_app(root, capability_token='test')
    with TestClient(app, headers={'Authorization':'Bearer test'}) as client:
        assert client.get('/api/course').json()['id'] == 'blank'
        # The guide opens before any save and creates only empty bound state.
        client.post('/api/author/guide', json={'threadId':'thread','runId':'run','messages':[{'id':'user','role':'user','content':'Hello'}],'tools':[],'context':[],'forwardedProps':{},'state':{}})
        assert app.state.course_store is not None
        response = client.put('/api/course', json=course(), headers={'If-Match':'""','Idempotency-Key':'save','X-Courseweave-Origin':'student_requested'})
        assert response.status_code == 200
        assert client.get('/api/state').json()['course_id'] == 'demo'
    assert CourseStore(root).get_state().course_id == 'demo'


def test_share_opens_only_after_current_server_bound_record(tmp_path):
    root, data = setup(tmp_path); data['policies']['allowed_share_kinds']=['selection']; data['modules'][0]['phases'][0]['teacher']['sharing']['allow']=['selection']; (root / 'courseweave.json').write_text(json.dumps(data))
    app = create_app(root, state_dir=tmp_path / 'state', capability_token='test')
    with TestClient(app, headers={'Authorization':'Bearer test'}) as client:
        share={'run_id':'share','kind':'selection','content':'content'}
        assert client.post('/api/share',json=share).status_code == 403
        client.patch('/api/state',json={'origin':'student_requested','expected_revision':0,'operation':put(data)},headers={'Idempotency-Key':'record'})
        assert client.post('/api/share',json=share).status_code == 200


def test_check_attempts_become_stale_or_orphan_without_affecting_completion(tmp_path):
    from test_v2_learning import learning
    root,data=setup(tmp_path); data['modules'][0]['phases'][0]['learning']=learning(); (root/'courseweave.json').write_text(json.dumps(data))
    check=data['modules'][0]['phases'][0]['learning']['checks'][0]; store=CourseStore(root,state_dir=tmp_path/'state')
    store.apply_state({'type':'check_attempt','module_id':'intro','phase_id':'predict','check_id':check['id'],'option_id':check['correct_option_id'],'curriculum_digest':put(data)['curriculum_digest']},0,'attempt')
    assert store.state_view()['attempt_statuses'][0]['status']=='valid'
    data['modules'][0]['phases'][0]['learning']['objectives'][0]['text']='A different objective'; (root/'courseweave.json').write_text(json.dumps(data))
    assert store.state_view()['attempt_statuses'][0]['status']=='stale'
    data['modules'][0]['phases'][0]['learning']['checks']=[]; (root/'courseweave.json').write_text(json.dumps(data))
    assert store.state_view()['attempt_statuses'][0]['status']=='orphan'


def test_launch_v1_stops_before_process_start_and_links_migration(tmp_path):
    from courseweave.launch import LaunchSupervisor
    (tmp_path/'courseweave.json').write_text('{"schema_version":1}')
    errors=[]
    supervisor=LaunchSupervisor(tmp_path,error_sink=errors.append, process_factory=lambda *a,**k: pytest.fail('must not launch'))
    assert supervisor.run()==1
    assert any('migrate' in error for error in errors)


def test_runtime_availability_omits_workspace_tools_and_ignores_experience(tmp_path):
    root,data=setup(tmp_path); phase=data['modules'][0]['phases'][0]
    data['policies']['allowed_proposal_types']=['workspace','course']; phase['teacher']['proposals']['allow']=['workspace','course']; phase['experience']={'type':'custom','id':'example.org/free-chat'}
    (root/'courseweave.json').write_text(json.dumps(data)); store=CourseStore(root,state_dir=tmp_path/'state')
    assert not store.state_view()['teacher_availability']['intro/predict']['provider_callable']
    store.apply_state(put(data),0,'record')
    effective=store.state_view()['teacher_availability']['intro/predict']
    assert effective['provider_callable']
    assert effective['allowed_proposal_types']==['course']


def test_packaged_direct_action_schema_matches_closed_transport():
    from pathlib import Path
    from courseweave.state_contracts import StateRequest
    root=Path(__file__).parents[2]
    packaged=root/'src/courseweave/state-request.schema.json'
    documented=root/'docs/contracts/state-request.schema.json'
    expected={'$schema':'https://json-schema.org/draft/2020-12/schema', **StateRequest.model_json_schema()}
    assert json.loads(packaged.read_text())==expected
    assert packaged.read_bytes()==documented.read_bytes()
