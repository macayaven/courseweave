export type ProviderStatus = 'ready' | 'not_configured' | 'provider_error' | 'unknown';

export interface CoursePhase {
  id: string;
  title: string;
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
}

export interface LearnerState {
  revision: number;
  time_budget_minutes?: number | null;
}

export interface Proposal {
  id: string;
  revision: number;
  status: string;
  summary: string;
}
