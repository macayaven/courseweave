"""The author profile consumes canonical rules and reports its untested scope."""

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess

from fastapi.testclient import TestClient
import pytest

from courseweave.api import create_app
from courseweave.engine.manifest import parse_manifest_data, ManifestValidationError
from test_author_api import manifest

AUTH = {"Authorization": "Bearer author-profile-test"}


@pytest.fixture
def course(tmp_path):
    data = manifest()
    (tmp_path / "lesson.md").write_text("# Read\nA local lesson.\n")
    return data, tmp_path


def test_author_metadata_is_not_a_student_manifest_field(course):
    data, root = course
    data["author_research_policy"] = {"network_enabled": True}
    with pytest.raises(ManifestValidationError):
        parse_manifest_data(data, root)


@pytest.mark.parametrize("version", ["0.2.0", "0.3.0"])
def test_each_profile_preserves_valid_course_and_unperformed_checks(course, version):
    from courseweave.author.quality import check_manifest, student_profile
    data, root = course
    original = copy.deepcopy(data)
    report = check_manifest(data, root, student_profile(version))
    assert report.passed
    assert report.profile.application_version == version
    assert any(issue.code == "installed_execution_not_checked" for issue in report.not_performed)
    assert any(issue.code == "linked_assets_not_checked" for issue in report.not_performed)
    assert data == original
    assert not (root / "courseweave.json").exists()


@pytest.mark.parametrize("invalid", ["author_metadata", "surface", "check", "gate"])
def test_incompatible_contracts_have_actionable_structural_issues(course, invalid):
    from courseweave.author.quality import check_manifest, student_profile
    data, root = course
    phase = data["modules"][0]["phases"][0]
    if invalid == "author_metadata":
        data["author_research_policy"] = {"network_enabled": True}
        path = "/author_research_policy"
    elif invalid == "surface":
        phase["surfaces"][0]["type"] = "rich_document"
        path = "/modules/0/phases/0/surfaces/0"
    elif invalid == "check":
        phase["learning"] = {"checks": [{"id": "exam", "type": "mastery_exam"}]}
        path = "/modules/0/phases/0/learning/checks/0"
    else:
        phase["teacher"]["access"]["requires"] = ["unrecorded"]
        path = "/modules/0/phases/0"
    report = check_manifest(data, root, student_profile())
    assert not report.passed
    assert any(issue.location.startswith(path) for issue in report.structural)


def test_overlapping_notebook_selection_is_the_existing_engine_error(course):
    from courseweave.author.quality import check_manifest, student_profile
    data, root = course
    data["runtime"] = {"type": "jupyter", "kernel": {"type": "python_uv_project"}}
    phase = data["modules"][0]["phases"][0]
    phase["surfaces"] = [{"id": "notebook", "purpose": "primary", "type": "notebook",
                          "label": "Practice", "path": "practice.ipynb",
                          "selector": {"type": "cell_ids", "values": ["predict"]}}]
    other = copy.deepcopy(phase)
    other["id"] = "second-phase"
    data["modules"][0]["phases"].append(other)
    (root / "practice.ipynb").write_text(json.dumps({"nbformat": 4, "nbformat_minor": 5,
        "metadata": {}, "cells": [{"id": "predict", "cell_type": "markdown",
                                   "metadata": {}, "source": ["Predict.\n"]}]}))
    report = check_manifest(data, root, student_profile())
    assert not report.passed
    assert any(issue.code == "phase_context_ambiguous" for issue in report.assets)


def test_workspace_declarations_do_not_claim_assistant_write_support(course):
    from courseweave.author.quality import check_manifest, student_profile
    data, root = course
    data["policies"]["allowed_proposal_types"] = ["workspace"]
    data["policies"]["workspace_write_globs"] = ["notebooks/**"]
    report = check_manifest(data, root, student_profile())
    assert report.passed
    issue = next(issue for issue in report.profile_issues if issue.code == "workspace_proposals_inactive")
    assert issue.severity == "warning"
    assert issue.location == "/policies/allowed_proposal_types"


def test_candidate_profile_is_bound_to_the_released_schema():
    from courseweave.author.quality import student_profile
    profile = student_profile()
    assert profile.schema_sha256 == "28ffd9b10fdcf4089e003db686924349c5fd488757de6f424bf11a26482d8839"
    path = Path(__file__).resolve().parents[1] / "src/courseweave/contracts/courseweave.schema.json"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == profile.schema_sha256


def test_compatibility_endpoint_is_authenticated_nonmutating_and_rejects_model_flags(course):
    data, root = course
    client = TestClient(create_app(course_root=root, capability_token="author-profile-test"))
    assert client.post("/api/author/compatibility", json={"manifest": data}).status_code == 403
    response = client.post("/api/author/compatibility", headers=AUTH, json={"manifest": data})
    assert response.status_code == 200
    assert response.json()["passed"]
    assert response.json()["profile"]["application_version"] == "0.2.0"
    assert not (root / "courseweave.json").exists()
    assert client.post("/api/author/compatibility", headers=AUTH,
                       json={"manifest": data, "passed": True}).status_code == 422


@pytest.mark.skipif(not os.environ.get("COURSEWEAVE_RELEASED_STUDENT_PYTHON"),
                    reason="separately installed released Student interpreter must be explicitly supplied")
def test_separately_installed_released_validator_rejects_author_metadata(course):
    data, _ = course
    data["author_research_policy"] = {"network_enabled": True}
    code = """
import json,sys,courseweave
from courseweave.engine.manifest import parse_manifest_data, ManifestValidationError
assert courseweave.__version__ == '0.2.0'
try:
    parse_manifest_data(json.load(sys.stdin))
except ManifestValidationError as exc:
    assert any(i['path'] == '/author_research_policy' for i in exc.issues)
    print('Released Student v0.2.0 rejected author metadata')
else:
    raise AssertionError('Released validator accepted author metadata')
"""
    result = subprocess.run([os.environ["COURSEWEAVE_RELEASED_STUDENT_PYTHON"], "-I", "-c", code],
                            input=json.dumps(data), capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
