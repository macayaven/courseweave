import json
from copy import deepcopy
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from courseweave.contracts.models import (
    Completion,
    CourseManifest,
    Experience,
    JupyterRuntime,
    LearnerRecordRequirement,
    NotebookSelector,
    Phase,
    Requirement,
    Surface,
    TeacherStyle,
)


def test_contract_objects_reject_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        LearnerRecordRequirement.model_validate({
            "id": "prediction",
            "type": "learner_record",
            "record_kind": "text",
            "prompt": "Predict.",
            "callback": "python:grade",
        })


@pytest.mark.parametrize(
    ("adapter", "payload", "expected_type"),
    [
        (TypeAdapter(Requirement), {"id": "prediction", "type": "learner_record", "record_kind": "text", "prompt": "Predict."}, "learner_record"),
        (TypeAdapter(Requirement), {"id": "artifact", "type": "artifact_exists", "prompt": "Create it.", "path": "notes/result.md"}, "artifact_exists"),
        (TypeAdapter(Experience), {"type": "builtin", "id": "prediction"}, "builtin"),
        (TypeAdapter(Experience), {"type": "custom", "id": "example.org/debate"}, "custom"),
        (TypeAdapter(TeacherStyle), {"type": "builtin", "id": "socratic"}, "builtin"),
        (TypeAdapter(TeacherStyle), {"type": "custom", "id": "example.org/coach"}, "custom"),
        (TypeAdapter(NotebookSelector), {"type": "whole_notebook"}, "whole_notebook"),
        (TypeAdapter(NotebookSelector), {"type": "cell_ids", "values": ["cell_1"]}, "cell_ids"),
        (TypeAdapter(NotebookSelector), {"type": "cell_tags", "values": ["exercise"], "match": "all"}, "cell_tags"),
        (TypeAdapter(Surface), {"id": "surface", "purpose": "primary", "type": "html", "label": "Surface", "path": "content.md"}, "html"),
        (TypeAdapter(Surface), {"id": "surface", "purpose": "primary", "type": "markdown", "label": "Surface", "path": "content.md"}, "markdown"),
        (TypeAdapter(Surface), {"id": "surface", "purpose": "primary", "type": "source", "label": "Surface", "path": "content.md"}, "source"),
        (TypeAdapter(Surface), {"id": "surface", "purpose": "primary", "type": "notebook", "label": "Surface", "path": "lesson.ipynb", "selector": {"type": "whole_notebook"}}, "notebook"),
        (TypeAdapter(Surface), {"id": "surface", "purpose": "primary", "type": "video", "label": "Surface", "src": "video.mp4"}, "video"),
        (TypeAdapter(Surface), {"id": "surface", "purpose": "primary", "type": "terminal", "label": "Surface", "command": ["uv", "run"], "cwd": "."}, "terminal"),
        (TypeAdapter(Surface), {"id": "surface", "purpose": "primary", "type": "external", "label": "Surface", "url": "https://example.org/"}, "external"),
        (JupyterRuntime, {"type": "jupyter", "kernel": {"type": "python_uv_project"}}, "jupyter"),
    ],
)
def test_every_closed_union_branch_parses(adapter: Any, payload: dict[str, Any], expected_type: str) -> None:
    parsed = adapter.model_validate(payload) if isinstance(adapter, type) else adapter.validate_python(payload)
    assert parsed.type == expected_type


@pytest.mark.parametrize("bad_id", ["prediction!", "Prediction", "prediction-record-"])
def test_identifier_patterns_match_the_entire_value(bad_id: str) -> None:
    with pytest.raises(ValidationError):
        LearnerRecordRequirement.model_validate({
            "id": bad_id,
            "type": "learner_record",
            "record_kind": "text",
            "prompt": "Predict.",
        })


def test_empty_completion_is_structurally_representable_for_runnable_validation() -> None:
    assert Completion.model_validate({"requirements": []}).requirements == ()


@pytest.mark.parametrize("progress", ["required", "optional"])
def test_non_excluded_phase_requires_completion(progress: str) -> None:
    phase = _phase(progress=progress)
    phase.pop("completion")
    with pytest.raises(ValidationError):
        Phase.model_validate(phase)


def test_excluded_phase_rejects_completion_and_every_teacher_gate() -> None:
    excluded = _phase(progress="excluded")
    with pytest.raises(ValidationError):
        Phase.model_validate(excluded)

    excluded.pop("completion")
    excluded["teacher"]["access"] = {"mode": "available", "requires": ["ghost"]}
    with pytest.raises(ValidationError):
        Phase.model_validate(excluded)


