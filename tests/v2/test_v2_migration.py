import json
from copy import deepcopy

import pytest

from courseweave.migration import convert_legacy, preview_legacy
from legacy_fixtures import VALID_ALL_VARIANTS


def legacy():
    data = deepcopy(VALID_ALL_VARIANTS)
    data['modules'][0]['phases'][1]['surfaces'][0]['match'].pop('cell_tags')
    data['modules'][0]['phases'][2]['surfaces'][0]['start_seconds'] = 2
    return data


def test_conversion_is_explicit_pure_preserves_ids_paths_and_reports_semantics(tmp_path):
    data = legacy(); original = deepcopy(data)
    result = convert_legacy(data)
    assert result.manifest is not None and not result.issues
    assert data == original
    new = result.manifest
    assert new.schema_version == 2 and new.id == data['id']
    assert new.modules[0].phases[0].surfaces[0].path == 'lesson.html'
    assert new.modules[0].phases[1].completion.requirements[0].id == 'prediction-one'
    assert new.modules[0].phases[0].completion.requirements[0].record_kind == 'attestation'
    assert {'version', 'experience', 'progress', 'teacher', 'completion', 'surface', 'policies', 'runtime'} <= {m.kind for m in result.mappings}
    path = tmp_path / 'legacy.json'; raw = json.dumps(data).encode(); path.write_bytes(raw)
    preview = preview_legacy(path)
    assert preview == result and path.read_bytes() == raw
    assert sorted(p.name for p in tmp_path.iterdir()) == ['legacy.json']


def test_ambiguous_selectors_and_unsupported_video_ranges_are_reported_without_conversion():
    result = convert_legacy(deepcopy(VALID_ALL_VARIANTS))
    assert result.manifest is None
    assert {'mixed_notebook_selector', 'unsupported_video_range'} <= {x.code for x in result.issues}


@pytest.mark.parametrize('bounds', [(1, None), (None, 4), (1.5, 4), (0, 2147483648)])
def test_no_video_range_truncation(bounds):
    data = legacy(); video = data['modules'][0]['phases'][2]['surfaces'][0]
    video['start_seconds'], video['end_seconds'] = bounds
    result = convert_legacy(data)
    assert result.manifest is None and 'unsupported_video_range' in {x.code for x in result.issues}


def test_legacy_reader_does_not_coerce_or_accept_v2():
    data = legacy(); data['schema_version'] = 2
    assert convert_legacy(data).manifest is None
    data = legacy(); data['policies']['max_shared_chars'] = '8192'
    assert convert_legacy(data).manifest is None
