"""Saved reviews retain human authority and exact, bounded source provenance."""
from copy import deepcopy
import json

import pytest

from courseweave.author.assistant import AuthorAssistantError, build_author_context, parse_author_reply
from courseweave.author.contracts import AuthorSelection
from courseweave.author.project import ProjectError, open_project, read_sources, update_source
from courseweave.store import CourseStore
from test_author_assistant import CONFIG, approve_reference, context, project, reply, selection


def reviewed(project, *, cited=True, **values):
    record = approve_reference(project)
    ctx = context(project, source_ids=(record.source_id,), **values)
    quote = "A prediction precedes an observation."
    evidence = ctx.sources[0].model_dump() | {"quote": quote, "start": 0, "end": len(quote)}
    result = parse_author_reply(reply(change=None, findings=[{"claim_id": "prediction", "judgment": "supported",
        "explanation": "The selected reference places prediction first.", "evidence": [evidence] if cited else []}]), ctx)
    return ctx, result, record


def learning(project):
    path = project.course_root / "courseweave.json"
    data = json.loads(path.read_text())
    phase = data["modules"][0]["phases"][0]
    phase["learning"] = {"objectives": [{"id": "sequence", "text": "Distinguish a prediction from an observation."},
        {"id": "explain", "text": "Explain the result."}], "overview": "Predict, then observe.",
        "hints": [{"id": "first", "text": "Which comes before execution?", "objective_ids": ["sequence"]}],
        "checks": [{"id": "order", "type": "single_choice", "prompt": "When is the prediction recorded?",
            "objective_ids": ["sequence"], "options": [{"id": "before", "text": "Before", "feedback": "Yes."},
                {"id": "after", "text": "After", "feedback": "That is an observation."}], "correct_option_id": "before"}],
        "sources": [{"id": "reference", "label": "Reference", "url": "https://example.org/lesson"}]}
    optional = deepcopy(phase)
    optional.update(id="optional", title="Unaided protocol", progress="optional", learning=None)
    optional["teacher"]["access"] = {"mode": "disabled", "requires": []}
    data["modules"][0]["phases"].append(optional)
    path.write_text(json.dumps(data))
    return path.read_bytes()


def test_save_is_explicit_private_and_reopens_without_conversation(project):
    from courseweave.author.quality import list_reviews, read_review, save_review
    ctx, result, _ = reviewed(project)
    original = (project.course_root / "lesson.md").read_bytes()
    assert list_reviews(project) == ()
    report = save_review(project, ctx, result)
    assert report.revision == 0 and report.status == "current"
    assert report.findings[0].human_disposition == "unreviewed"
    assert report.findings[0].provenance == "located"
    assert report.findings[0].judgment == "supported"
    assert report.summary == result.message and report.selection == ctx.selection
    assert read_review(open_project(project.course_root.parent), report.report_id) == report
    assert [r.report_id for r in list_reviews(project)] == [report.report_id]
    assert (project.course_root / "lesson.md").read_bytes() == original
    assert not (project.state_root / "changes").exists()
    assert not (project.course_root / ".courseweave").exists()


@pytest.mark.parametrize("patch", [{"source_id": "absent"}, {"revision": 999}, {"raw_sha256": "0" * 64},
    {"text_sha256": "1" * 64}, {"extractor_version": "other"}, {"start": 1}, {"end": 2}, {"quote": "Invented."}])
def test_unknown_or_mismatched_citations_cannot_be_saved(project, patch):
    from courseweave.author.quality import save_review
    ctx, result, _ = reviewed(project)
    finding = result.findings[0]
    bad = result.model_copy(update={"findings": (finding.model_copy(update={
        "evidence": (finding.evidence[0].model_copy(update=patch),)}),)})
    with pytest.raises(ProjectError, match="citation|provenance|evidence"):
        save_review(project, ctx, bad)
    assert not (project.state_root / "reviews").exists()


def test_no_evidence_is_not_checked_and_does_not_certify_a_claim(project):
    from courseweave.author.quality import save_review
    ctx, result, _ = reviewed(project, cited=False)
    finding = save_review(project, ctx, result).findings[0]
    assert finding.judgment == "supported"  # Preserve the model's judgment, even without support.
    assert finding.provenance == "not_checked" and finding.human_disposition == "unreviewed"


