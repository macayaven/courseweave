"""Synthetic teaching conformance; no external provider or empirical quality claims."""
import json
from pathlib import Path
import pytest
from courseweave.providers import ProviderConfig
from test_agui import _client as _base_client, _run_input, _events, _configured_factory, CountingTestModel, AUTH


def _client(tmp_path, **kwargs):
    client, app = _base_client(tmp_path, **kwargs)
    client.post('/api/context', headers=AUTH, json={'source_id':'lesson-source','sequence':1,'active_path':'lesson.md', 'active_cell_id':None,'active_cell_tags':[],'surface_kind':None,'explicit_module_id':None,'explicit_phase_id':None,'video_seconds':None,'terminal_surface_id':None})
    return client, app


def test_capabilities_and_fingerprint_are_explicit_and_secret_free():
    cfg = ProviderConfig.from_mapping({'COURSEWEAVE_PROVIDER': 'openai', 'OPENAI_MODEL': 'test', 'OPENAI_API_KEY': 'secret', 'COURSEWEAVE_PROVIDER_PROFILE': 'text-only-v1'})
    assert cfg.capabilities.tools is False
    assert cfg.capabilities.streaming is False
    assert cfg.fingerprint == ProviderConfig.from_mapping({'COURSEWEAVE_PROVIDER': 'openai', 'OPENAI_MODEL': 'test', 'OPENAI_API_KEY': 'other', 'COURSEWEAVE_PROVIDER_PROFILE': 'text-only-v1'}).fingerprint


@pytest.mark.parametrize('value', ['nan', 'inf', '-1', 'bad', '0'])
def test_invalid_deadline_is_rejected(value):
    with pytest.raises(ValueError):
        ProviderConfig.from_mapping({'COURSEWEAVE_PROVIDER_TIMEOUT_SECONDS': value})


def test_lesson_scope_suppresses_nested_solutions_and_reset_removes_echo(tmp_path):
    client, app = _client(tmp_path)
    (tmp_path / 'lesson.md').write_text('Visible pairing lesson\n<details><summary>Answer</summary>SECRET <details>INNER</details>TAIL</details>\n<script>BAD</script>')
    model = CountingTestModel(call_tools=[], custom_output_text='lesson echo')
    app.state.professor_model_factory = _configured_factory(model)
    response = client.post('/api/guide/lesson', headers=AUTH, json={'thread_id': 'thread-one', 'action': 'use_lesson', 'source_id': 'lesson-source'})
    assert response.status_code == 200
    assert response.json()['scope']['label']
    client.post('/api/guide', headers=AUTH, json=_run_input())
    context = str(model.request_messages[-1])
    assert 'Visible pairing lesson' in context
    assert not any(secret in context for secret in ('SECRET', 'INNER', 'TAIL', 'BAD'))
    response = client.post('/api/guide/lesson', headers=AUTH, json={'thread_id': 'thread-one', 'action': 'reset_lesson'})
    assert response.status_code == 200
    client.post('/api/guide', headers=AUTH, json=_run_input(run_id='two', prompt='Continue'))
    assert 'lesson echo' not in str(model.request_messages[-1])
    assert 'Visible pairing lesson' not in str(model.request_messages[-1])


def test_lesson_changed_requires_reconfirmation(tmp_path):
    client, app = _client(tmp_path)
    (tmp_path / 'lesson.md').write_text('original')
    assert client.post('/api/guide/lesson', headers=AUTH, json={'thread_id': 'thread-one', 'action': 'use_lesson', 'source_id': 'lesson-source'}).status_code == 200
    (tmp_path / 'lesson.md').write_text('replacement')
    response = client.post('/api/guide', headers=AUTH, json=_run_input())
    assert response.status_code == 409
    assert response.json()['code'] == 'lesson_changed'


def test_text_only_professor_uses_plain_nonstreaming_request(tmp_path):
    client, app = _client(tmp_path, course_proposal=True)
    model = CountingTestModel(call_tools=[], custom_output_text='A useful explanation')
    app.state.professor_model_factory = _configured_factory(model)
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None, profile='text-only-v1')
    response = client.post('/api/guide', headers=AUTH, json=_run_input())
    assert _events(response)[-1]['type'] == 'RUN_FINISHED'
    assert 'A useful explanation' in response.text
    assert model.last_model_request_parameters.function_tools == []


def test_explicit_hints_only_expose_next_authored_step(tmp_path):
    client, app = _client(tmp_path)
    data = json.loads((tmp_path / 'courseweave.json').read_text())
    data['modules'][0]['phases'][0]['learning'] = {'objectives': [{'id': 'pairing', 'text': 'Match IDs'}], 'hints': [{'id': 'one', 'text': 'FIRST', 'objective_ids': ['pairing']}, {'id': 'two', 'text': 'SECOND', 'objective_ids': ['pairing']}], 'checks': [{'id':'quiz','type':'single_choice','prompt':'Which?','objective_ids':['pairing'],'options':[{'id':'a','text':'A','feedback':'ANSWER-A'},{'id':'b','text':'B','feedback':'ANSWER-B'}],'correct_option_id':'b'}]}
    (tmp_path / 'courseweave.json').write_text(json.dumps(data))
    model = CountingTestModel(call_tools=[], custom_output_text='Try matching IDs')
    app.state.professor_model_factory = _configured_factory(model)
    response = client.post('/api/guide', headers=AUTH, json=_run_input(forwardedProps={'action':'hint','objective_id':'pairing'}))
    assert _events(response)[-1]['type'] == 'RUN_FINISHED'
    context = str(model.request_messages[-1]) + str(model.last_model_request_parameters)
    assert 'FIRST' in context
    assert 'SECOND' not in context
    assert 'ANSWER-A' not in context and 'ANSWER-B' not in context
    assert 'correct_option_id' not in context


