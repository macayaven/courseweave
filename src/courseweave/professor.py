"""Deterministic professor policy, gates, and inert proposal creation.

This module owns the service-level trust boundary for teacher conversations.
It accepts only server-loaded manifest, resolution, and learner state objects;
automatic context contributes identifiers and never shared workspace content.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic_ai import Agent

from courseweave.models import Capabilities, CourseManifest, Phase, ResolvedContext
from courseweave.providers import ModelResult, ProviderConfig, create_model
from courseweave.store import CourseStore, LearnerState, Proposal, ProposalRequest

Role = Literal["learner", "author"]
OutcomeStatus = Literal["ok", "blocked", "not_configured", "provider_error"]
ProposalType = Literal[
    "profile_patch", "manifest_replace", "workspace_file_replace"
]
ModelFactory = Callable[[ProviderConfig], ModelResult]

CHAT_DISABLED_MESSAGE = "Chat is unavailable for this phase."
PREDICTION_REQUIRED_MESSAGE = (
    "Record your prediction before requesting the result or solution."
)
OBSERVER_ONLY_MESSAGE = "This audit is observer-only; substantive help is unavailable."
PROVIDER_ERROR_MESSAGE = "The provider request failed."

_POSTURES = {
    "orient": "Establish the goal, prior experience, and available time without persisting assumptions.",
    "read": "Explain selected text, connect concepts, and cite the local section.",
    "watch": "Clarify the current timestamp and connect it to canonical text.",
    "predict": "Withhold results and solutions until the learner records a prediction.",
    "experiment": "Interpret outputs and offer a graduated hint ladder.",
    "lab": "Protect learner ownership: diagnose and review before proposing edits.",
    "review": "Ask for restatement and compare evidence to claims.",
    "audit": "Observe the audit without providing substantive help.",
    "ship": "Present named verification and learner-recorded receipts without inflating claims.",
}
_GENERAL_POSTURE = "Provide general course orientation without assuming an active phase."
_RESULT_SEEKING_TERMS = ("answer", "result", "solution", "outcome", "what happens")
_NON_SUBSTANTIVE_REQUESTS = {"", "hello", "hi", "thanks", "thank you"}


class ProfessorPolicyError(ValueError):
    """A request attempts an unavailable professor proposal action."""


@dataclass(frozen=True)
class ProfessorPolicy:
    """Trusted, phase-aware policy assembled without client authority."""

    role: Role
    module_id: str | None
    phase_id: str | None
    phase_kind: str | None
    teacher_mode: str
    capabilities: Capabilities | None
    posture: str
    instructions: str
    proposal_types: frozenset[ProposalType]
    prediction_record_id: str | None


@dataclass(frozen=True)
class ProfessorOutcome:
    """A structured service result safe for the later AG-UI transport."""

    status: OutcomeStatus
    content: str | None
    policy: ProfessorPolicy
    missing: tuple[str, ...] = ()


def build_professor_policy(
    manifest: CourseManifest,
    resolved: ResolvedContext,
    learner_state: LearnerState,
    role: Role,
) -> ProfessorPolicy:
    """Build policy solely from trusted server state.

    ``learner_state`` is intentionally an explicit argument even though only
    request-time gates inspect its records: callers cannot substitute phase
    authority or capabilities from an untrusted conversation payload.
    """
    del learner_state
    active = _active_phase(manifest, resolved)
    if role == "author":
        return ProfessorPolicy(
            role=role,
            module_id=resolved.module_id if active is not None else None,
            phase_id=resolved.phase_id if active is not None else None,
            phase_kind=active.kind if active is not None else None,
            teacher_mode="curriculum_designer",
            capabilities=active.capabilities if active is not None else None,
            posture="Design curriculum changes as reviewable, inert proposals.",
            instructions=(
                "You are a curriculum designer. Suggest only inert manifest replacement "
                "proposals; never apply a change, write files, execute commands, or "
                "change learner state."
            ),
            proposal_types=frozenset({"manifest_replace"}),
            prediction_record_id=None,
        )
    if active is None:
        return ProfessorPolicy(
            role=role,
            module_id=None,
            phase_id=None,
            phase_kind=None,
            teacher_mode="orienter",
            capabilities=None,
            posture=_GENERAL_POSTURE,
            instructions=(
                f"{_GENERAL_POSTURE} Use only automatic metadata; request an explicit "
                "Share action before discussing selection, cells, output, or source text. "
                "Never write files, execute commands, or change learner state."
            ),
            proposal_types=frozenset(),
            prediction_record_id=None,
        )

    prediction_record_id = (
        active.completion.record_id
        if active.completion.type == "prediction_recorded"
        else None
    )
    posture = _POSTURES[active.kind]
    lab_guard = ""
    if active.kind == "lab":
        lab_guard = (
            " Diagnose and review before proposing edits; use graduated hints "
            f"according to the configured {active.capabilities.hint_level} hint level; "
            "never edit files or execute commands."
        )
    return ProfessorPolicy(
        role=role,
        module_id=resolved.module_id,
        phase_id=resolved.phase_id,
        phase_kind=active.kind,
        teacher_mode=active.teacher_mode,
        capabilities=active.capabilities,
        posture=posture,
        instructions=(
            f"Teacher mode: {active.teacher_mode}. {posture}{lab_guard} "
            "Use only automatic metadata; request an explicit Share action before "
            "discussing selection, cells, output, or source text. Never write files, "
            "execute commands, apply proposals, or update learner state."
        ),
        proposal_types=_learner_proposal_types(active.capabilities),
        prediction_record_id=prediction_record_id,
    )


class ProfessorService:
    """Runs deterministic gates before lazily constructing a Pydantic AI agent."""

    def __init__(
        self,
        manifest: CourseManifest,
        resolved: ResolvedContext,
        learner_state: LearnerState,
        role: Role,
        provider_config: ProviderConfig,
        *,
        store: CourseStore | None = None,
        model_factory: ModelFactory = create_model,
    ) -> None:
        self.manifest = manifest
        self.resolved = resolved
        self.learner_state = learner_state
        self.provider_config = provider_config
        self.store = store
        self.model_factory = model_factory
        self.policy = build_professor_policy(manifest, resolved, learner_state, role)

    def gate(self, request: str) -> ProfessorOutcome | None:
        """Return a fixed deterministic denial, or ``None`` when the model may run."""
        if _is_substantive(request) and (
            self.policy.capabilities is not None and not self.policy.capabilities.chat
        ):
            return ProfessorOutcome("blocked", CHAT_DISABLED_MESSAGE, self.policy)
        if _requires_prediction(self.policy, self.learner_state) and _is_result_seeking(request):
            return ProfessorOutcome("blocked", PREDICTION_REQUIRED_MESSAGE, self.policy)
        if (
            self.policy.phase_kind == "audit"
            and self.policy.teacher_mode == "observer"
            and _is_substantive(request)
        ):
            return ProfessorOutcome("blocked", OBSERVER_ONLY_MESSAGE, self.policy)
        return None

    async def respond(self, request: str) -> ProfessorOutcome:
        """Gate a request, then lazily run the configured Pydantic AI professor."""
        denied = self.gate(request)
        if denied is not None:
            return denied
        model_result = self.model_factory(self.provider_config)
        if model_result.status == "not_configured" or model_result.adapter is None:
            return ProfessorOutcome(
                "not_configured", None, self.policy, model_result.missing
            )
        agent = self._agent_for(model_result)
        try:
            result = await agent.run(request)
        except Exception:
            return ProfessorOutcome("provider_error", PROVIDER_ERROR_MESSAGE, self.policy)
        return ProfessorOutcome("ok", str(result.output), self.policy)

    def respond_sync(self, request: str) -> ProfessorOutcome:
        """Synchronous convenience seam for non-AG-UI service callers."""
        return asyncio.run(self.respond(request))

    def create_suggestion(
        self,
        proposal_type: ProposalType,
        summary: str,
        target: Any,
        payload: dict[str, Any],
        *,
        target_hash: str | None = None,
        idempotency_key: str | None = None,
    ) -> Proposal:
        """Create exactly one pending teacher suggestion through the durable store."""
        if proposal_type not in self.policy.proposal_types:
            raise ProfessorPolicyError("That proposal type is unavailable for this role and phase.")
        if self.store is None:
            raise ProfessorPolicyError("A course store is required to create a proposal.")
        request = ProposalRequest(
            type=proposal_type,
            origin="teacher_suggested",
            summary=summary,
            target=target,
            payload=payload,
            target_hash=target_hash,
        )
        return self.store.create_proposal(
            request, idempotency_key or f"teacher-suggestion-{uuid.uuid4()}"
        )

    def _agent_for(self, model_result: ModelResult) -> Agent[None, str]:
        """Construct the Pydantic AI agent only after configuration and gates pass."""
        assert model_result.adapter is not None
        agent: Agent[None, str] = Agent(
            model_result.adapter.model,
            instructions=self.policy.instructions,
            name="courseweave-professor",
        )
        for proposal_type in sorted(self.policy.proposal_types):
            agent.tool(
                self._suggestion_tool(proposal_type),
                name=f"suggest_{proposal_type}",
                description="Create one inert pending teacher suggestion for learner review.",
            )
        return agent

    def _suggestion_tool(self, proposal_type: ProposalType):
        def suggest(
            summary: str,
            target: Any,
            payload: dict[str, Any],
            target_hash: str | None = None,
        ) -> dict[str, Any]:
            """Create an inert pending proposal; it never applies or edits a target."""
            proposal = self.create_suggestion(
                proposal_type,
                summary,
                target,
                payload,
                target_hash=target_hash,
            )
            return {
                "proposal_id": proposal.id,
                "revision": proposal.revision,
                "status": proposal.status,
            }

        return suggest


def _active_phase(
    manifest: CourseManifest, resolved: ResolvedContext
) -> Phase | None:
    for module in manifest.modules:
        if module.id != resolved.module_id:
            continue
        for phase in module.phases:
            if phase.id == resolved.phase_id:
                return phase
    return None


def _learner_proposal_types(capabilities: Capabilities) -> frozenset[ProposalType]:
    proposal_types: set[ProposalType] = set()
    if capabilities.create_profile_proposal:
        proposal_types.add("profile_patch")
    if capabilities.create_course_proposal:
        proposal_types.add("manifest_replace")
    if capabilities.create_workspace_proposal:
        proposal_types.add("workspace_file_replace")
    return frozenset(proposal_types)


def _requires_prediction(policy: ProfessorPolicy, state: LearnerState) -> bool:
    if policy.prediction_record_id is None:
        return False
    assert policy.module_id is not None and policy.phase_id is not None
    key = f"{policy.module_id}/{policy.phase_id}/{policy.prediction_record_id}"
    return key not in state.predictions


def _is_result_seeking(request: str) -> bool:
    text = request.casefold()
    return any(term in text for term in _RESULT_SEEKING_TERMS)


def _is_substantive(request: str) -> bool:
    return request.strip().casefold() not in _NON_SUBSTANTIVE_REQUESTS