@pytest.mark.parametrize("dependency", ["target", "manifest", "source_revision", "revoked", "raw", "text", "missing"])
def test_changed_dependencies_revoke_save_and_mark_saved_review_stale(project, dependency):
    from courseweave.author.quality import read_review, save_review
    ctx, result, record = reviewed(project)
    saved = save_review(project, ctx, result)
    if dependency == "target":
        (project.course_root / "lesson.md").write_text("Changed lesson.\n")
    elif dependency == "manifest":
        path = project.course_root / "courseweave.json"
        data = json.loads(path.read_text())
        data["title"] = "Changed course"
        path.write_text(json.dumps(data))
    elif dependency in {"source_revision", "revoked"}:
        store = CourseStore(project.course_root, state_dir=project.state_root / "transactions")
        update_source(project, store, record.source_id, record.revision,
            {"review_note": "New decision"} if dependency == "source_revision" else {"status": "rejected"})
    else:
        path = project.state_root / (record.snapshot_path if dependency == "raw" else record.text_path)
        path.unlink() if dependency == "missing" else path.write_text("Corrupted source bytes.")
    current = read_review(project, saved.report_id)
    assert current.status == "stale" and current.stale_reasons
    assert current.findings[0].human_disposition == "unreviewed"
    assert current.findings[0].judgment == saved.findings[0].judgment
    with pytest.raises(ProjectError, match="changed|stale|source|Source|citation"):
        save_review(project, ctx, result)


def test_human_dispositions_are_revision_checked_and_do_not_rewrite_model_findings(project):
    from courseweave.author.quality import FindingDecision, read_review, save_review, update_review
    ctx, result, _ = reviewed(project)
    saved = save_review(project, ctx, result)
    decision = FindingDecision(revision=0, human_disposition="dismissed", reason="This term is defined earlier.")
    changed = update_review(project, saved.report_id, "prediction", decision)
    assert changed.revision == 1 and changed.findings[0].human_disposition == "dismissed"
    assert changed.findings[0].disposition_reason == decision.reason
    assert changed.findings[0].model_dump(include={"claim_id", "judgment", "explanation", "evidence"}) == result.findings[0].model_dump()
    with pytest.raises(ProjectError, match="revision"):
        update_review(project, saved.report_id, "prediction", decision)
    reset = update_review(project, saved.report_id, "prediction", FindingDecision(revision=1, human_disposition="unreviewed"))
    assert reset.findings[0].disposition_reason == "" and reset.revision == 2
    assert read_review(project, saved.report_id) == reset


@pytest.mark.parametrize("disposition", ["dismissed", "revised"])
def test_dismissed_or_revised_findings_need_a_meaningful_reason(disposition):
    from pydantic import ValidationError
    from courseweave.author.quality import FindingDecision
    with pytest.raises(ValidationError):
        FindingDecision(revision=0, human_disposition=disposition, reason="   ")


def test_stale_review_can_be_dismissed_but_not_accepted_as_current(project):
    from courseweave.author.quality import FindingDecision, save_review, update_review
    ctx, result, _ = reviewed(project)
    saved = save_review(project, ctx, result)
    (project.course_root / "lesson.md").write_text("Another lesson.")
    with pytest.raises(ProjectError, match="stale|changed"):
        update_review(project, saved.report_id, "prediction", FindingDecision(revision=0, human_disposition="accepted"))
    assert update_review(project, saved.report_id, "prediction", FindingDecision(revision=0,
        human_disposition="dismissed", reason="Superseded lesson.")).status == "stale"


def test_export_and_delete_require_the_reviewed_revision_and_export_has_no_machine_paths(project):
    from courseweave.author.quality import delete_review, export_review, list_reviews, save_review
    ctx, result, _ = reviewed(project)
    saved = save_review(project, ctx, result)
    with pytest.raises(ProjectError, match="revision"):
        export_review(project, saved.report_id, 99)
    exported = export_review(project, saved.report_id, 0)
    assert str(project.course_root.parent.parent).encode() not in exported
    decoded = json.loads(exported)
    assert decoded["report_id"] == saved.report_id and decoded["sources"][0]["title"] == "reference.md"
    assert decoded["sources"][0]["raw_sha256"] == ctx.sources[0].raw_sha256
    with pytest.raises(ProjectError, match="revision"):
        delete_review(project, saved.report_id, 99)
    assert len(list_reviews(project)) == 1
    delete_review(project, saved.report_id, 0)
    assert list_reviews(project) == ()