def _learning(tmp_path):
    data = json.loads((tmp_path / 'courseweave.json').read_text())
    data['modules'][0]['phases'][0]['learning'] = {'objectives':[{'id':'pairing','text':'Pair every tool call with its result'}], 'hints':[{'id':'first','text':'Look for tool call IDs','objective_ids':['pairing']},{'id':'second','text':'Each parallel call needs a result','objective_ids':['pairing']}], 'checks':[{'id':'quiz','type':'single_choice','prompt':'Does ordinary assistant text require a tool result?','objective_ids':['pairing'],'options':[{'id':'yes','text':'Yes','feedback':'Only actual tool calls require results; ordinary text needs none.'},{'id':'no','text':'No','feedback':'Correct for this check.'}],'correct_option_id':'no'}]}
    (tmp_path / 'courseweave.json').write_text(json.dumps(data))
    return data


def test_no_provider_authored_hint_and_decline_actions(tmp_path):
    client, app = _client(tmp_path)
    _learning(tmp_path)
    for text in ('Look for tool call IDs', 'Each parallel call needs a result'):
        response = client.post('/api/guide/action', headers=AUTH, json={'thread_id':'thread-one', 'source_id':'lesson-source', 'action':'hint','objective_id':'pairing'})
        assert response.status_code == 200
        assert response.json()['hint']['text'] == text
    response = client.post('/api/guide/action', headers=AUTH, json={'thread_id':'thread-one','source_id':'lesson-source','action':'decline_revisit'})
    assert response.json()['status'] == 'declined'
    assert app.state.course_store.get_state().revision == 0


def test_current_session_check_fact_works_with_opt_out_and_other_session_cannot_use_it(tmp_path):
    from fastapi.testclient import TestClient
    client, app = _client(tmp_path)
    _learning(tmp_path)
    view = client.get('/api/state', headers=AUTH).json()
    saved = client.patch('/api/state', headers={**AUTH,'Idempotency-Key':'check-one'}, json={'origin':'student_requested','expected_revision':view['revision'],'operation':{'type':'check_attempt','module_id':'module-one','phase_id':'phase-one','check_id':'quiz','option_id':'yes','curriculum_digest':view['curriculum_digest']}})
    assert saved.status_code == 200
    model = CountingTestModel(call_tools=[], custom_output_text='Only actual calls need results.')
    app.state.professor_model_factory = _configured_factory(model)
    client.post('/api/guide', headers=AUTH, json=_run_input())
    assert 'Only actual tool calls require results' in str(model.request_messages[-1])
    assert 'optional_revisit' in str(model.request_messages[-1])
    with TestClient(app) as other:
        other.post('/api/guide', headers=AUTH, json=_run_input())
        assert 'Only actual tool calls require results' not in str(model.request_messages[-1])
        assert 'optional_revisit' not in str(model.request_messages[-1])
    client.post('/api/guide/action', headers=AUTH, json={'thread_id':'thread-one','action':'decline_revisit'})
    client.post('/api/guide', headers=AUTH, json=_run_input(run_id='next'))
    assert 'optional_revisit' not in str(model.request_messages[-1])


@pytest.mark.parametrize('finish,expected', [('length','truncated'),('content_filter','refusal')])
def test_provider_semantic_failure_does_not_commit_text_history(tmp_path, finish, expected):
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.messages import ModelResponse, TextPart
    client, app = _client(tmp_path)
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None, profile='text-only-v1')
    app.state.professor_model_factory = _configured_factory(FunctionModel(lambda messages, info: ModelResponse(parts=[TextPart('partial answer')],finish_reason=finish)))
    response = client.post('/api/guide', headers=AUTH, json=_run_input())
    assert _events(response)[-1]['type'] == 'RUN_ERROR'
    assert _events(response)[-1]['code'] == expected
    assert app.state.guide_history == {}
    assert app.state.proposal_candidates == {}


def test_selected_learning_candidate_preserves_siblings_and_exact_source(tmp_path):
    from test_agui import _manifest
    from courseweave.manifest import read_manifest
    client, app = _client(tmp_path)
    data = _learning(tmp_path)
    sibling = json.loads(json.dumps(data['modules'][0]['phases'][0]))
    sibling['id'] = 'untouched'
    data['modules'][0]['phases'].append(sibling)
    (tmp_path / 'courseweave.json').write_text(json.dumps(data))
    client.post('/api/context', headers=AUTH, json={'source_id':'author-selection','sequence':1,'active_path':None,'active_cell_id':None,'active_cell_tags':[],'surface_kind':None,'explicit_module_id':'module-one','explicit_phase_id':'phase-one','video_seconds':None,'terminal_surface_id':None})
    before = read_manifest(tmp_path)
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None, profile='stream-tools-v1')
    class LearningModel(CountingTestModel):
        def gen_tool_args(self, tool):
            return {'summary':'Improve the selected learning', 'learning':{'overview':'New authored explanation'}}
    app.state.professor_model_factory = _configured_factory(LearningModel(call_tools=['suggest_activity_learning'],custom_output_text='Review this suggestion.'))
    response = client.post('/api/author/guide', headers=AUTH, json=_run_input(forwardedProps={'source_id':'author-selection','action':'edit_learning'}))
    assert _events(response)[-1]['type'] == 'RUN_FINISHED'
    candidate = next(e['value']['candidate'] for e in _events(response) if e.get('name') == 'courseweave.proposal_candidate')
    assert candidate['target_hash'] == before.etag.strip('"')
    assert candidate['payload']['manifest']['modules'][0]['phases'][1] == before.manifest.model_dump(mode='json')['modules'][0]['phases'][1]
    assert (tmp_path / 'courseweave.json').read_bytes() == before.raw_bytes
    (tmp_path / 'courseweave.json').write_bytes(before.raw_bytes + b'\n')
    persisted = client.post('/api/proposals',headers={**AUTH,'Idempotency-Key':'stale-candidate'},json={'candidate_id':candidate['id']})
    assert persisted.status_code == 409