def test_teacher_gates_require_same_phase_learner_records_not_artifacts() -> None:
    phase = _phase()
    phase["completion"] = {"requirements": [{"id": "artifact", "type": "artifact_exists", "prompt": "Create it.", "path": "notes/result.md"}]}
    phase["teacher"]["access"] = {"mode": "available", "requires": ["artifact"]}
    with pytest.raises(ValidationError):
        Phase.model_validate(phase)

    assert Phase.model_validate(_phase()).teacher.access.requires == ("prediction",)


@pytest.mark.parametrize(
    ("access", "sharing", "proposals"),
    [
        ({"mode": "available", "requires": ["prediction", "prediction"]}, {"allow": ["selection"]}, {"allow": []}),
        ({"mode": "available", "requires": ["prediction"]}, {"allow": ["selection", "selection"]}, {"allow": []}),
        ({"mode": "available", "requires": ["prediction"]}, {"allow": ["selection"]}, {"allow": ["profile", "profile"]}),
    ],
)
def test_teacher_authority_lists_are_unique(
    access: dict[str, Any], sharing: dict[str, Any], proposals: dict[str, Any]
) -> None:
    phase = _phase()
    phase["teacher"] = {
        **phase["teacher"],
        "access": access,
        "sharing": sharing,
        "proposals": proposals,
    }
    with pytest.raises(ValidationError):
        Phase.model_validate(phase)


@pytest.mark.parametrize("mode", ["disabled", "observer_only"])
@pytest.mark.parametrize(
    ("access", "sharing", "proposals"),
    [
        ({"mode": "MODE", "requires": ["prediction"]}, {"allow": []}, {"allow": []}),
        ({"mode": "MODE", "requires": []}, {"allow": ["selection"]}, {"allow": []}),
        ({"mode": "MODE", "requires": []}, {"allow": []}, {"allow": ["profile"]}),
    ],
)
def test_disabled_and_observer_teachers_have_no_authorities(
    mode: str, access: dict[str, Any], sharing: dict[str, Any], proposals: dict[str, Any]
) -> None:
    phase = _phase()
    phase["teacher"] = {
        **phase["teacher"],
        "access": {key: (mode if value == "MODE" else value) for key, value in access.items()},
        "sharing": sharing,
        "proposals": proposals,
    }
    with pytest.raises(ValidationError):
        Phase.model_validate(phase)


@pytest.mark.parametrize(
    "mutator",
    [
        lambda value: value["completion"].update({"requirements": [_learner_requirement(), _learner_requirement()]}),
        lambda value: value.update({"surfaces": [_surface("markdown"), _surface("markdown")]}),
    ],
)
def test_phase_local_ids_are_unique(mutator: Any) -> None:
    phase = _phase()
    mutator(phase)
    with pytest.raises(ValidationError):
        Phase.model_validate(phase)


def test_module_and_course_ids_are_unique() -> None:
    manifest = _manifest()
    manifest["modules"][0]["phases"].append(deepcopy(manifest["modules"][0]["phases"][0]))
    with pytest.raises(ValidationError):
        CourseManifest.model_validate(manifest)

    manifest = _manifest()
    manifest["modules"].append(deepcopy(manifest["modules"][0]))
    with pytest.raises(ValidationError):
        CourseManifest.model_validate(manifest)


def test_manifest_enforces_entry_and_course_authority_bounds() -> None:
    manifest = _manifest()
    assert CourseManifest.model_validate(manifest).entry_module_id == "intro"

    wrong_entry = deepcopy(manifest)
    wrong_entry["entry_module_id"] = "missing"
    with pytest.raises(ValidationError):
        CourseManifest.model_validate(wrong_entry)

    for policy_key, phase_key, forbidden_value in [
        ("allowed_share_kinds", "sharing", "output"),
        ("allowed_proposal_types", "proposals", "profile"),
    ]:
        forbidden = deepcopy(manifest)
        forbidden["modules"][0]["phases"][0]["teacher"][phase_key] = {"allow": [forbidden_value]}
        with pytest.raises(ValidationError):
            CourseManifest.model_validate(forbidden)


def test_notebook_surfaces_require_runtime_but_other_structural_cases_do_not() -> None:
    manifest = _manifest()
    manifest["modules"][0]["phases"][0]["surfaces"] = [{"id": "surface", "purpose": "primary", "type": "notebook", "label": "Surface", "path": "lesson.ipynb", "selector": {"type": "whole_notebook"}}]
    with pytest.raises(ValidationError):
        CourseManifest.model_validate(manifest)
    manifest["runtime"] = {"type": "jupyter", "kernel": {"type": "python_uv_project"}}
    assert CourseManifest.model_validate(manifest).runtime is not None


