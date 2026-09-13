from copy import deepcopy
import json
from pathlib import Path
import pytest
from pydantic import ValidationError
from jsonschema import Draft202012Validator
from courseweave.contracts import CourseManifest, manifest_schema
from courseweave.engine import requirement_digest, curriculum_digest
from test_v2_foundation import course, coord

@pytest.mark.parametrize('fragment',['self-checks','section_01','S01-checks','a.b:c','x'*160])
def test_html_fragment_is_closed_presentation_metadata(fragment):
    data=course(); surface=data['modules'][0]['phases'][0]['surfaces'][0]; surface.update(type='html',fragment=fragment)
    manifest=CourseManifest.model_validate(data)
    assert manifest.modules[0].phases[0].surfaces[0].fragment==fragment
    without=deepcopy(data); without['modules'][0]['phases'][0]['surfaces'][0].pop('fragment')
    before=CourseManifest.model_validate(without)
    assert requirement_digest(before,coord())==requirement_digest(manifest,coord())
    assert curriculum_digest(before)!=curriculum_digest(manifest)
    assert not list(Draft202012Validator(manifest_schema()).iter_errors(data))

@pytest.mark.parametrize('fragment',['','#section','a/b','../section','a?query','a%20b','has space','a\n','x'*161])
def test_html_fragment_rejects_path_query_and_controls(fragment):
    data=course(); data['modules'][0]['phases'][0]['surfaces'][0].update(type='html',fragment=fragment)
    with pytest.raises(ValidationError): CourseManifest.model_validate(data)
    assert list(Draft202012Validator(manifest_schema()).iter_errors(data))


def test_all_schema_copies_match_generated_contract():
    root=Path(__file__).parents[2]
    copies=[root/'src/courseweave/contracts/courseweave.schema.json',root/'src/courseweave/courseweave.schema.json',root/'docs/contracts/courseweave.schema.json']
    assert all(json.loads(p.read_text())==manifest_schema() for p in copies)
    assert len({p.read_bytes() for p in copies})==1