def test_consent_revocation_outside_api_removes_evidence_dependent_replay(tmp_path):
    from courseweave.state_contracts import SetPreferences
    client, app = _client(tmp_path)
    _learning(tmp_path)
    state = client.get('/api/state', headers=AUTH).json()
    client.patch('/api/state', headers={**AUTH,'Idempotency-Key':'enable'}, json={'origin':'student_requested','expected_revision':state['revision'],'operation':{'type':'set_preferences','preferences':{'enabled':True}}})
    model = CountingTestModel(call_tools=[],custom_output_text='Evidence dependent echo')
    app.state.professor_model_factory = _configured_factory(model)
    client.post('/api/guide',headers=AUTH,json=_run_input())
    store = app.state.course_store
    store.apply_state(SetPreferences(type='set_preferences',preferences={'enabled':False}),store.get_state().revision,'external-revoke')
    client.post('/api/guide',headers=AUTH,json=_run_input(run_id='after-revoke'))
    assert 'Evidence dependent echo' not in str(model.request_messages[-1])


def test_provider_evidence_event_has_versions_and_no_secrets(tmp_path):
    client, app = _client(tmp_path)
    app.state.provider_config_factory = lambda: ProviderConfig(provider='openai',model='fixture',api_key='DO-NOT-LOG',base_url='http://secret:password@localhost',profile='text-only-v1')
    app.state.professor_model_factory = _configured_factory(CountingTestModel(call_tools=[],custom_output_text='Answer'))
    response = client.post('/api/guide',headers=AUTH,json=_run_input())
    event = next((e for e in _events(response) if e.get('name') == 'courseweave.provider_outcome'), None)
    assert event is not None
    assert event['value']['profile'] == 'text-only-v1'
    assert event['value']['prompt_version'] == 'course-assistant-v1'
    assert 'DO-NOT-LOG' not in response.text and 'password' not in response.text


@pytest.mark.parametrize('profile', ['text-only-v1','stream-tools-v1'])
def test_two_synthetic_profiles_ground_with_identical_safe_data(tmp_path,profile):
    client, app = _client(tmp_path)
    _learning(tmp_path)
    (tmp_path/'lesson.md').write_text('An ordinary assistant reply needs no tool result. Every parallel tool call needs its matching result. <details>hidden answer</details>')
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None, profile=profile)
    fixture = json.loads((Path(__file__).parent/'fixtures/teaching-evaluation-v1.json').read_text())
    data = json.loads((tmp_path/'courseweave.json').read_text())
    data['modules'][0]['phases'][0]['surfaces'][0]['label'] = fixture['source_label']
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    model = CountingTestModel(call_tools=[],custom_output_text=fixture['profiles'][profile]['response'])
    app.state.professor_model_factory = _configured_factory(model)
    client.post('/api/context', headers=AUTH, json={'source_id':'lesson-source','sequence':2,'active_path':'lesson.md','active_cell_id':None,'active_cell_tags':[],'surface_kind':None,'explicit_module_id':None,'explicit_phase_id':None,'video_seconds':None,'terminal_surface_id':None})
    assert client.post('/api/guide/lesson',headers=AUTH,json={'thread_id':'thread-one','source_id':'lesson-source','action':'use_lesson'}).status_code == 200
    response = client.post('/api/guide',headers=AUTH,json=_run_input())
    assert _events(response)[-1]['type'] == 'RUN_FINISHED'
    assert 'Every parallel tool call needs its matching result' in str(model.request_messages[-1])
    assert 'hidden answer' not in str(model.request_messages[-1])
    reply = ''.join(e['delta'] for e in _events(response) if e['type'] == 'TEXT_MESSAGE_CONTENT')
    assert 'ordinary text needs no tool result' in reply
    assert fixture['source_label'] in reply
    assert fixture['source_label'] in str(model.request_messages[-1])


def test_navigation_preserves_old_attribution_and_uses_new_policy(tmp_path):
    from test_agui import _manifest
    client, app = _client(tmp_path)
    data = _manifest()
    second = json.loads(json.dumps(data['modules'][0]['phases'][0]))
    second.update(id='second', title='Other lesson')
    second['teacher']['guidance']['text'] = 'NEW-POLICY'
    second['surfaces'][0]['path'] = 'other.md'
    data['modules'][0]['phases'].append(second)
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    model = CountingTestModel(call_tools=[],custom_output_text='First response')
    app.state.professor_model_factory = _configured_factory(model)
    def navigate(phase,seq):
        return client.post('/api/context', headers=AUTH,json={'source_id':'same-source','sequence':seq,'active_path':None,'active_cell_id':None,'active_cell_tags':[],'surface_kind':None,'explicit_module_id':'module-one','explicit_phase_id':phase,'video_seconds':None,'terminal_surface_id':None})
    assert navigate('phase-one',1).status_code == 200
    first = client.post('/api/guide',headers=AUTH,json=_run_input(prompt='first question',forwardedProps={'source_id':'same-source'}))
    assert navigate('second',2).status_code == 200
    second = client.post('/api/guide',headers=AUTH,json=_run_input(run_id='two',prompt='new question',forwardedProps={'source_id':'same-source'}))
    first_context = next(e['value'] for e in _events(first) if e.get('name')=='courseweave.turn_context')
    second_context = next(e['value'] for e in _events(second) if e.get('name')=='courseweave.turn_context')
    assert first_context['phase_id'] == 'phase-one'
    assert second_context['phase_id'] == 'second'
    assert 'first question' in str(model.request_messages[-1])
    assert 'NEW-POLICY' in str(model.request_messages[-1][-1].instructions)
    assert 'Previous turn attribution' in str(model.request_messages[-1])


def test_mixed_author_text_and_tool_runs_full_graph_before_candidate(tmp_path):
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
    client, app = _client(tmp_path)
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None,profile='stream-tools-v1')
    count = 0
    def function(messages, info):
        nonlocal count
        count += 1
        if count == 1:
            return ModelResponse(parts=[TextPart('I can draft that.'),ToolCallPart('suggest_activity_learning', {'summary':'Clarify the lesson','learning':{'overview':'Match every call ID.'}},tool_call_id='call-1')])
        assert any(getattr(part, 'tool_call_id',None) == 'call-1' for message in messages for part in message.parts if type(part).__name__ == 'ToolReturnPart')
        return ModelResponse(parts=[TextPart('Review the proposed learning metadata.')])
    app.state.professor_model_factory = _configured_factory(FunctionModel(function))
    response = client.post('/api/author/guide',headers=AUTH,json=_run_input(forwardedProps={'action':'edit_learning'}))
    assert _events(response)[-1]['type'] == 'RUN_FINISHED'
    assert count == 2
    assert any(e.get('name')=='courseweave.proposal_candidate' for e in _events(response))
    assert app.state.course_store.list_proposals() == []


