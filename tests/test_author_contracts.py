"""Untrusted replies cannot supply mutation or review authority."""

import pytest
from pydantic import TypeAdapter, ValidationError


@pytest.mark.parametrize("extra", [
    {"target_path": "secret.py"}, {"before_hash": "0" * 64},
    {"approved": True}, {"request_id": "model-operation"},
])
def test_model_draft_cannot_choose_authoritative_target(extra):
    from courseweave.author.contracts import ChangeDraft
    with pytest.raises(ValidationError):
        TypeAdapter(ChangeDraft).validate_python(
            {"kind": "markdown_replace", "text": "A correction.\n", **extra}
        )


@pytest.mark.parametrize("kind", ["shell", "file_replace", "execute_notebook"])
def test_model_draft_cannot_add_executable_operations(kind):
    from courseweave.author.contracts import ChangeDraft
    with pytest.raises(ValidationError):
        TypeAdapter(ChangeDraft).validate_python({"kind": kind, "text": "run()"})


def test_reply_cannot_set_human_or_deterministic_review_result():
    from courseweave.author.contracts import AuthorReply
    reply = {
        "version": "author-reply-v1", "role": "fact_checker", "message": "Review.",
        "findings": [{"claim_id": "claim-1", "judgment": "supported",
                      "explanation": "A claim.", "evidence": [],
                      "human_disposition": "accepted"}], "change": None,
    }
    with pytest.raises(ValidationError):
        AuthorReply.model_validate(reply)
    reply["findings"][0].pop("human_disposition")
    reply["compatibility_passed"] = True
    with pytest.raises(ValidationError):
        AuthorReply.model_validate(reply)


def test_research_request_requires_explicit_enablement_and_bounds():
    from courseweave.author.contracts import ResearchRequest
    with pytest.raises(ValidationError):
        ResearchRequest.model_validate({"queries": ["python validation"]})
    for payload in (
        {"queries": ["a", "b", "c"]},
        {"urls": ["https://example.org/" + str(i) for i in range(6)]},
    ):
        with pytest.raises(ValidationError):
            ResearchRequest.model_validate({"network_enabled": True,
                "policy": {"mode": "public_web"}, **payload})


def test_research_policy_requires_an_explicit_scope():
    from courseweave.author.contracts import ResearchPolicy
    with pytest.raises(ValidationError):
        ResearchPolicy.model_validate({"mode": "allow_only"})
    with pytest.raises(ValidationError):
        ResearchPolicy.model_validate({"mode": "public_web", "cookies": "session"})


def test_author_project_roots_cannot_alias_or_nest(tmp_path):
    from courseweave.author.contracts import AuthorProject
    course = tmp_path / "course"
    course.mkdir()
    for state in (course, course / "author-state", tmp_path):
        with pytest.raises(ValidationError):
            AuthorProject(project_id="test-project", course_root=course, state_root=state, revision=0)


def test_revision_and_hash_fields_reject_coercion(tmp_path):
    from courseweave.author.contracts import AuthorProject, SourceRevision
    with pytest.raises(ValidationError):
        AuthorProject(project_id="test-project", course_root=tmp_path / "course",
                      state_root=tmp_path / "author-state", revision=True)
    with pytest.raises(ValidationError):
        SourceRevision(source_id="source-1", revision=1, raw_sha256="not-a-hash",
                       text_sha256="0" * 64, extractor_version="text-v1")
