export type ProviderStatus =
  | "ready"
  | "not_configured"
  | "provider_error"
  | "unknown";

/** Learner and Author consume the same canonical manifest, without a projection adapter. */
export type {
  AuthorExperience as Experience,
  AuthorTeacherPolicy as TeacherPolicy,
  AuthorRequirement as Requirement,
  AuthorLearning as Learning,
  AuthorNotebookSelector as NotebookSelector,
} from "./author-types";
import type {
  AuthorManifest,
  AuthorModule,
  AuthorPhase,
  AuthorSurface,
  AuthorCompletion,
  AuthorTeacherPolicy,
} from "./author-types";
export type HintLevel = AuthorTeacherPolicy["guidance"]["hint_level"];
export type PhaseCompletion = AuthorCompletion;
export type CourseSurface = AuthorSurface;
export type CoursePhase = AuthorPhase;
export type CourseModule = AuthorModule;
export type CourseManifest = AuthorManifest;

export interface RecordCoordinate {
  module_id: string;
  phase_id: string;
  requirement_id: string;
}
export type RecordValue =
  | { text: string }
  | { attested: boolean }
  | {
      references: Array<
        { label: string; path: string } | { label: string; url: string }
      >;
      note?: string | null;
    };
export interface LearnerRecord {
  coordinate: RecordCoordinate;
  value: RecordValue;
  kind: "text" | "evidence" | "attestation";
  origin: "direct_learner";
  requirement_digest: string;
}
export interface AdaptationPreferences {
  enabled: boolean;
  explanation: "concise" | "balanced" | "detailed";
  practice: "standard" | "extra";
}
export interface StoredAttempt {
  module_id: string;
  phase_id: string;
  check_id: string;
  option_id: string;
  check_digest: string;
  objective_digest: string;
  objective_ids: string[];
  correct: boolean;
  feedback: string;
}
export interface PhaseProgress {
  module_id: string;
  phase_id: string;
  progress: "required" | "optional" | "excluded";
  complete: boolean | null;
  requirements: Array<{
    requirement_id: string;
    type: "learner_record" | "artifact_exists";
    satisfied: boolean;
  }>;
}
export interface EffectiveTeacherPolicy {
  mode: "available" | "disabled" | "observer_only";
  provider_callable: boolean;
  unmet_requirement_ids: string[];
  guidance: AuthorTeacherPolicy["guidance"];
  allowed_share_kinds: Array<"selection" | "cell" | "output">;
  allowed_proposal_types: Array<"profile" | "course" | "workspace">;
  max_shared_chars: number;
}
export type TeacherAvailability = Omit<
  EffectiveTeacherPolicy,
  "allowed_proposal_types"
> & { allowed_proposal_types: Array<"profile" | "course"> };
export interface LearnerState {
  schema_version: 2;
  course_id: string;
  root_fingerprint: string;
  revision: number;
  records: LearnerRecord[];
  imports: Array<{
    source_digest: string;
    source_key: string;
    coordinate: RecordCoordinate | null;
    status: "unbound" | "orphan";
    payload: Record<string, unknown>;
  }>;
  attempts: StoredAttempt[];
  preferences: AdaptationPreferences;
  time_budget_minutes: number | null;
  profile: Record<string, unknown>;
  audit: Array<{
    sequence: number;
    proposal_id: string;
    proposal_revision: number;
    status: "accepted" | "rejected" | "failed";
    proposal_type: string;
  }>;
  curriculum_digest: string;
  progress: {
    required_total: number;
    required_complete: number;
    phases: PhaseProgress[];
    records: Array<{
      coordinate: RecordCoordinate | null;
      status: "valid" | "stale" | "orphan" | "invalid";
    }>;
  };
  teacher_availability: Record<string, TeacherAvailability>;
  attempt_statuses: Array<{
    index: number;
    module_id: string;
    phase_id: string;
    check_id: string;
    status: "valid" | "stale" | "orphan";
  }>;
}
export type StateOperation =
  | {
      type: "put_record";
      coordinate: RecordCoordinate;
      curriculum_digest: string;
      value: RecordValue;
    }
  | {
      type: "clear_record";
      coordinate: RecordCoordinate;
      curriculum_digest: string;
    }
  | { type: "set_time_budget"; minutes: number | null }
  | {
      type: "set_preferences";
      preferences: Partial<AdaptationPreferences> & { enabled: boolean };
    }
  | {
      type: "check_attempt";
      module_id: string;
      phase_id: string;
      check_id: string;
      option_id: string;
      curriculum_digest: string;
    }
  | { type: "reset_state" | "delete_state" };
export function sameRecordCoordinate(
  a: RecordCoordinate | null,
  b: RecordCoordinate,
): boolean {
  return (
    a !== null &&
    a.module_id === b.module_id &&
    a.phase_id === b.phase_id &&
    a.requirement_id === b.requirement_id
  );
}

export interface Proposal {
  id: string;
  revision: number;
  type: string;
  origin: string;
  status: "pending" | "accepted" | "rejected" | "superseded" | "failed";
  summary: string;
  created_at: string;
  target: unknown;
  payload: Record<string, unknown>;
  target_hash: string | null;
  result: Record<string, unknown> | null;
}

export function findModule(course: CourseManifest, moduleId: string) {
  return course.modules.find((module) => module.id === moduleId) ?? null;
}

export function findPhase(
  course: CourseManifest,
  moduleId: string,
  phaseId: string,
) {
  return (
    findModule(course, moduleId)?.phases.find(
      (phase) => phase.id === phaseId,
    ) ?? null
  );
}

export function findSurface(
  course: CourseManifest,
  moduleId: string,
  phaseId: string,
  surfaceId: string,
) {
  return (
    findPhase(course, moduleId, phaseId)?.surfaces.find(
      (surface) => surface.id === surfaceId,
    ) ?? null
  );
}
