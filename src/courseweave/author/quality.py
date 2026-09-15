"""Deterministic author diagnostics backed by the existing student engine."""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path
from uuid import uuid4

from pydantic import Field, model_validator

from ..contracts import manifest_schema
from ..contracts.models import ClosedModel, Slug
from ..engine.manifest import ManifestValidationError, parse_manifest_data, validate_runnable
from .contracts import (
    AuthorContext, AuthorReply, CompatibilityReport, HumanDisposition, ReviewReport,
    Revision, SavedFinding, SourceProvenance, SourceRevision, StudentProfile, ValidationIssue,
)
from .content import _lock, _read_target, _recover
from .project import ProjectError, atomic_bytes, local_directory, open_project, read_private, read_sources
from .sources import source_provenance, verified_source_text

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


def compatibility_context(data: object, course_root: Path, *, max_chars=3000) -> dict:
    """A bounded explanation of real saved-course checks, never a model verdict."""
    report = check_manifest(data, course_root, student_profile())
    issues = (*report.structural, *report.assets, *report.links, *report.profile_issues, *report.not_performed)
    result = {"scope": "saved_course", "student_profile": report.profile.application_version,
        "manifest_sha256": report.manifest_sha256, "preliminary_checks_passed": report.passed,
        "issues": [], "omitted_issues": len(issues),
        "notice": "Canonical structural, local asset and profile checks only. This is not installed or editorial acceptance."}
    for issue in issues:
        item = issue.model_dump(mode="json")
        # Preserve issue codes and paths exactly; if one does not fit, disclose it.
        candidate = {**result, "issues": [*result["issues"], item], "omitted_issues": result["omitted_issues"] - 1}
        if len(json.dumps(candidate, ensure_ascii=False, separators=(",", ":"))) > max_chars:
            continue
        result = candidate
    return result


MAX_REVIEWS = 200
MAX_REVIEW_BYTES = 512 * 1024


class ReviewError(ProjectError):
    pass


class FindingDecision(ClosedModel):
    revision: Revision
    human_disposition: HumanDisposition
    reason: str = Field(default="", max_length=4000)
    objective_ids: tuple[Slug, ...] = Field(default=(), max_length=32)

    @model_validator(mode="after")
    def deliberate_decision(self):
        if self.human_disposition in {"dismissed", "revised"} and not self.reason.strip():
            raise ValueError("A dismissal or revision requires a reason.")
        if len(self.objective_ids) != len(set(self.objective_ids)):
            raise ValueError("Objective links must be unique.")
        return self


def _review_path(report_id: str) -> str:
    if not re.fullmatch(r"review-[a-f0-9]{32}", report_id):
        raise ReviewError("Choose a saved review from this project.")
    return f"reviews/{report_id}.json"


def _review_names(project) -> list[str]:
    names = []
    with local_directory(project.state_root / "reviews", create=True) as fd:
        with os.scandir(fd) as entries:
            for index, entry in enumerate(entries):
                if index >= MAX_REVIEWS * 2:
                    raise ReviewError("Review directory limit reached; back up and manage saved reports.")
                if re.fullmatch(r"review-[a-f0-9]{32}\.json", entry.name):
                    names.append((entry.stat(follow_symlinks=False).st_mtime_ns, entry.name[:-5]))
    if len(names) > MAX_REVIEWS:
        raise ReviewError("Review limit exceeded; restore or manage a verified backup.")
    return [name for _, name in sorted(names, reverse=True)]


def _load_review(project, report_id: str) -> ReviewReport:
    path = _review_path(report_id)
    try:
        report = ReviewReport.model_validate_json(read_private(project.state_root, path, max_bytes=MAX_REVIEW_BYTES))
        if report.project_id != project.project_id or report.report_id != report_id:
            raise ValueError()
        return report
    except (ValueError, OSError):
        raise ReviewError("Review is unavailable or corrupt; reload the list or restore a verified backup.") from None