@pytest.mark.parametrize(
    "surface",
    [
        {"id": "surface", "purpose": "primary", "type": "video", "label": "Surface", "src": "video.mp4", "start_seconds": 1},
        {"id": "surface", "purpose": "primary", "type": "video", "label": "Surface", "src": "video.mp4", "end_seconds": 1},
        {"id": "surface", "purpose": "primary", "type": "video", "label": "Surface", "src": "video.mp4", "start_seconds": 3, "end_seconds": 3},
        {"id": "surface", "purpose": "primary", "type": "video", "label": "Surface", "src": "video.mp4", "start_seconds": 4, "end_seconds": 3},
    ],
)
def test_video_segments_must_be_paired_and_ordered(surface: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        TypeAdapter(Surface).validate_python(surface)


@pytest.mark.parametrize(
    "selector",
    [
        {"type": "cell_ids", "values": ["cell_1", "cell_1"]},
        {"type": "cell_tags", "values": ["exercise", "exercise"], "match": "any"},
    ],
)
def test_notebook_selector_values_are_unique(selector: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        TypeAdapter(NotebookSelector).validate_python(selector)


@pytest.mark.parametrize(
    ("field", "values"),
    [
        ("allowed_share_kinds", ["selection", "selection"]),
        ("allowed_proposal_types", ["profile", "profile"]),
        ("workspace_write_globs", ["notes/**/*.md", "notes/**/*.md"]),
    ],
)
def test_course_policy_lists_are_unique(field: str, values: list[str]) -> None:
    manifest = _manifest()
    manifest["policies"][field] = values
    with pytest.raises(ValidationError):
        CourseManifest.model_validate(manifest)


@pytest.mark.parametrize(
    ("field", "raw_value"),
    [
        ("schema_version", True),
        ("schema_version", "1"),
        ("max_shared_chars", True),
        ("max_shared_chars", "32768"),
        ("start_seconds", True),
        ("start_seconds", "1"),
        ("end_seconds", True),
        ("end_seconds", "1"),
    ],
)
def test_raw_json_rejects_schema_invalid_integer_coercions(
    field: str, raw_value: bool | str
) -> None:
    manifest = _manifest()
    if field == "schema_version":
        manifest[field] = raw_value
    elif field == "max_shared_chars":
        manifest["policies"][field] = raw_value
    else:
        manifest["modules"][0]["phases"][0]["surfaces"] = [
            {
                "id": "video",
                "purpose": "primary",
                "type": "video",
                "label": "Video",
                "src": "media/video.mp4",
                "start_seconds": raw_value if field == "start_seconds" else 0,
                "end_seconds": raw_value if field == "end_seconds" else 2,
            }
        ]

    with pytest.raises(ValidationError):
        CourseManifest.model_validate_json(json.dumps(manifest))


def _learner_requirement() -> dict[str, Any]:
    return {"id": "prediction", "type": "learner_record", "record_kind": "text", "prompt": "Predict."}


def _surface(kind: str) -> dict[str, Any]:
    base = {"id": "surface", "purpose": "primary", "type": kind, "label": "Surface"}
    if kind in {"html", "markdown", "source"}:
        return {**base, "path": "content.md"}
    if kind == "notebook":
        return {**base, "path": "lesson.ipynb", "selector": {"type": "whole_notebook"}}
    if kind == "video":
        return {**base, "src": "video.mp4"}
    if kind == "terminal":
        return {**base, "command": ["uv", "run"], "cwd": "."}
    if kind == "external":
        return {**base, "url": "https://example.org/"}
    raise AssertionError(f"unsupported surface {kind}")


def _phase(*, progress: str = "required") -> dict[str, Any]:
    return {
        "id": "predict",
        "title": "Predict",
        "progress": progress,
        "experience": {"type": "builtin", "id": "prediction"},
        "surfaces": [],
        "completion": {"requirements": [_learner_requirement()]},
        "teacher": {
            "access": {"mode": "available", "requires": ["prediction"]},
            "guidance": {"style": {"type": "builtin", "id": "socratic"}, "hint_level": "graduated"},
            "sharing": {"allow": ["selection"]},
            "proposals": {"allow": []},
        },
    }


def _manifest() -> dict[str, Any]:
    return {
        "schema_version": 2,
        "id": "demo",
        "title": "Demo",
        "description": "",
        "entry_module_id": "intro",
        "policies": {
            "content_sharing": "explicit_only",
            "allowed_share_kinds": ["selection"],
            "max_shared_chars": 32768,
            "allowed_proposal_types": [],
            "durable_mutation": "proposal_or_direct_student_action",
            "terminal_execution": "student_only",
            "conversation_memory": "session_only",
            "workspace_write_globs": [],
        },
        "modules": [{"id": "intro", "title": "Introduction", "description": "", "phases": [_phase()]}],
    }
