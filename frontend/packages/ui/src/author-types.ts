/** Full schema-v1 manifest view used by Author; the learner view stays lossy. */
export type AuthorSurfaceRole = 'primary' | 'reference' | 'exercise' | 'evidence';
export type AuthorPhaseKind = 'orient' | 'read' | 'watch' | 'predict' | 'experiment' | 'lab' | 'review' | 'audit' | 'ship';
export type AuthorTeacherMode = 'orienter' | 'reading_companion' | 'socratic_guide' | 'debugging_coach' | 'reviewer' | 'observer' | 'curriculum_designer';
export type AuthorCompletion = { type: 'manual' } | { type: 'prediction_recorded' | 'receipt_recorded'; record_id: string } | { type: 'artifact_exists'; record_id: string; path: string };
export interface AuthorCapabilities { chat: boolean; hint_level: 'none' | 'gentle' | 'graduated' | 'full'; share_selection: boolean; share_cell: boolean; share_output: boolean; create_profile_proposal: boolean; create_course_proposal: boolean; create_workspace_proposal: boolean; }
export interface AuthorPolicies {
  content_sharing: 'explicit_only';
  durable_mutation: 'proposal_or_direct_student_action';
  terminal_execution: 'student_only';
  conversation_memory: 'session_only';
  max_shared_chars: number;
  workspace_write_globs: string[];
}
export interface AuthorNotebookMatch { cell_ids?: string[]; cell_tags?: string[]; }
export type AuthorSurface =
  | { id: string; type: 'html' | 'markdown' | 'source'; role: AuthorSurfaceRole; path: string }
  | { id: string; type: 'notebook'; role: AuthorSurfaceRole; path: string; match?: AuthorNotebookMatch }
  | { id: string; type: 'video'; role: AuthorSurfaceRole; path: string; url?: never; start_seconds?: number; end_seconds?: number }
  | { id: string; type: 'video'; role: AuthorSurfaceRole; url: string; path?: never; start_seconds?: number; end_seconds?: number }
  | { id: string; type: 'terminal'; role: AuthorSurfaceRole; label: string; argv: string[]; cwd: string }
  | { id: string; type: 'external'; role: AuthorSurfaceRole; url: string };
export interface AuthorPhase { id: string; title: string; kind: AuthorPhaseKind; teacher_mode: AuthorTeacherMode; surfaces: AuthorSurface[]; completion: AuthorCompletion; capabilities: AuthorCapabilities; }
export interface AuthorModule { id: string; title: string; description: string; phases: AuthorPhase[]; }
export interface AuthorManifest { schema_version: 1; id: string; title: string; description: string; entry_module_id: string | null; policies: AuthorPolicies; modules: AuthorModule[]; }
