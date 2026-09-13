/** Faithful canonical schema-v2 manifest. Optional and null values remain distinct. */
export type AuthorSurfacePurpose = "primary" | "supporting" | "reference";
export type AuthorExperience =
  | {
      type: "builtin";
      id:
        | "generic"
        | "orientation"
        | "reading"
        | "media"
        | "prediction"
        | "experiment"
        | "practice"
        | "review"
        | "project";
    }
  | { type: "custom"; id: string };
export type AuthorTeacherStyle =
  | {
      type: "builtin";
      id: "orienting" | "explanatory" | "socratic" | "debugging" | "reviewing";
    }
  | { type: "custom"; id: string };
export type AuthorShareKind = "selection" | "cell" | "output";
export type AuthorProposalType = "profile" | "course" | "workspace";
export type AuthorRequirement =
  | {
      id: string;
      type: "learner_record";
      record_kind: "text" | "evidence" | "attestation";
      prompt: string;
    }
  | { id: string; type: "artifact_exists"; prompt: string; path: string };
export interface AuthorCompletion {
  requirements: AuthorRequirement[];
}
export interface AuthorTeacherPolicy {
  access: {
    mode: "available" | "disabled" | "observer_only";
    requires: string[];
  };
  guidance: {
    style: AuthorTeacherStyle;
    hint_level: "none" | "gentle" | "graduated" | "full";
    text?: string | null;
  };
  sharing: { allow: AuthorShareKind[] };
  proposals: { allow: AuthorProposalType[] };
}
export interface AuthorPolicies {
  content_sharing: "explicit_only";
  allowed_share_kinds: AuthorShareKind[];
  max_shared_chars: number;
  allowed_proposal_types: AuthorProposalType[];
  durable_mutation: "proposal_or_direct_student_action";
  terminal_execution: "student_only";
  conversation_memory: "session_only";
  workspace_write_globs: string[];
}
export type AuthorNotebookSelector =
  | { type: "whole_notebook" }
  | { type: "cell_ids"; values: string[] }
  | { type: "cell_tags"; values: string[]; match: "any" | "all" };
type SurfaceIdentity = {
  id: string;
  purpose: AuthorSurfacePurpose;
  label: string;
};
export type AuthorSurface = SurfaceIdentity &
  (
    | { type: "html"; path: string; fragment?: string | null }
    | { type: "markdown" | "source"; path: string }
    | { type: "notebook"; path: string; selector: AuthorNotebookSelector }
    | {
        type: "video";
        src: string;
        start_seconds?: number | null;
        end_seconds?: number | null;
      }
    | { type: "terminal"; command: string[]; cwd: string }
    | { type: "external"; url: string }
  );
export interface AuthorObjective {
  id: string;
  text: string;
}
export interface AuthorHint {
  id: string;
  text: string;
  objective_ids?: string[];
}
export interface AuthorSourceReference {
  id: string;
  label: string;
  url: string;
  reviewed_date?: string | null;
}
export interface AuthorCheckOption {
  id: string;
  text: string;
  feedback: string;
}
export interface AuthorCheck {
  id: string;
  type: "single_choice";
  prompt: string;
  objective_ids?: string[];
  options: AuthorCheckOption[];
  correct_option_id: string;
}
export interface AuthorLearning {
  objectives?: AuthorObjective[];
  duration?: { min_minutes: number; max_minutes: number } | null;
  overview?: string | null;
  hints?: AuthorHint[];
  sources?: AuthorSourceReference[];
  checks?: AuthorCheck[];
}
export interface AuthorPhase {
  id: string;
  title: string;
  progress: "required" | "optional" | "excluded";
  experience: AuthorExperience;
  surfaces: AuthorSurface[];
  completion?: AuthorCompletion | null;
  teacher: AuthorTeacherPolicy;
  learning?: AuthorLearning | null;
}
export interface AuthorModule {
  id: string;
  title: string;
  description: string;
  phases: AuthorPhase[];
}
export interface AuthorManifest {
  schema_version: 2;
  id: string;
  title: string;
  description: string;
  entry_module_id: string | null;
  runtime?: { type: "jupyter"; kernel: { type: "python_uv_project" } } | null;
  policies: AuthorPolicies;
  modules: AuthorModule[];
}