@pytest.mark.parametrize('mode', ['invalid', 'refused', 'truncated', 'source_changed'])
def test_failed_author_tool_data_never_publishes_candidate(tmp_path,mode):
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
    client, app = _client(tmp_path)
    before = (tmp_path/'courseweave.json').read_bytes()
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None,profile='stream-tools-v1')
    count = 0
    def function(messages,info):
        nonlocal count
        count += 1
        if count == 1:
            payload = {'summary':'Draft', 'learning':{'unknown': 'bad'} if mode == 'invalid' else {'overview':'valid'}}
            return ModelResponse(parts=[ToolCallPart('suggest_activity_learning',payload,tool_call_id='call-1')],finish_reason='length' if mode == 'truncated' else 'content_filter' if mode == 'refused' else 'tool_call')
        if mode == 'source_changed':
            (tmp_path/'courseweave.json').write_bytes(before+b'\n')
        return ModelResponse(parts=[TextPart('Review this.')])
    app.state.professor_model_factory = _configured_factory(FunctionModel(function))
    response = client.post('/api/author/guide',headers=AUTH,json=_run_input(forwardedProps={'action':'edit_learning'}))
    assert _events(response)[-1]['type'] == 'RUN_ERROR'
    assert app.state.proposal_candidates == {}
    assert app.state.guide_history == {}
    assert app.state.course_store.list_proposals() == []


def test_adapter_obeys_text_only_capability_even_when_caller_requests_stream():
    from courseweave.providers import ProviderAdapter
    class TextOnlyModel(CountingTestModel):
        async def request_stream(self, *args, **kwargs):
            raise AssertionError('Text-only profile attempted streaming')
    model = TextOnlyModel(call_tools=[], custom_output_text='Useful fallback')
    adapter = ProviderAdapter(model, config=ProviderConfig(provider=None, profile='text-only-v1'))
    result = adapter.complete_sync('Explain',stream=True)
    assert result.status == 'ok'
    # TestModel advertises the actual request mode used by the application boundary.
    assert adapter.config.capabilities.streaming is False


def test_whole_run_timeout_is_classified_and_cleans_up(tmp_path):
    import asyncio
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.messages import ModelResponse, TextPart
    client, app = _client(tmp_path)
    async def slow(messages,info):
        await asyncio.sleep(0.1)
        return ModelResponse(parts=[TextPart('late')])
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None,profile='text-only-v1',run_timeout_seconds=0.01)
    app.state.professor_model_factory = _configured_factory(FunctionModel(slow))
    response = client.post('/api/guide',headers=AUTH,json=_run_input())
    assert _events(response)[-1]['code'] == 'timeout'
    assert app.state.guide_busy == set()
    assert app.state.guide_history == {}


def test_opt_out_never_advertises_profile_mutation_tool(tmp_path):
    client, app = _client(tmp_path)
    data = json.loads((tmp_path/'courseweave.json').read_text())
    data['policies']['allowed_proposal_types'] = ['profile']
    data['modules'][0]['phases'][0]['teacher']['proposals']['allow'] = ['profile']
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    model = CountingTestModel(call_tools=[],custom_output_text='Optional prose')
    app.state.professor_model_factory = _configured_factory(model)
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None,profile='stream-tools-v1')
    client.post('/api/guide',headers=AUTH,json=_run_input())
    assert model.last_model_request_parameters.function_tools == []


def test_replay_does_not_clear_history_only_because_selected_evidence_differs(tmp_path):
    from courseweave.teaching import replay_dependency
    from courseweave.contracts import CourseManifest
    from courseweave.state_contracts import LearnerState
    from test_agui import _manifest
    manifest = CourseManifest.model_validate(_manifest())
    assert replay_dependency(manifest,LearnerState(),{'check_facts':[{'check_id':'old'}]}) == replay_dependency(manifest,LearnerState(),{'check_facts':[]})


def test_disconnect_immediately_after_run_started_closes_owned_adapter(tmp_path):
    import asyncio
    from test_agui import CloseTrackingClient, _configured_factory_with_client, TOKEN
    client, app = _client(tmp_path)
    tracker = CloseTrackingClient()
    model = CountingTestModel(call_tools=[],custom_output_text='must not run')
    app.state.professor_model_factory = _configured_factory_with_client(model,tracker)
    client.post('/api/share',headers=AUTH,json={'run_id':'run-one','kind':'text','content':'private'})
    body = json.dumps(_run_input()).encode()
    async def exercise():
        started = asyncio.Event()
        first = True
        async def receive():
            nonlocal first
            if first:
                first = False
                return {'type':'http.request','body':body,'more_body':False}
            await started.wait()
            return {'type':'http.disconnect'}
        async def send(message):
            if b'RUN_STARTED' in message.get('body',b''):
                started.set()
                await asyncio.sleep(0.01)
        await app({'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'POST','scheme':'http','path':'/api/guide','raw_path':b'/api/guide','query_string':b'', 'headers':[(b'authorization',f'Bearer {TOKEN}'.encode()),(b'content-type',b'application/json'),(b'cookie',f'courseweave_session={client.cookies["courseweave_session"]}'.encode())], 'client':('127.0.0.1',1234),'server':('127.0.0.1',8000)},receive,send)
    asyncio.run(exercise())
    assert tracker.close_calls == 1
    assert app.state.guide_busy == set()
    assert app.state.shared_runs == {}


def test_reset_during_provider_run_rejects_stale_completion_and_busy_run(tmp_path):
    import asyncio
    import httpx2
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.messages import ModelResponse, TextPart
    client, app = _client(tmp_path)
    client.get('/api/state',headers=AUTH)
    client.post('/api/guide/action',headers=AUTH,json={'thread_id':'thread-one','action':'decline_revisit'})
    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()
        async def model(messages,info):
            started.set()
            await release.wait()
            return ModelResponse(parts=[TextPart('old answer')])
        app.state.provider_config_factory = lambda: ProviderConfig(provider=None,profile='text-only-v1')
        app.state.professor_model_factory = _configured_factory(FunctionModel(model))
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app),base_url='http://127.0.0.1',headers=AUTH,cookies={'courseweave_session':client.cookies['courseweave_session']}) as browser:
            pending = asyncio.create_task(browser.post('/api/guide',json=_run_input()))
            await asyncio.wait_for(started.wait(), 3)
            busy = await browser.post('/api/guide',json=_run_input(run_id='busy'))
            assert busy.status_code == 409 and busy.json()['code']=='conversation_busy'
            action = await browser.post('/api/guide/lesson',json={'thread_id':'thread-one','action':'reset_lesson'})
            assert action.status_code == 409
            view = (await browser.get('/api/state')).json()
            reset = await browser.patch('/api/state',headers={'Idempotency-Key':'reset-during-run'},json={'origin':'student_requested','expected_revision':view['revision'],'operation':{'type':'reset_state'}})
            assert reset.status_code == 200
            release.set()
            response = await pending
            assert _events(response)[-1]['type']=='RUN_ERROR'
    asyncio.run(exercise())
    assert app.state.guide_history == {}
    assert app.state.proposal_candidates == {}
    assert app.state.guide_busy == set()