def _review_bytes(report: ReviewReport) -> bytes:
    raw = (report.model_dump_json(indent=2) + "\n").encode()
    if len(raw) > MAX_REVIEW_BYTES:
        raise ReviewError("Review exceeds the 512 KiB limit; select fewer sources or findings.")
    return raw


def _evaluate_review(project, report: ReviewReport) -> ReviewReport:
    """Under the course lock, compare saved dependencies without rewriting judgments."""
    reasons = []
    if open_project(project.course_root.parent).revision != report.project_revision:
        reasons.append("Project revision changed.")
    try:
        _, raw = _read_target(project, "courseweave.json")
        manifest = parse_manifest_data(json.loads(raw), project.course_root).model_dump(mode="json")
        compatibility = compatibility_context(manifest, project.course_root,
            max_chars=min(3000, report.context_budget.max_input_chars // 4))
        if compatibility != report.compatibility.model_dump(mode="json"):
            reasons.append("Saved-course compatibility diagnostics changed.")
    except (ProjectError, ValueError):
        reasons.append("Saved-course compatibility diagnostics are unavailable or changed.")
    for path, expected, expected_exists, label in (
        ("courseweave.json", report.manifest_sha256, True, "Course manifest"),
        (report.target_path, report.target_sha256, report.target_exists, "Selected target"),
    ):
        try:
            exists, raw = _read_target(project, path)
            if exists != expected_exists or hashlib.sha256(raw).hexdigest() != expected:
                reasons.append(f"{label} changed since this review.")
        except ProjectError:
            reasons.append(f"{label} is unavailable or changed.")
    try:
        records = {record.source_id: record for record in read_sources(project)}
    except ProjectError:
        records = {}
        reasons.append("Source registry is unavailable or changed.")
    texts, states = {}, {}
    for expected in report.sources:
        record = records.get(expected.source_id)
        status = "located"
        if record is None:
            status = "missing"
        elif record.status != "approved" or source_provenance(record) != expected:
            status = "mismatch"
        else:
            try:
                texts[record.source_id] = verified_source_text(project, record)
            except ProjectError:
                status = "mismatch"
        states[expected.source_id] = status
        if status != "located":
            reasons.append(f"Source {expected.source_id} is changed, unapproved or unavailable.")
    expected_sources = {source.source_id: source for source in report.sources}
    findings = []
    for finding in report.findings:
        provenance = "not_checked"
        for citation in finding.evidence:
            expected = expected_sources.get(citation.source_id)
            status = states.get(citation.source_id, "missing")
            if status == "located" and (expected is None
                    or any(getattr(citation, field) != getattr(expected, field) for field in SourceRevision.model_fields)
                    or texts.get(citation.source_id, "")[citation.start:citation.end] != citation.quote):
                status = "mismatch"
            provenance = status
            if status != "located":
                break
        if provenance in {"mismatch", "missing"}:
            reasons.append(f"Finding {finding.claim_id} has missing or mismatched quotation provenance.")
        findings.append(finding.model_copy(update={"provenance": provenance}))
    return report.model_copy(update={"findings": tuple(findings), "status": "stale" if reasons else "current",
        "stale_reasons": tuple(dict.fromkeys(reasons))[:64]})


def save_review(project, context: AuthorContext, reply: AuthorReply) -> ReviewReport:
    """Explicitly persist a completed, server-validated reply, independently of chat."""
    from .assistant import parse_author_reply
    reply = parse_author_reply(reply.model_dump_json(), context)
    if context.selection.project_id != project.project_id:
        raise ReviewError("The selected project changed.")
    with _lock(project):
        _recover(project)
        records = {record.source_id: record for record in read_sources(project)}
        if any(source.source_id not in records for source in context.sources):
            raise ReviewError("A permitted source changed or is unavailable.")
        now = datetime.now(timezone.utc)
        data = json.loads(context.content)
        report = ReviewReport(report_id=f"review-{uuid4().hex}", project_id=project.project_id, revision=0,
            context_digest=context.digest, selection=context.selection, project_revision=context.project_revision,
            manifest_sha256=context.manifest_sha256, prompt_version=context.prompt_version,
            context_budget=context.budget, compatibility=data["compatibility"], omissions=context.omissions,
            target_path=context.target_path, target_sha256=context.target_sha256, target_exists=context.target_exists,
            target_fully_visible=data["target"]["fully_visible"],
            target_characters=len(data["target"]["text"]) if "text" in data["target"] else None,
            role=reply.role, summary=reply.message,
            sources=tuple(SourceProvenance.model_validate({field: source[field]
                for field in SourceProvenance.model_fields}) for source in data["sources"]),
            findings=tuple(SavedFinding(**finding.model_dump()) for finding in reply.findings),
            status="current", saved_at=now, updated_at=now)
        if any(any(getattr(saved, field) != getattr(expected, field) for field in SourceRevision.model_fields)
               for saved, expected in zip(report.sources, context.sources)):
            raise ReviewError("A permitted source revision changed; preview the context again.")
        report = _evaluate_review(project, report)
        if report.status != "current":
            raise ReviewError("Review context is stale: " + " ".join(report.stale_reasons[:3]))
        raw = _review_bytes(report)
        if len(_review_names(project)) >= MAX_REVIEWS:
            raise ReviewError("Review limit reached (200); export or delete saved reports before saving another.")
        atomic_bytes(project.state_root / _review_path(report.report_id), raw)
        return report


def read_review(project, report_id: str) -> ReviewReport:
    with _lock(project):
        _recover(project)
        return _evaluate_review(project, _load_review(project, report_id))


def list_reviews(project, *, offset=0, limit=20) -> tuple[ReviewReport, ...]:
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 20:
        raise ReviewError("Choose a review page of at most twenty reports.")
    with _lock(project):
        _recover(project)
        return tuple(_evaluate_review(project, _load_review(project, name)) for name in _review_names(project)[offset:offset + limit])


def _require_revision(report, revision):
    if type(revision) is not int or report.revision != revision:
        raise ReviewError("Review revision changed; reload it before this decision.")


def update_review(project, report_id: str, claim_id: str, decision: FindingDecision) -> ReviewReport:
    decision = FindingDecision.model_validate(decision)
    with _lock(project):
        _recover(project)
        report = _evaluate_review(project, _load_review(project, report_id))
        _require_revision(report, decision.revision)
        if report.status == "stale" and decision.human_disposition in {"accepted", "revised"}:
            raise ReviewError("This review is stale; request a fresh review before accepting or revising a finding.")
        if decision.objective_ids:
            _, raw = _read_target(project, "courseweave.json")
            manifest = parse_manifest_data(json.loads(raw), project.course_root)
            phase = next((p for m in manifest.modules if m.id == report.selection.module_id
                for p in m.phases if p.id == report.selection.phase_id), None)
            valid = {o.id for o in phase.learning.objectives} if phase and phase.learning else set()
            if not set(decision.objective_ids) <= valid:
                raise ReviewError("Link only objectives in this review's explicitly selected activity.")
        findings = list(report.findings)
        index = next((i for i, f in enumerate(findings) if f.claim_id == claim_id), None)
        if index is None:
            raise ReviewError("This finding is unavailable; reload the review.")
        findings[index] = findings[index].model_copy(update={"human_disposition": decision.human_disposition,
            "disposition_reason": decision.reason.strip(), "objective_ids": decision.objective_ids})
        report = report.model_copy(update={"revision": report.revision + 1, "findings": tuple(findings), "updated_at": datetime.now(timezone.utc)})
        atomic_bytes(project.state_root / _review_path(report_id), _review_bytes(report), replace=True)
        return report


def delete_review(project, report_id: str, revision: int) -> None:
    with _lock(project):
        report = _load_review(project, report_id)
        _require_revision(report, revision)
        with local_directory(project.state_root / "reviews") as fd:
            os.unlink(Path(_review_path(report_id)).name, dir_fd=fd)
            os.fsync(fd)


def export_review(project, report_id: str, revision: int) -> bytes:
    report = read_review(project, report_id)
    _require_revision(report, revision)
    return _review_bytes(report)


def _finding_brief(report, finding):
    return {"report_id": report.report_id, "claim_id": finding.claim_id, "judgment": finding.judgment,
        "human_disposition": finding.human_disposition, "provenance": finding.provenance, "status": report.status,
        "explanation": finding.explanation[:600], "source_ids": list(dict.fromkeys(e.source_id for e in finding.evidence))}


def course_coverage(project, *, offset=0, limit=20) -> dict:
    """Authored links and explicit human review links; no inference about mastery."""
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 20:
        raise ReviewError("Choose a coverage page of at most twenty activities.")
    with _lock(project):
        _recover(project)
        _, raw = _read_target(project, "courseweave.json")
        manifest = parse_manifest_data(json.loads(raw), project.course_root)
        reports = [_evaluate_review(project, _load_review(project, name)) for name in _review_names(project)]
        phases = [(module, phase) for module in manifest.modules for phase in module.phases]
        identities = {(module.id, phase.id) for module, phase in phases}
        rows = []
        for module, phase in phases[offset:offset + limit]:
            related = [r for r in reports if (r.selection.module_id, r.selection.phase_id) == (module.id, phase.id)]
            findings = [(report, finding) for report in related for finding in report.findings]
            objectives = []
            for objective in phase.learning.objectives if phase.learning else ():
                hints = [h.model_dump(mode="json") for h in phase.learning.hints if objective.id in h.objective_ids]
                checks = [{"id": c.id, "prompt": c.prompt} for c in phase.learning.checks if objective.id in c.objective_ids]
                support = [_finding_brief(report, finding) for report, finding in findings
                    if objective.id in finding.objective_ids and report.status == "current"
                    and finding.human_disposition in {"accepted", "revised"}
                    and finding.judgment == "supported" and finding.provenance == "located"]
                objectives.append({"id": objective.id, "text": objective.text, "hints": hints, "checks": checks,
                    "reviewed_support": support, "guidance": ([] if hints else ["No objective-linked hints."])
                        + ([] if checks else ["No objective-linked native checks."])
                        + ([] if support else ["No current evidence link accepted and mapped by the author."])})
            rows.append({"module_id": module.id, "module_title": module.title, "phase_id": phase.id,
                "title": phase.title, "progress": phase.progress,
                "completion_prompts": [r.model_dump(mode="json") for r in phase.completion.requirements],
                "overview": phase.learning.overview if phase.learning else "", "objectives": objectives,
                "declared_sources": [s.model_dump(mode="json") for s in phase.learning.sources] if phase.learning else [],
                "review_ids": [r.report_id for r in related],
                "review_gaps": [_finding_brief(report, finding) for report, finding in findings
                    if finding.human_disposition != "dismissed" and (report.status == "stale"
                        or finding.human_disposition == "unreviewed" or finding.judgment != "supported"
                        or finding.provenance != "located")],
                "guidance": ([] if objectives else ["No authored objective metadata; this activity remains importable."])
                    + ([] if phase.learning and phase.learning.overview else ["No authored overview."])})
        return {"course_id": manifest.id, "manifest_sha256": hashlib.sha256(raw).hexdigest(), "activities": rows,
            "total_activities": len(phases), "next_offset": offset + len(rows) if offset + len(rows) < len(phases) else None,
            "unassigned_reviews": [r.report_id for r in reports if (r.selection.module_id, r.selection.phase_id) not in identities],
            "notice": "Completion prompts and source declarations apply to the activity. Objective evidence links are explicit author decisions. Coverage and native checks do not certify mastery or change progress."}
