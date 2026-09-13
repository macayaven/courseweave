"""Direct learner submission values and server-bound durable record envelopes."""
from typing import Annotated, Literal, TypeAlias

from pydantic import Field, StrictBool, model_validator

from .models import ClosedModel, Slug, DisplayText
from .primitives import LocalPath, HttpsUrl

Digest = Annotated[str, Field(pattern=r'^sha256:[0-9a-f]{64}$')]
RecordText = Annotated[str, Field(min_length=1, max_length=16384, pattern=r'.*\S.*')]


class Coordinate(ClosedModel):
    module_id: Slug
    phase_id: Slug
    requirement_id: Slug


class TextValue(ClosedModel):
    text: RecordText


class LocalEvidence(ClosedModel):
    label: DisplayText
    path: LocalPath


class RemoteEvidence(ClosedModel):
    label: DisplayText
    url: HttpsUrl


class EvidenceValue(ClosedModel):
    references: tuple[LocalEvidence | RemoteEvidence, ...] = Field(min_length=1, max_length=16)
    note: RecordText | None = None


class AttestationValue(ClosedModel):
    attested: StrictBool


RecordValue: TypeAlias = TextValue | EvidenceValue | AttestationValue


class RecordSubmission(ClosedModel):
    """Client payload. Kind, origin and digests are intentionally absent."""
    coordinate: Coordinate
    value: RecordValue


class LearnerRecord(ClosedModel):
    """Trusted storage envelope; construct only through engine.bind_record.

    This shape is not a REST request contract and is not proof of authenticity.
    The server must own loading/persisting it, rejecting envelope fields on input.
    """
    coordinate: Coordinate
    value: RecordValue
    kind: Literal['text', 'evidence', 'attestation']
    origin: Literal['direct_learner']
    requirement_digest: Digest

    @model_validator(mode='after')
    def coherent_kind(self):
        if self.kind != value_kind(self.value):
            raise ValueError('record kind must match value')
        return self


def value_kind(value: RecordValue) -> str:
    return {TextValue: 'text', EvidenceValue: 'evidence', AttestationValue: 'attestation'}[type(value)]
