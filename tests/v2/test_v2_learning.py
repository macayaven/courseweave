import json
from copy import deepcopy
from importlib.resources import files

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from courseweave.contracts import CourseManifest, manifest_schema
from test_v2_models import _manifest


def learning():
    return {
        'objectives': [{'id': 'trace', 'text': 'Trace the request.'}],
        'duration': {'min_minutes': 20, 'max_minutes': 40},
        'overview': 'Follow one request through the system.',
        'hints': [{'id': 'first', 'text': 'Start at the input.', 'objective_ids': ['trace']}],
        'sources': [{'id': 'docs', 'label': 'Documentation', 'url': 'https://example.org/docs', 'reviewed_date': '2026-09-08'}],
        'checks': [{'id': 'route', 'type': 'single_choice', 'prompt': 'What runs first?',
                    'objective_ids': ['trace'], 'correct_option_id': 'input',
                    'options': [{'id': 'input', 'text': 'Input', 'feedback': 'Yes: input starts the request.'},
                                {'id': 'output', 'text': 'Output', 'feedback': 'Output follows processing.'}]}],
    }


def test_learning_roundtrip_and_generated_schema_authority():
    data = _manifest()
    data['modules'][0]['phases'][0]['learning'] = learning()
    model = CourseManifest.model_validate(data)
    schema = manifest_schema()
    assert schema == json.loads(files('courseweave.contracts').joinpath('courseweave.schema.json').read_bytes())
    Draft202012Validator.check_schema(schema)
    assert not list(Draft202012Validator(schema).iter_errors(model.model_dump(mode='json')))
    assert model.modules[0].phases[0].learning.sources[0].reviewed_date == '2026-09-08'
    for definition in schema['$defs'].values():
        if definition.get('type') == 'object':
            assert definition['additionalProperties'] is False


@pytest.mark.parametrize('edit', [
    lambda x: x['duration'].update(min_minutes=41),
    lambda x: x['duration'].update(min_minutes=True),
    lambda x: x['duration'].update(max_minutes='40'),
    lambda x: x['duration'].update(max_minutes=40.0),
    lambda x: x['objectives'].append(x['objectives'][0]),
    lambda x: x['hints'][0].update(objective_ids=['missing']),
    lambda x: x['checks'][0].update(objective_ids=['missing']),
    lambda x: x['checks'][0].update(correct_option_id='missing'),
    lambda x: x['checks'][0]['options'].append(x['checks'][0]['options'][0]),
    lambda x: x['checks'][0].update(grader='python:run'),
    lambda x: x['sources'][0].update(url='https://user:password@example.org'),
    lambda x: x['sources'][0].update(reviewed_date='2026-02-30'),
    lambda x: x.update(overview=' '),
    lambda x: x.update(hints=x['hints'] * 21),
])
def test_closed_learning_semantics(edit):
    data = _manifest(); content = learning(); edit(content)
    data['modules'][0]['phases'][0]['learning'] = content
    with pytest.raises(ValidationError):
        CourseManifest.model_validate(data)


@pytest.mark.parametrize('version', [1, True, '2', 2.0])
def test_literal_v2_without_coercion(version):
    data = _manifest(); data['schema_version'] = version
    with pytest.raises(ValidationError):
        CourseManifest.model_validate(data)


def test_empty_author_draft_roundtrips_explicit_null_entry():
    data = _manifest(); data.update(modules=[], entry_module_id=None)
    assert CourseManifest.model_validate(data).model_dump(mode='json')['entry_module_id'] is None