@pytest.mark.parametrize('endpoint,body', [('/api/guide',_run_input(forwardedProps={'action':[]})),('/api/guide/lesson',{'thread_id':'thread-one','action':{}}),('/api/guide/action',{'thread_id':'thread-one','action':[]})])
def test_untyped_action_is_safely_rejected(tmp_path,endpoint,body):
    client, app = _client(tmp_path)
    response = client.post(endpoint,headers=AUTH,json=body)
    assert response.status_code == 422
    assert response.json()['code'] == 'validation_error'


def test_closed_gate_uses_authored_prompt_without_provider(tmp_path):
    client, app = _client(tmp_path,kind='predict')
    data = json.loads((tmp_path/'courseweave.json').read_text())
    prompt = 'Predict which tool call has no matching result.'
    data['modules'][0]['phases'][0]['completion']['requirements'][0]['prompt'] = prompt
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    def forbidden(config):
        raise AssertionError('A closed gate cannot construct a provider')
    app.state.professor_model_factory = forbidden
    response = client.post('/api/guide',headers=AUTH,json=_run_input())
    assert prompt in response.text
    assert 'Try your own response first.' in response.text


def test_reset_at_preflight_await_cannot_adopt_new_epoch_for_old_state(tmp_path,monkeypatch):
    from starlette.requests import Request
    client, app = _client(tmp_path)
    model = CountingTestModel(call_tools=[],custom_output_text='must not run')
    app.state.professor_model_factory = _configured_factory(model)
    async def revoke_at_await(self):
        app.state.privacy_epoch += 1
        return False
    monkeypatch.setattr(Request,'is_disconnected',revoke_at_await)
    response = client.post('/api/guide',headers=AUTH,json=_run_input())
    assert response.status_code == 409
    assert response.json()['code'] == 'context_revoked'
    assert model.calls == 0
    assert app.state.guide_busy == set()


@pytest.mark.parametrize('mode',['oversized','symlink','unsupported','arbitrary_path'])
def test_lesson_admission_fails_closed_for_unapproved_content(tmp_path,mode):
    client, app = _client(tmp_path)
    body = {'thread_id':'thread-one','source_id':'lesson-source','action':'use_lesson'}
    if mode == 'oversized':
        (tmp_path/'lesson.md').write_text('x'*262145)
    elif mode == 'symlink':
        secret = tmp_path.parent/'outside-secret.txt'
        secret.write_text('outside-private-content')
        (tmp_path/'lesson.md').symlink_to(secret)
    elif mode == 'unsupported':
        data = json.loads((tmp_path/'courseweave.json').read_text())
        data['modules'][0]['phases'][0]['surfaces'][0]['type'] = 'source'
        (tmp_path/'courseweave.json').write_text(json.dumps(data))
    else:
        body['path'] = '../outside-secret.txt'
    response = client.post('/api/guide/lesson',headers=AUTH,json=body)
    assert response.status_code == 422
    assert 'outside-private-content' not in response.text
    assert app.state.lesson_scopes == {}


def test_stale_check_objective_cannot_support_feedback_or_replay(tmp_path):
    client, app = _client(tmp_path)
    data = _learning(tmp_path)
    view = client.get('/api/state',headers=AUTH).json()
    client.patch('/api/state',headers={**AUTH,'Idempotency-Key':'check'},json={'origin':'student_requested','expected_revision':view['revision'],'operation':{'type':'check_attempt','module_id':'module-one','phase_id':'phase-one','check_id':'quiz','option_id':'yes','curriculum_digest':view['curriculum_digest']}})
    model = CountingTestModel(call_tools=[],custom_output_text='stale feedback echo')
    app.state.professor_model_factory = _configured_factory(model)
    client.post('/api/guide',headers=AUTH,json=_run_input())
    data['modules'][0]['phases'][0]['learning']['objectives'][0]['text'] = 'A substantively different objective'
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    client.post('/api/guide',headers=AUTH,json=_run_input(run_id='changed'))
    assert 'Only actual tool calls require results' not in str(model.request_messages[-1])
    assert 'stale feedback echo' not in str(model.request_messages[-1])


def test_blocked_guide_hint_does_not_advance_authored_ladder(tmp_path):
    client, app = _client(tmp_path,kind='predict')
    _learning(tmp_path)
    client.post('/api/guide',headers=AUTH,json=_run_input(forwardedProps={'action':'hint','objective_id':'pairing'}))
    assert not any(app.state.hint_cursors.values())


