"""Deterministic author diagnostics backed by the existing student engine."""

from __future__ import annotations

import hashlib
import json
from importlib.resources import files
from pathlib import Path

from ..contracts import manifest_schema
from ..engine.manifest import ManifestValidationError, parse_manifest_data, validate_runnable
from .contracts import CompatibilityReport, StudentProfile, ValidationIssue

RELEASED_COMMIT = "409f5c01e93d98f118967138116b0dbafff80ed7"
RELEASED_SCHEMA_SHA256 = "28ffd9b10fdcf4089e003db686924349c5fd488757de6f424bf11a26482d8839"


def student_profile(version: str = "0.2.0") -> StudentProfile:
    """Refuse drift rather than silently choosing a more permissive profile."""
    raw = files("courseweave.contracts").joinpath("courseweave.schema.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != RELEASED_SCHEMA_SHA256 or json.loads(raw) != manifest_schema():
        raise ValueError("The candidate schema differs from the released Student profile.")
    return StudentProfile(application_version=version, schema_sha256=RELEASED_SCHEMA_SHA256,
                          baseline_commit=RELEASED_COMMIT)


def _issue(code: str, message: str, location: str = "", severity: str = "not_performed") -> ValidationIssue:
    return ValidationIssue(code=code, location=location, message=message, severity=severity)


def _errors(error: ManifestValidationError) -> tuple[ValidationIssue, ...]:
    explanations = {
        "source_missing": "Import the declared source or correct this path.",
        "entry_content_required": "Choose an entry module with an activity and authored content.",
        "notebook_selector_unmatched": "Select cell IDs or tags that exist in this notebook.",
        "phase_context_ambiguous": "These cells belong to overlapping activities; make the selections distinct.",
        "path_symlink_rejected": "Replace the linked path with an explicitly imported ordinary file.",
        "lfs_pointer": "Import the actual asset; this file is a Git LFS pointer.",
    }
    return tuple(_issue(item["code"], explanations.get(item["code"], item["message"]),
                        item["path"], "error") for item in error.issues) or (
        _issue("contract_invalid", "The manifest is invalid.", severity="error"),)


def check_manifest(data: object, course_root: Path, profile: StudentProfile) -> CompatibilityReport:
    """Check an unsaved draft without writing state, fetching URLs or running code.

This preliminary report has no package inventory identity. Delivery adds stable
inventory/link checks; installed execution and editorial review remain separate.
"""
    structural: tuple[ValidationIssue, ...] = ()
    assets: tuple[ValidationIssue, ...] = ()
    profile_issues: list[ValidationIssue] = []
    not_performed = [
        _issue("linked_assets_not_checked", "Linked assets and fragments have not been checked in a stable export."),
        _issue("installed_execution_not_checked", "Installed Student execution has not been checked."),
        _issue("editorial_review_not_checked", "Source accuracy and editorial quality require separate author review."),
    ]
    digest = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    expected = student_profile(profile.application_version)
    if profile != expected:
        profile_issues.append(_issue("student_profile_mismatch", "Use the declared released Student profile.", severity="error"))
    try:
        manifest = parse_manifest_data(data, course_root)
    except ManifestValidationError as exc:
        structural = _errors(exc)
        not_performed.append(_issue("assets_not_checked", "Repair structural errors before checking local assets."))
    else:
        try:
            validate_runnable(manifest, course_root)
        except ManifestValidationError as exc:
            assets = _errors(exc)
        if "workspace" in manifest.policies.allowed_proposal_types or manifest.policies.workspace_write_globs:
            profile_issues.append(_issue("workspace_proposals_inactive",
                "Workspace proposal metadata is retained. The Student assistant cannot write files or execute code.",
                "/policies/allowed_proposal_types", "warning"))
        for mi, module in enumerate(manifest.modules):
            for pi, phase in enumerate(module.phases):
                if "workspace" in phase.teacher.proposals.allow:
                    profile_issues.append(_issue("workspace_proposals_inactive",
                        "This declaration grants no Student assistant file writes or code execution.",
                        f"/modules/{mi}/phases/{pi}/teacher/proposals/allow", "warning"))
        if manifest.runtime is not None:
            not_performed.append(_issue("notebook_runtime_not_checked",
                "Notebook dependencies and kernel execution require an isolated installed check.", "/runtime"))
    return CompatibilityReport(profile=profile, manifest_sha256=digest,
        structural=structural, assets=assets, profile_issues=tuple(profile_issues),
        not_performed=tuple(not_performed))
