"""Behavior tests for the deterministic professor policy boundary.

Every test names the production break it catches.  The counting Pydantic AI
test model is only used to prove that a deterministic gate prevents or permits
the external-model boundary; policy and proposal assertions use real objects.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic_ai.models.test import TestModel

from courseweave.models import CourseManifest, ResolvedContext
from courseweave.providers import ModelResult, ProviderAdapter, ProviderConfig
from courseweave.store import CourseStore, LearnerState


class CountingTestModel(TestModel):
    """Local Pydantic AI model whose request count is observable in tests."""

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self.calls = 0

    async def request(self, *args: object, **kwargs: object):  # type: ignore[override]
        self.calls += 1
        return await super().request(*args, **kwargs)


class ProposalTestModel(CountingTestModel):
    """Local model that makes one specified valid inert-proposal tool call."""

    def __init__(self, tool_args: dict[str, object]) -> None:
        super().__init__(call_tools=list(tool_args), custom_output_text="suggested")
        self.tool_args = tool_args

    def gen_tool_args(self, tool_def):  # type: ignore[override]
        return self.tool_args[tool_def.name]


def manifest_for(
    kind: str = "read",
    *,
    teacher_mode: str = "reading_companion",
    chat: bool = True,
    hint_level: str = "graduated",
    profile: bool = False,
    course: bool = False,
    workspace: bool = False,
) -> CourseManifest:
    return CourseManifest.model_validate(
        {
            "schema_version": 1,
            "id": "demo-course",
            "title": "Demo course",
            "description": "",
            "entry_module_id": "module-one",
            "policies": {
                "content_sharing": "explicit_only",
                "durable_mutation": "proposal_or_direct_student_action",
                "terminal_execution": "student_only",
                "conversation_memory": "session_only",
                "max_shared_chars": 8192,
                "workspace_write_globs": ["notes/*.md"],
            },
            "modules": [
                {
                    "id": "module-one",
                    "title": "Module one",
                    "description": "",
                    "phases": [
                        {
                            "id": "phase-one",
                            "title": "Phase one",
                            "kind": kind,
                            "teacher_mode": teacher_mode,
                            "surfaces": [
                                {
                                    "id": "lesson",
                                    "type": "markdown",
                                    "role": "primary",
                                    "path": "lesson.md",
                                }
                            ],
                            "completion": {
                                "type": "prediction_recorded",
                                "record_id": "prediction-one",
                            }
                            if kind == "predict"
                            else {"type": "manual"},
                            "capabilities": {
                                "chat": chat,
                                "hint_level": hint_level,
                                "share_selection": False,
                                "share_cell": False,
                                "share_output": False,
                                "create_profile_proposal": profile,
                                "create_course_proposal": course,
                                "create_workspace_proposal": workspace,
                            },
                        }
                    ],
                }
            ],
        }
    )


def resolved() -> ResolvedContext:
    return ResolvedContext(
        module_id="module-one",
        phase_id="phase-one",
        surface_id="lesson",
        reason="explicit_phase",
    )


def configured_factory(model: CountingTestModel):
    def factory(_config: ProviderConfig) -> ModelResult:
        return ModelResult(status="configured", adapter=ProviderAdapter(model))

    return factory


@pytest.mark.parametrize(
    ("kind", "posture"),
    [
        ("orient", "Establish the goal, prior experience, and available time without persisting assumptions."),
        ("read", "Explain selected text, connect concepts, and cite the local section."),
        ("watch", "Clarify the current timestamp and connect it to canonical text."),
        ("predict", "Withhold results and solutions until the learner records a prediction."),
        ("experiment", "Interpret outputs and offer a graduated hint ladder."),
        ("lab", "Protect learner ownership: diagnose and review before proposing edits."),
        ("review", "Ask for restatement and compare evidence to claims."),
        ("audit", "Observe the audit without providing substantive help."),
        ("ship", "Present named verification and learner-recorded receipts without inflating claims."),
    ],
)
def test_policy_uses_the_required_posture_for_each_phase(kind: str, posture: str) -> None:
    # Defect caught: a phase kind is omitted or receives another phase's teaching posture.
    from courseweave.professor import build_professor_policy

    policy = build_professor_policy(manifest_for(kind), resolved(), LearnerState(), "learner")

    assert policy.phase_kind == kind
    assert policy.posture == posture
    assert posture in policy.instructions


def test_chat_capability_denial_happens_before_model_construction() -> None:
    # Defect caught: disabled chat reaches the provider and lets model output decide policy.
    from courseweave.professor import CHAT_DISABLED_MESSAGE, ProfessorService

    model = CountingTestModel(custom_output_text="ignored")
    professor = ProfessorService(
        manifest_for(chat=False), resolved(), LearnerState(), "learner",
        ProviderConfig(provider="openai", model="local", api_key="not-a-secret"),
        model_factory=configured_factory(model),
    )

    outcome = professor.respond_sync("Explain the lesson")

    assert outcome.status == "blocked"
    assert outcome.content == CHAT_DISABLED_MESSAGE
    assert model.calls == 0


def test_prediction_gate_requires_the_exact_prediction_record_before_model_call() -> None:
    # Defect caught: a missing or wrong prediction record permits result-seeking help.
    from courseweave.professor import PREDICTION_REQUIRED_MESSAGE, ProfessorService

    model = CountingTestModel(custom_output_text="model answer")
    professor = ProfessorService(
        manifest_for("predict", teacher_mode="socratic_guide"), resolved(), LearnerState(), "learner",
        ProviderConfig(provider="openai", model="local", api_key="not-a-secret"),
        model_factory=configured_factory(model),
    )

    outcome = professor.respond_sync("What is the result?")

    assert outcome.status == "blocked"
    assert outcome.content == PREDICTION_REQUIRED_MESSAGE
    assert model.calls == 0


def test_prediction_gate_opens_after_the_exact_prediction_record_exists() -> None:
    # Defect caught: the predict-first lock remains after the required prediction was recorded.
    from courseweave.professor import ProfessorService

    model = CountingTestModel(custom_output_text="model answer")
    state = LearnerState(
        predictions={
            "module-one/phase-one/prediction-one": {
                "type": "record_prediction",
                "module_id": "module-one",
                "phase_id": "phase-one",
                "record_id": "prediction-one",
                "text": "I predict a pass.",
            }
        }
    )
    professor = ProfessorService(
        manifest_for("predict", teacher_mode="socratic_guide"), resolved(), state, "learner",
        ProviderConfig(provider="openai", model="local", api_key="not-a-secret"),
        model_factory=configured_factory(model),
    )

    outcome = professor.respond_sync("What is the result?")

    assert outcome.status == "ok"
    assert outcome.content == "model answer"
    assert model.calls == 1


@pytest.mark.parametrize(
    ("prompt", "allowed"),
    [
        ("Hello", True),
        ("Thanks!", True),
        ("Where do I record my prediction?", False),
        ("How do I submit a prediction?", False),
        ("I predict the loop will stop.", False),
        ("My prediction is that the graph has a cycle.", False),
        ("My hypothesis is the values are equal.", False),
        ("How do I record a prediction? Also explain the loop invariant.", False),
        ("I predict X; now explain the expected behavior.", False),
        ("Explain the loop invariant.", False),
        ("Help me understand this exercise.", False),
        ("Show me the expected output.", False),
        ("Did the test pass?", False),
        ("Reveal the correct response.", False),
        ("What should I observe?", False),
        ("Can you help with my prediction?", False),
        ("Record my prediction for me.", False),
        ("I predict the correct answer is C.", False),
        ("How do I submit the expected output?", False),
    ],
)
def test_prediction_gate_blocks_every_substantive_request_before_the_exact_record(
    prompt: str, allowed: bool
) -> None:
    # Defect caught: any substantive prompt bypasses predict-first before its exact state record exists.
    from courseweave.professor import PREDICTION_REQUIRED_MESSAGE, ProfessorService

    model = CountingTestModel(custom_output_text="model answer")
    professor = ProfessorService(
        manifest_for("predict", teacher_mode="socratic_guide"), resolved(), LearnerState(), "learner",
        ProviderConfig(provider="openai", model="local", api_key="not-a-secret"),
        model_factory=configured_factory(model),
    )

    outcome = professor.respond_sync(prompt)

    if allowed:
        assert outcome.status == "ok"
        assert outcome.content == "model answer"
        assert model.calls == 1
    else:
        assert outcome.status == "blocked"
        assert outcome.content == PREDICTION_REQUIRED_MESSAGE
        assert model.calls == 0


def test_observer_audit_denial_happens_before_model_construction() -> None:
    # Defect caught: observer audit help is delegated to a model instead of deterministically locked.
    from courseweave.professor import OBSERVER_ONLY_MESSAGE, ProfessorService

    model = CountingTestModel(custom_output_text="ignored")
    professor = ProfessorService(
        manifest_for("audit", teacher_mode="observer"), resolved(), LearnerState(), "learner",
        ProviderConfig(provider="openai", model="local", api_key="not-a-secret"),
        model_factory=configured_factory(model),
    )

    outcome = professor.respond_sync("Explain how to pass this audit")

    assert outcome.status == "blocked"
    assert outcome.content == OBSERVER_ONLY_MESSAGE
    assert model.calls == 0


def test_lab_policy_preserves_learner_ownership_and_hint_ladder() -> None:
    # Defect caught: lab guidance permits silent edits, execution, or skips diagnosis and hints.
    from courseweave.professor import build_professor_policy

    policy = build_professor_policy(manifest_for("lab", teacher_mode="debugging_coach"), resolved(), LearnerState(), "learner")

    assert "diagnose and review before proposing edits" in policy.instructions
    assert "graduated hints" in policy.instructions
    assert "never edit files or execute commands" in policy.instructions


def test_author_policy_is_curriculum_designer_and_only_exposes_manifest_proposals() -> None:
    # Defect caught: author requests inherit learner tools or phase teaching instructions.
    from courseweave.professor import build_professor_policy

    policy = build_professor_policy(
        manifest_for(profile=True, course=False, workspace=True), resolved(), LearnerState(), "author"
    )

    assert policy.teacher_mode == "curriculum_designer"
    assert policy.proposal_types == frozenset({"manifest_replace"})
    assert "curriculum designer" in policy.instructions


def test_empty_course_uses_general_policy_and_reports_missing_provider_without_calling() -> None:
    # Defect caught: empty courses crash or require a configured provider before they remain usable.
    from courseweave.professor import ProfessorService

    empty = manifest_for().model_copy(update={"entry_module_id": None, "modules": []})
    context = ResolvedContext(module_id=None, phase_id=None, surface_id=None, reason="empty_course")
    professor = ProfessorService(
        empty, context, LearnerState(), "learner", ProviderConfig(provider=None)
    )

    outcome = professor.respond_sync("Help me start a course")

    assert outcome.status == "not_configured"
    assert outcome.policy.phase_kind is None
    assert outcome.policy.posture == "Provide general course orientation without assuming an active phase."


@pytest.mark.parametrize(
    ("profile", "course", "workspace", "expected"),
    [
        (False, False, False, frozenset()),
        (True, False, True, frozenset({"profile_patch", "workspace_file_replace"})),
        (True, True, True, frozenset({"profile_patch", "manifest_replace", "workspace_file_replace"})),
    ],
)
def test_learner_proposal_types_follow_phase_capabilities_exactly(
    profile: bool, course: bool, workspace: bool, expected: frozenset[str]
) -> None:
    # Defect caught: a learner proposal tool is exposed without its phase capability.
    from courseweave.professor import build_professor_policy

    policy = build_professor_policy(
        manifest_for(profile=profile, course=course, workspace=workspace), resolved(), LearnerState(), "learner"
    )

    assert policy.proposal_types == expected


def test_learner_agent_exposes_exact_phase_tools_and_a_model_call_creates_pending_proposal(
    tmp_path: Path,
) -> None:
    # Defect caught: model-visible proposal tools differ from policy or bypass pending store creation.
    from courseweave.professor import ProfessorService

    store = CourseStore(tmp_path)
    model = ProposalTestModel(
        {
            "suggest_profile_patch": {
                "summary": "Remember the learner prefers examples.",
                "target": "learner_profile",
                "payload": {"changes": {"preference": "examples"}},
            }
        }
    )
    professor = ProfessorService(
        manifest_for(profile=True, course=True, workspace=True), resolved(), store.get_state(), "learner",
        ProviderConfig(provider="openai", model="local", api_key="not-a-secret"),
        store=store,
        model_factory=configured_factory(model),
    )

    outcome = professor.respond_sync("Suggest a profile preference.")

    assert outcome.status == "ok"
    assert {
        tool.name for tool in model.last_model_request_parameters.function_tools
    } == {
        "suggest_profile_patch",
        "suggest_manifest_replace",
        "suggest_workspace_file_replace",
    }
    proposals = store.list_proposals()
    assert len(proposals) == 1
    assert proposals[0].status == "pending"
    assert proposals[0].origin == "teacher_suggested"
    assert store.get_state().profile == {}


def test_author_agent_exposes_only_the_manifest_suggestion_tool() -> None:
    # Defect caught: Author agent wiring exposes learner proposal tools at the model boundary.
    from courseweave.professor import ProfessorService

    model = CountingTestModel(call_tools=[], custom_output_text="review")
    professor = ProfessorService(
        manifest_for(profile=True, course=False, workspace=True), resolved(), LearnerState(), "author",
        ProviderConfig(provider="openai", model="local", api_key="not-a-secret"),
        model_factory=configured_factory(model),
    )

    outcome = professor.respond_sync("Review the course outline.")

    assert outcome.status == "ok"
    assert {
        tool.name for tool in model.last_model_request_parameters.function_tools
    } == {"suggest_manifest_replace"}


def test_allowed_suggestion_creates_only_a_pending_teacher_proposal(tmp_path: Path) -> None:
    # Defect caught: the model-side suggestion bypasses the store or creates anything except pending consent work.
    from courseweave.professor import ProfessorService

    store = CourseStore(tmp_path)
    professor = ProfessorService(
        manifest_for(profile=True), resolved(), store.get_state(), "learner",
        ProviderConfig(provider=None), store=store,
    )

    proposal = professor.create_suggestion(
        "profile_patch", "Remember the learner prefers examples.", "learner_profile",
        {"changes": {"preference": "examples"}}, idempotency_key="teacher-profile-1",
    )

    assert proposal.status == "pending"
    assert proposal.origin == "teacher_suggested"
    assert proposal.type == "profile_patch"
    assert store.get_state().profile == {}