def test_manifest_race_between_registry_and_state_snapshot_rejects_before_provider(tmp_path,monkeypatch):
    from courseweave.store import CourseStore
    client, app = _client(tmp_path)
    model = CountingTestModel(call_tools=[],custom_output_text='must not run')
    app.state.professor_model_factory = _configured_factory(model)
    original = CourseStore.state_view
    def changed_snapshot(self,*args,**kwargs):
        if kwargs.get('include_manifest'):
            path = tmp_path/'courseweave.json'
            data = json.loads(path.read_text())
            data['title'] = 'Changed between reads'
            path.write_text(json.dumps(data))
        return original(self,*args,**kwargs)
    monkeypatch.setattr(CourseStore,'state_view',changed_snapshot)
    response = client.post('/api/guide',headers=AUTH,json=_run_input())
    assert response.status_code == 409
    assert response.json()['code'] == 'context_changed'
    assert model.calls == 0


@pytest.mark.parametrize('target,payload_extra', [('other.json',False),('courseweave.json',True)])
def test_full_author_candidate_rejects_invalid_target_or_payload(tmp_path,target,payload_extra):
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
    from test_agui import _manifest
    client, app = _client(tmp_path)
    calls = 0
    def model(messages,info):
        nonlocal calls
        calls += 1
        if calls == 1:
            payload = {'manifest':_manifest()}
            if payload_extra:
                payload['raw_chat'] = 'must not become a candidate'
            return ModelResponse(parts=[ToolCallPart('suggest_manifest_replace',{'summary':'draft','target':target,'payload':payload})])
        return ModelResponse(parts=[TextPart('Review it.')])
    app.state.professor_model_factory = _configured_factory(FunctionModel(model))
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None,profile='stream-tools-v1')
    response = client.post('/api/author/guide',headers=AUTH,json=_run_input())
    assert _events(response)[-1]['type']=='RUN_ERROR'
    assert app.state.proposal_candidates == {}


def test_empty_author_can_still_draft_and_persist_a_reviewable_candidate(tmp_path):
    from fastapi.testclient import TestClient
    from courseweave.api import create_app
    from test_agui import ProposalSuccessModel, TOKEN
    app = create_app(tmp_path,capability_token=TOKEN)
    app.state.professor_model_factory = _configured_factory(ProposalSuccessModel())
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None,profile='stream-tools-v1')
    with TestClient(app) as client:
        response = client.post('/api/author/guide',headers=AUTH,json=_run_input())
        assert _events(response)[-1]['type']=='RUN_FINISHED'
        candidate = next(e['value']['candidate'] for e in _events(response) if e.get('name')=='courseweave.proposal_candidate')
        assert candidate['target_hash'] is None
        persisted = client.post('/api/proposals',headers={**AUTH,'Idempotency-Key':'draft-candidate'},json={'candidate_id':candidate['id']})
        assert persisted.status_code == 201
        assert not (tmp_path/'courseweave.json').exists()


def _continuity_course(tmp_path):
    client, app = _client(tmp_path)
    data = _learning(tmp_path)
    phase = data['modules'][0]['phases'][0]
    phase['completion']['requirements'] = [{'id':'prediction','type':'learner_record','record_kind':'text','prompt':'Predict which calls need results.'}]
    second = json.loads(json.dumps(phase))
    second.update(id='next-activity',title='Next activity')
    second['surfaces'][0]['path'] = 'next.md'
    second['teacher']['guidance']['text'] = 'CURRENT-SECOND-POLICY'
    data['modules'][0]['phases'].append(second)
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    model = CountingTestModel(call_tools=[],custom_output_text='Earlier allowed explanation')
    app.state.professor_model_factory = _configured_factory(model)
    return client, app, model


def _navigate_continuity(client, phase, sequence):
    response = client.post('/api/context',headers=AUTH,json={'source_id':'flow-source','sequence':sequence,'active_path':None,'active_cell_id':None,'active_cell_tags':[],'surface_kind':None,'explicit_module_id':'module-one','explicit_phase_id':phase,'video_seconds':None,'terminal_surface_id':None})
    assert response.status_code == 200


def _submit_continuity_evidence(client, kind, key, text='My first prediction'):
    view = client.get('/api/state',headers=AUTH).json()
    if kind == 'check_attempt':
        operation = {'type':'check_attempt','module_id':'module-one','phase_id':'phase-one','check_id':'quiz','option_id':'yes'}
    else:
        operation = {'type':kind,'coordinate':{'module_id':'module-one','phase_id':'phase-one','requirement_id':'prediction'}}
        if kind == 'put_record':
            operation['value'] = {'text':text}
    operation['curriculum_digest'] = view['curriculum_digest']
    response = client.patch('/api/state',headers={**AUTH,'Idempotency-Key':key},json={'origin':'student_requested','expected_revision':view['revision'],'operation':operation})
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize('evidence_kind',['put_record','check_attempt'])
def test_new_evidence_preserves_conversation_across_submission_and_navigation(tmp_path,evidence_kind):
    client, app, model = _continuity_course(tmp_path)
    _navigate_continuity(client,'phase-one',1)
    initial = client.post('/api/guide',headers=AUTH,json=_run_input(prompt='Keep my opening question in context',forwardedProps={'source_id':'flow-source'}))
    assert _events(initial)[-1]['type']=='RUN_FINISHED'
    submitted = _submit_continuity_evidence(client,evidence_kind,'first-evidence')
    _navigate_continuity(client,'next-activity',2)
    response = client.post('/api/guide',headers=AUTH,json=_run_input(run_id='after-submission',prompt='Continue our conversation',forwardedProps={'source_id':'flow-source'}))
    assert _events(response)[-1]['type']=='RUN_FINISHED'
    replay = str(model.request_messages[-1])
    assert 'Keep my opening question in context' in replay
    assert 'Earlier allowed explanation' in replay
    assert 'Previous turn attribution' in replay and 'phase-one' in replay
    assert 'CURRENT-SECOND-POLICY' in str(model.request_messages[-1][-1].instructions)
    context = next(e['value'] for e in _events(response) if e.get('name')=='courseweave.turn_context')
    assert context['state_revision'] == submitted['revision']
    assert context['phase_id'] == 'next-activity'


