"""Numeric bounds must constrain real documents in Python and JSON Schema."""
import json
from importlib.resources import files

import pytest
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from courseweave.contracts import CourseManifest, manifest_schema
from test_v2_models import _manifest


def document_with_numeric_field(field, value):
    document = _manifest()
    phase = document['modules'][0]['phases'][0]
    if field == 'max_shared_chars':
        document['policies'][field] = value
    elif field in {'min_minutes', 'max_minutes'}:
        phase['learning'] = {'duration': {'min_minutes': 1, 'max_minutes': 1440}}
        phase['learning']['duration'][field] = value
    else:
        phase['surfaces'] = [{
            'id': 'video', 'purpose': 'primary', 'type': 'video',
            'label': 'Video', 'src': 'lesson.mp4',
            'start_seconds': 0, 'end_seconds': 2147483647,
        }]
        phase['surfaces'][0][field] = value
    return document


@pytest.mark.parametrize(('field', 'value'), [
    ('max_shared_chars', 0), ('max_shared_chars', 131073),
    ('min_minutes', 0), ('min_minutes', 1441),
    ('max_minutes', 0), ('max_minutes', 1441),
    ('start_seconds', -1), ('start_seconds', 2147483648),
    ('end_seconds', -1), ('end_seconds', 2147483648),
])
def test_out_of_bounds_numbers_reject_in_models_and_both_schema_sources(field, value):
    document = document_with_numeric_field(field, value)
    with pytest.raises(ValidationError):
        CourseManifest.model_validate(document)
    packaged_schema = json.loads(files('courseweave.contracts').joinpath('courseweave.schema.json').read_bytes())
    for schema in (manifest_schema(), packaged_schema):
        assert list(Draft202012Validator(schema).iter_errors(document)), (field, value)


@pytest.mark.parametrize(('field', 'value'), [
    ('max_shared_chars', 1), ('max_shared_chars', 131072),
    ('min_minutes', 1), ('min_minutes', 1440),
    ('max_minutes', 1), ('max_minutes', 1440),
    ('start_seconds', 0), ('start_seconds', 2147483646),
    ('end_seconds', 1), ('end_seconds', 2147483647),
])
def test_valid_numeric_boundaries_and_video_ordering_remain_accepted(field, value):
    document = document_with_numeric_field(field, value)
    CourseManifest.model_validate(document)
    assert not list(Draft202012Validator(manifest_schema()).iter_errors(document))
