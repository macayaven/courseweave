export type ProviderStatus = 'ready' | 'not_configured' | 'provider_error' | 'unknown';

export type PhaseKind = 'orient' | 'read' | 'watch' | 'predict' | 'experiment' | 'lab' | 'review' | 'audit' | 'ship';
export type HintLevel = 'none' | 'gentle' | 'graduated' | 'full';

export interface PhaseCapabilities {
  chat: boolean;
  hint_level: HintLevel;
  share_selection: boolean;
  share_cell: boolean;
  share_output: boolean;
  create_profile_proposal: boolean;
  create_course_proposal: boolean;
  create_workspace_proposal: boolean;
}

export type PhaseCompletion =
  | { type: 'manual' }
  | { type: 'prediction_recorded' | 'receipt_recorded'; record_id: string }
  | { type: 'artifact_exists'; record_id: string; path: string };

export interface CourseSurface {
  id: string;
  type: 'html' | 'markdown' | 'video' | 'notebook' | 'source' | 'terminal' | 'external';
  role: 'primary' | 'reference' | 'exercise' | 'evidence';
  path?: string;
  url?: string;
  label?: string;
}

export interface CoursePhase {
  id: string;
  title: string;
  kind: PhaseKind;
  completion: PhaseCompletion;
  capabilities: PhaseCapabilities;
  surfaces: CourseSurface[];
}

export interface CourseModule {
  id: string;
  title: string;
  phases: CoursePhase[];
}

/** The fields Learner Studio reads from the server-owned manifest. */
export interface CourseManifest {
  title: string;
  modules: CourseModule[];
  policies?: { max_shared_chars: number };
}

export interface LearnerState {
  revision: number;
  time_budget_minutes?: number | null;
  predictions?: Record<string, Record<string, unknown>>;
  reflections?: Record<string, Record<string, unknown>>;
  evidence?: Record<string, Record<string, unknown>>;
  completed_phases?: Record<string, Record<string, unknown>>;
}

export interface Proposal {
  id: string;
  revision: number;
  type: string;
  origin: string;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded' | 'failed';
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

export function findPhase(course: CourseManifest, moduleId: string, phaseId: string) {
  return findModule(course, moduleId)?.phases.find((phase) => phase.id === phaseId) ?? null;
}

export function findSurface(course: CourseManifest, moduleId: string, phaseId: string, surfaceId: string) {
  return findPhase(course, moduleId, phaseId)?.surfaces.find((surface) => surface.id === surfaceId) ?? null;
}

export function hasStateRecord(state: LearnerState, collection: 'predictions' | 'reflections' | 'evidence' | 'completed_phases', moduleId: string, phaseId: string, recordId: string): boolean {
  return Boolean(state[collection]?.[`${moduleId}/${phaseId}/${recordId}`]);
}