def test_opted_out_evidence_added_in_other_session_does_not_erase_conversation(tmp_path):
    from fastapi.testclient import TestClient
    client, app, model = _continuity_course(tmp_path)
    _navigate_continuity(client,'phase-one',1)
    client.post('/api/guide',headers=AUTH,json=_run_input(prompt='Keep the current conversation',forwardedProps={'source_id':'flow-source'}))
    with TestClient(app) as other:
        _submit_continuity_evidence(other,'put_record','other-session-record',text='UNSHARED-OTHER-SESSION-ANSWER')
    client.post('/api/guide',headers=AUTH,json=_run_input(run_id='after-other-action',forwardedProps={'source_id':'flow-source'}))
    replay = str(model.request_messages[-1])
    assert 'Keep the current conversation' in replay
    assert 'Earlier allowed explanation' in replay
    assert 'UNSHARED-OTHER-SESSION-ANSWER' not in replay


@pytest.mark.parametrize('change',['clear_record','replace_record','reset_state'])
def test_removed_or_replaced_evidence_still_drops_dependent_echo_chain(tmp_path,change):
    client, app, model = _continuity_course(tmp_path)
    _navigate_continuity(client,'phase-one',1)
    _submit_continuity_evidence(client,'put_record','prediction-before-chat')
    response = client.post('/api/guide',headers=AUTH,json=_run_input(prompt='Explain my submitted prediction',forwardedProps={'source_id':'flow-source'}))
    assert _events(response)[-1]['type']=='RUN_FINISHED'
    assert 'My first prediction' in str(model.request_messages[-1])
    if change == 'reset_state':
        view = client.get('/api/state',headers=AUTH).json()
        assert client.patch('/api/state',headers={**AUTH,'Idempotency-Key':'reset-evidence'},json={'origin':'student_requested','expected_revision':view['revision'],'operation':{'type':'reset_state'}}).status_code == 200
    else:
        _submit_continuity_evidence(client,'put_record' if change=='replace_record' else change,'change-evidence',text='Replacement prediction')
    client.post('/api/guide',headers=AUTH,json=_run_input(run_id='after-removal',prompt='Start with the current evidence',forwardedProps={'source_id':'flow-source'}))
    replay = str(model.request_messages[-1])
    assert 'Earlier allowed explanation' not in replay
    assert 'Explain my submitted prediction' not in replay
    assert 'My first prediction' not in replay


@pytest.mark.parametrize('navigate',[False,True])
def test_direct_objective_hint_is_replayed_in_ordinary_followup(tmp_path,navigate):
    client, app, model = _continuity_course(tmp_path)
    data = json.loads((tmp_path/'courseweave.json').read_text())
    data['modules'][0]['phases'][0]['learning']['hints'][0]['text'] = 'UNIQUE-DIRECT-HINT-REFERENCE'
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    _navigate_continuity(client,'phase-one',1)
    hint = client.post('/api/guide/action',headers=AUTH,json={'thread_id':'thread-one','source_id':'flow-source','action':'hint','objective_id':'pairing'})
    assert hint.status_code == 200 and hint.json()['hint']['text']=='UNIQUE-DIRECT-HINT-REFERENCE'
    if navigate:
        _navigate_continuity(client,'next-activity',2)
    response = client.post('/api/guide',headers=AUTH,json=_run_input(prompt='Please explain the hint you just gave me.',forwardedProps={'source_id':'flow-source'}))
    assert _events(response)[-1]['type']=='RUN_FINISHED'
    replay = str(model.request_messages[-1])
    assert 'UNIQUE-DIRECT-HINT-REFERENCE' in replay
    assert 'Previous turn attribution' in replay
    assert 'phase-one' in replay and 'pairing' in replay
    assert app.state.course_store.get_state().revision == 0


def test_oversized_gated_turn_does_not_poison_small_followup_after_prediction(tmp_path):
    client, app = _client(tmp_path,kind='predict')
    model = CountingTestModel(call_tools=[],custom_output_text='Now we can continue.')
    app.state.professor_model_factory = _configured_factory(model)
    blocked = client.post('/api/guide',headers=AUTH,json=_run_input(prompt='x'*70000))
    assert _events(blocked)[-1]['type']=='RUN_FINISHED'
    assert model.calls == 0
    view = client.get('/api/state',headers=AUTH).json()
    submit = client.patch('/api/state',headers={**AUTH,'Idempotency-Key':'open-large-turn-gate'},json={'origin':'student_requested','expected_revision':view['revision'],'operation':{'type':'put_record','coordinate':{'module_id':'module-one','phase_id':'phase-one','requirement_id':'prediction-one'},'value':{'text':'My prediction'},'curriculum_digest':view['curriculum_digest']}})
    assert submit.status_code == 200
    for run_id in ('small-followup','another-followup'):
        response = client.post('/api/guide',headers=AUTH,json=_run_input(run_id=run_id,prompt='Please help.'))
        assert _events(response)[-1]['type']=='RUN_FINISHED'
    assert model.calls == 2
    assert len(str(next(iter(app.state.guide_history.values())))) <= 32000
    assert 'x'*70000 not in str(model.request_messages[-1])


def test_replay_budget_reserves_current_request_and_instructions_with_complete_turns(tmp_path):
    client, app = _client(tmp_path)
    model = CountingTestModel(call_tools=[],custom_output_text='Earlier response')
    app.state.professor_model_factory = _configured_factory(model)
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None,profile='text-only-v1',max_input_chars=8000)
    for i in range(3):
        response = client.post('/api/guide',headers=AUTH,json=_run_input(run_id=f'budget-{i}',prompt=f'old-question-{i} '+'a'*1200))
        assert _events(response)[-1]['type']=='RUN_FINISHED'
    response = client.post('/api/guide',headers=AUTH,json=_run_input(run_id='large-current',prompt='current question '+'b'*3000))
    assert _events(response)[-1]['type']=='RUN_FINISHED'
    messages = model.request_messages[-1]
    assert 'old-question-0' not in str(messages)
    assert len(messages) % 2 == 1  # Complete old request/response pairs plus this request.
    assert 'current question' in str(messages[-1])