def test_coverage_maps_authored_links_and_explicit_human_support_without_changing_progress(project):
    from courseweave.author.quality import FindingDecision, course_coverage, save_review, update_review
    original = learning(project)
    chosen = selection(project, module_id="module-one", phase_id="phase-one")
    ctx, result, _ = reviewed(project, selection=chosen)
    saved = save_review(project, ctx, result)
    first = course_coverage(project)
    required = next(row for row in first["activities"] if row["phase_id"] == "phase-one")
    objective = required["objectives"][0]
    assert [h["id"] for h in objective["hints"]] == ["first"]
    assert [c["id"] for c in objective["checks"]] == ["order"]
    assert objective["reviewed_support"] == []
    assert required["completion_prompts"][0]["id"] == "acknowledgement"
    assert required["declared_sources"][0]["id"] == "reference"
    assert required["review_gaps"][0]["claim_id"] == "prediction"
    with pytest.raises(ProjectError, match="objective"):
        update_review(project, saved.report_id, "prediction", FindingDecision(revision=0,
            human_disposition="accepted", objective_ids=("absent",)))
    update_review(project, saved.report_id, "prediction", FindingDecision(revision=0,
        human_disposition="accepted", objective_ids=("sequence",)))
    coverage = course_coverage(project)
    required, optional = coverage["activities"]
    assert required["objectives"][0]["reviewed_support"][0]["report_id"] == saved.report_id
    assert required["objectives"][1]["reviewed_support"] == []
    assert optional["progress"] == "optional" and optional["objectives"] == [] and optional["guidance"]
    assert (project.course_root / "courseweave.json").read_bytes() == original
    assert not (project.course_root / ".courseweave").exists()


def test_coverage_keeps_unscoped_reviews_unassigned_and_reports_missing_metadata(project):
    from courseweave.author.quality import course_coverage, save_review
    ctx, result, _ = reviewed(project)
    saved = save_review(project, ctx, result)
    coverage = course_coverage(project)
    assert coverage["unassigned_reviews"] == [saved.report_id]
    assert coverage["activities"][0]["objectives"] == []
    assert coverage["activities"][0]["guidance"]


def test_review_context_has_actual_diagnostics_and_source_metadata_with_bounded_omissions(project):
    ctx, _, record = reviewed(project)
    data = json.loads(ctx.content)
    assert data["compatibility"]["scope"] == "saved_course"
    assert any(issue["code"] == "installed_execution_not_checked" for issue in data["compatibility"]["issues"])
    source = data["sources"][0]
    assert source["origin"] == "local:reference.md" and source["policy_decision"] == "local"
    assert source["imported_at"] and source["extraction"] == "text" and source["publication_date"] is None
    assert str(project.course_root.parent.parent) not in ctx.content
    (project.state_root / record.snapshot_path).write_text("Corrupted raw snapshot.")
    with pytest.raises(AuthorAssistantError, match="source|Source|snapshot|changed"):
        context(project, source_ids=(record.source_id,))


def test_duplicate_claim_ids_are_rejected_before_human_decisions(project):
    ctx, result, _ = reviewed(project)
    item = result.findings[0].model_dump(mode="json")
    with pytest.raises(AuthorAssistantError, match="claim|findings"):
        parse_author_reply(reply(change=None, findings=[item, item]), ctx)


def test_saved_report_retains_truncated_scope_and_actual_compatibility_dependency(project):
    from courseweave.author.quality import read_review, save_review
    (project.course_root / "lesson.md").write_text('An escaped "lesson".\n' * 6000)
    path = project.course_root / "courseweave.json"
    manifest = json.loads(path.read_text())
    manifest["modules"][0]["phases"][0]["surfaces"].append({"id": "extra", "purpose": "supporting",
        "type": "markdown", "label": "Extra", "path": "extra.md"})
    path.write_text(json.dumps(manifest))
    ctx, result, _ = reviewed(project)
    saved = save_review(project, ctx, result)
    assert saved.omissions == ctx.omissions
    assert saved.target_characters == len(json.loads(ctx.content)["target"]["text"])
    assert not saved.target_fully_visible
    assert not saved.compatibility.preliminary_checks_passed
    (project.course_root / "extra.md").write_text("New asset fixes the declared path.")
    fresh = read_review(project, saved.report_id)
    assert fresh.status == "stale" and any("compatibility" in reason for reason in fresh.stale_reasons)


@pytest.mark.parametrize("path", ["reviews/review-" + "a" * 32 + ".json", "reviews"])
def test_review_storage_rejects_symlinked_files_and_directories(project, tmp_path, path):
    from courseweave.author.quality import read_review, save_review
    ctx, result, _ = reviewed(project)
    target = project.state_root / path
    target.parent.mkdir(exist_ok=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    target.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ProjectError):
        if path == "reviews":
            save_review(project, ctx, result)
        else:
            read_review(project, "review-" + "a" * 32)
    assert not list(outside.iterdir())


def test_changed_source_metadata_is_stale_even_if_a_damaged_registry_reuses_its_revision(project):
    from courseweave.author.quality import read_review, save_review
    ctx, result, record = reviewed(project)
    saved = save_review(project, ctx, result)
    path = project.state_root / "sources.json"
    records = json.loads(path.read_text())
    next(source for source in records if source["source_id"] == record.source_id)["publication_date"] = "2025-01-01"
    path.write_text(json.dumps(records))
    assert read_review(project, saved.report_id).status == "stale"
    with pytest.raises(ProjectError, match="changed|stale"):
        save_review(project, ctx, result)