@pytest.mark.parametrize('endpoint',['direct','model'])
def test_explicit_no_hint_policy_blocks_both_hint_actions_without_progression(tmp_path,endpoint):
    client, app, model = _continuity_course(tmp_path)
    data = json.loads((tmp_path/'courseweave.json').read_text())
    data['modules'][0]['phases'][0]['teacher']['guidance']['hint_level'] = 'none'
    data['modules'][0]['phases'][0]['learning']['hints'][0]['text'] = 'NO-HINT-POLICY-CONTENT'
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    _navigate_continuity(client,'phase-one',1)
    if endpoint == 'direct':
        response = client.post('/api/guide/action',headers=AUTH,json={'thread_id':'thread-one','source_id':'flow-source','action':'hint','objective_id':'pairing'})
        assert response.status_code == 200
        assert response.json()['status']=='blocked'
        assert response.json()['hint'] is None
    else:
        response = client.post('/api/guide',headers=AUTH,json=_run_input(forwardedProps={'source_id':'flow-source','action':'hint','objective_id':'pairing'}))
        assert _events(response)[-1]['type']=='RUN_FINISHED'
        assert 'Hints are unavailable for this activity.' in response.text
    assert 'NO-HINT-POLICY-CONTENT' not in response.text
    assert model.calls == 0
    assert not any(app.state.hint_cursors.values())


@pytest.mark.parametrize('revoke',['lesson_reset','state_reset','curriculum_change','consent_revocation'])
def test_direct_hint_replay_obeys_existing_context_revocation(tmp_path,revoke):
    client, app, model = _continuity_course(tmp_path)
    data = json.loads((tmp_path/'courseweave.json').read_text())
    data['modules'][0]['phases'][0]['learning']['hints'][0]['text'] = 'REVOKABLE-DIRECT-HINT'
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    _navigate_continuity(client,'phase-one',1)
    if revoke == 'consent_revocation':
        view = client.get('/api/state',headers=AUTH).json()
        assert client.patch('/api/state',headers={**AUTH,'Idempotency-Key':'hint-consent'},json={'origin':'student_requested','expected_revision':view['revision'],'operation':{'type':'set_preferences','preferences':{'enabled':True}}}).status_code == 200
    hint = client.post('/api/guide/action',headers=AUTH,json={'thread_id':'thread-one','source_id':'flow-source','action':'hint','objective_id':'pairing'})
    assert hint.json()['status']=='hint'
    if revoke == 'lesson_reset':
        assert client.post('/api/guide/lesson',headers=AUTH,json={'thread_id':'thread-one','action':'reset_lesson'}).status_code == 200
    elif revoke == 'curriculum_change':
        data['modules'][0]['phases'][0]['learning']['hints'][0]['text'] = 'Changed authored hint'
        (tmp_path/'courseweave.json').write_text(json.dumps(data))
    else:
        view = client.get('/api/state',headers=AUTH).json()
        operation = {'type':'reset_state'} if revoke=='state_reset' else {'type':'set_preferences','preferences':{'enabled':False}}
        assert client.patch('/api/state',headers={**AUTH,'Idempotency-Key':'revoke-hint'},json={'origin':'student_requested','expected_revision':view['revision'],'operation':operation}).status_code == 200
    client.post('/api/guide',headers=AUTH,json=_run_input(prompt='Continue with current context',forwardedProps={'source_id':'flow-source'}))
    assert 'REVOKABLE-DIRECT-HINT' not in str(model.request_messages[-1])


@pytest.mark.parametrize('level',['gentle','graduated','full'])
def test_non_none_hint_levels_keep_authored_array_order(tmp_path,level):
    client, app, model = _continuity_course(tmp_path)
    data = json.loads((tmp_path/'courseweave.json').read_text())
    data['modules'][0]['phases'][0]['teacher']['guidance']['hint_level'] = level
    (tmp_path/'courseweave.json').write_text(json.dumps(data))
    _navigate_continuity(client,'phase-one',1)
    for index in (1,2):
        response = client.post('/api/guide/action',headers=AUTH,json={'thread_id':'thread-one','source_id':'flow-source','action':'hint','objective_id':'pairing'})
        assert response.json()['status']=='hint'
        assert response.json()['hint_index']==index
        assert response.json()['hint']['id']==data['modules'][0]['phases'][0]['learning']['hints'][index-1]['id']
    assert model.calls==0


def test_oversized_current_request_is_input_limit_and_does_not_poison_replay(tmp_path):
    client, app = _client(tmp_path)
    model = CountingTestModel(call_tools=[],custom_output_text='A small answer')
    app.state.professor_model_factory = _configured_factory(model)
    app.state.provider_config_factory = lambda: ProviderConfig(provider=None,profile='text-only-v1',max_input_chars=5000)
    response = client.post('/api/guide',headers=AUTH,json=_run_input(prompt='x'*6000))
    assert _events(response)[-1]['type']=='RUN_ERROR'
    assert _events(response)[-1]['code']=='input_limit'
    assert model.calls==0 and app.state.guide_history=={}
    followup = client.post('/api/guide',headers=AUTH,json=_run_input(run_id='small-after-input-limit',prompt='Please help.'))
    assert _events(followup)[-1]['type']=='RUN_FINISHED'
    assert model.calls==1


def test_direct_hint_attribution_rejects_mixed_manifest_snapshot(tmp_path,monkeypatch):
    from courseweave.store import CourseStore
    client, app, model = _continuity_course(tmp_path)
    _navigate_continuity(client,'phase-one',1)
    original = CourseStore.state_view
    def changed_snapshot(self,*args,**kwargs):
        path = tmp_path/'courseweave.json'
        data = json.loads(path.read_text())
        data['title'] = 'Changed during direct hint preparation'
        path.write_text(json.dumps(data))
        return original(self,*args,**kwargs)
    monkeypatch.setattr(CourseStore,'state_view',changed_snapshot)
    response = client.post('/api/guide/action',headers=AUTH,json={'thread_id':'thread-one','source_id':'flow-source','action':'hint','objective_id':'pairing'})
    assert response.status_code==409
    assert response.json()['code']=='context_changed'
    assert app.state.guide_history=={} and app.state.hint_cursors=={}
    assert model.calls==0
