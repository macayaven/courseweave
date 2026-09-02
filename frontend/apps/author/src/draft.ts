import type { AuthorCapabilities, AuthorCompletion, AuthorManifest, AuthorModule, AuthorPhase, AuthorPolicies, AuthorSurface } from '@courseweave/ui';

export type ClientKey = string;
export type DraftSurface = AuthorSurface & { clientKey: ClientKey };
export interface DraftPhase extends Omit<AuthorPhase, 'surfaces'> { clientKey: ClientKey; surfaces: DraftSurface[]; }
export interface DraftModule extends Omit<AuthorModule, 'phases'> { clientKey: ClientKey; phases: DraftPhase[]; }
export interface DraftManifest extends Omit<AuthorManifest, 'modules'> { clientKey: ClientKey; modules: DraftModule[]; nextClientKey: number; }
export type DraftSelection =
  | { type: 'course' }
  | { type: 'module'; moduleKey: ClientKey }
  | { type: 'phase'; moduleKey: ClientKey; phaseKey: ClientKey }
  | { type: 'surface'; moduleKey: ClientKey; phaseKey: ClientKey; surfaceKey: ClientKey };
export interface AuthorDocumentState {
  draft: DraftManifest;
  saved: AuthorManifest | null;
  selection: DraftSelection;
  validation: 'idle' | 'checking' | 'valid' | 'invalid';
  focusKey?: ClientKey;
  notice?: string;
}

type Direction = 'up' | 'down';
type SurfaceType = AuthorSurface['type'];
export type DraftAction =
  | { type: 'select'; selection: DraftSelection }
  | { type: 'course.update'; patch: Partial<Pick<AuthorManifest, 'id' | 'title' | 'description' | 'entry_module_id'>> }
  | { type: 'policy.update'; patch: Partial<AuthorPolicies> }
  | { type: 'module.create'; module?: AuthorModule }
  | { type: 'module.update'; moduleKey: ClientKey; patch: Partial<Pick<AuthorModule, 'id' | 'title' | 'description'>> }
  | { type: 'module.delete'; moduleKey: ClientKey }
  | { type: 'module.duplicate'; moduleKey: ClientKey }
  | { type: 'module.move'; moduleKey: ClientKey; direction: Direction }
  | { type: 'phase.create'; moduleKey: ClientKey }
  | { type: 'phase.update'; moduleKey: ClientKey; phaseKey: ClientKey; patch: Partial<Pick<AuthorPhase, 'id' | 'title' | 'kind' | 'teacher_mode' | 'completion' | 'capabilities'>> }
  | { type: 'phase.delete'; moduleKey: ClientKey; phaseKey: ClientKey }
  | { type: 'phase.duplicate'; moduleKey: ClientKey; phaseKey: ClientKey }
  | { type: 'phase.move'; moduleKey: ClientKey; phaseKey: ClientKey; direction: Direction }
  | { type: 'surface.create'; moduleKey: ClientKey; phaseKey: ClientKey; surfaceType?: SurfaceType }
  | { type: 'surface.update'; moduleKey: ClientKey; phaseKey: ClientKey; surfaceKey: ClientKey; patch: Record<string, unknown> }
  | { type: 'surface.replace'; moduleKey: ClientKey; phaseKey: ClientKey; surfaceKey: ClientKey; surface: AuthorSurface }
  | { type: 'surface.delete'; moduleKey: ClientKey; phaseKey: ClientKey; surfaceKey: ClientKey }
  | { type: 'surface.duplicate'; moduleKey: ClientKey; phaseKey: ClientKey; surfaceKey: ClientKey }
  | { type: 'surface.move'; moduleKey: ClientKey; phaseKey: ClientKey; surfaceKey: ClientKey; direction: Direction };

function key(number: number): ClientKey { return `draft-${number}`; }
function cloneCapabilities(value: AuthorCapabilities): AuthorCapabilities { return { ...value }; }
function cloneCompletion(value: AuthorCompletion): AuthorCompletion { return { ...value }; }
function cloneSurface(value: AuthorSurface, number: number): DraftSurface {
  const clientKey = key(number);
  if (value.type === 'notebook') return { ...value, clientKey, match: value.match === undefined ? undefined : { cell_ids: value.match.cell_ids === undefined ? undefined : [...value.match.cell_ids], cell_tags: value.match.cell_tags === undefined ? undefined : [...value.match.cell_tags] } };
  if (value.type === 'terminal') return { ...value, clientKey, argv: [...value.argv] };
  return { ...value, clientKey };
}
function decorateModule(value: AuthorModule, counter: number): { module: DraftModule; next: number } {
  let next = counter + 1;
  const phases = value.phases.map((phase) => {
    const phaseKey = key(next++);
    const surfaces = phase.surfaces.map((surface) => cloneSurface(surface, next++));
    return { ...phase, clientKey: phaseKey, surfaces, completion: cloneCompletion(phase.completion), capabilities: cloneCapabilities(phase.capabilities) };
  });
  return { module: { ...value, clientKey: key(counter), phases }, next };
}
export function createDraft(manifest: AuthorManifest): DraftManifest {
  let next = 1;
  const modules = manifest.modules.map((module) => { const decorated = decorateModule(module, next); next = decorated.next; return decorated.module; });
  return { ...manifest, clientKey: 'draft-course', modules, policies: { ...manifest.policies, workspace_write_globs: [...manifest.policies.workspace_write_globs] }, nextClientKey: next };
}
function projectSurface(surface: DraftSurface): AuthorSurface {
  const { clientKey: _clientKey, ...rest } = surface;
  if (rest.type === 'notebook') return { ...rest, match: rest.match === undefined ? undefined : { cell_ids: rest.match.cell_ids === undefined ? undefined : [...rest.match.cell_ids], cell_tags: rest.match.cell_tags === undefined ? undefined : [...rest.match.cell_tags] } };
  if (rest.type === 'terminal') return { ...rest, argv: [...rest.argv] };
  return rest;
}
/** The only boundary that removes Author-only identity from a draft. */
export function projectDraft(draft: DraftManifest): AuthorManifest {
  const { clientKey: _clientKey, nextClientKey: _nextClientKey, modules, ...course } = draft;
  return {
    ...course,
    policies: { ...course.policies, workspace_write_globs: [...course.policies.workspace_write_globs] },
    modules: modules.map(({ clientKey: _moduleKey, phases, ...module }) => ({
      ...module,
      phases: phases.map(({ clientKey: _phaseKey, surfaces, capabilities, completion, ...phase }) => ({ ...phase, capabilities: cloneCapabilities(capabilities), completion: cloneCompletion(completion), surfaces: surfaces.map(projectSurface) })),
    })),
  };
}
export function isDraftDirty(draft: DraftManifest, saved: AuthorManifest | null): boolean { return saved === null || JSON.stringify(projectDraft(draft)) !== JSON.stringify(saved); }
export function uniqueSlug(base: string, occupied: ReadonlySet<string>): string {
  const stem = base.length > 0 ? base : 'copy';
  if (!occupied.has(stem)) return stem;
  let candidate = `${stem}-copy`; let number = 2;
  while (occupied.has(candidate)) candidate = `${stem}-copy-${number++}`;
  return candidate;
}
const defaultCapabilities: AuthorCapabilities = { chat: false, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false };
export function createSurfaceStart(type: SurfaceType = 'markdown'): AuthorSurface {
  switch (type) {
    case 'html': case 'markdown': case 'source': return { id: 'surface', type, role: 'primary', path: 'content.md' };
    case 'notebook': return { id: 'surface', type, role: 'primary', path: 'notebook.ipynb' };
    case 'video': return { id: 'surface', type, role: 'primary', path: 'video.mp4' };
    case 'terminal': return { id: 'surface', type, role: 'primary', label: 'Command', argv: ['command'], cwd: '.' };
    case 'external': return { id: 'surface', type, role: 'primary', url: 'https://example.test/' };
  }
}
export function createPhaseStart(id = 'phase'): AuthorPhase { return { id, title: 'New phase', kind: 'read', teacher_mode: 'reading_companion', surfaces: [createSurfaceStart()], completion: { type: 'manual' }, capabilities: cloneCapabilities(defaultCapabilities) }; }
export function createModuleStart(id = 'module'): AuthorModule { return { id, title: 'New module', description: '', phases: [createPhaseStart()] }; }
function allocate(draft: DraftManifest): { draft: DraftManifest; take(): ClientKey } {
  let next = draft.nextClientKey;
  return { draft: { ...draft, nextClientKey: next }, take: () => key(next++) };
}
function withDraft(state: AuthorDocumentState, draft: DraftManifest, changes: Partial<AuthorDocumentState> = {}): AuthorDocumentState { return { ...state, ...changes, draft, validation: 'idle' }; }
function move<T>(items: readonly T[], index: number, direction: Direction): T[] {
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= items.length) return [...items];
  const result = [...items]; const current = result[index]!; result[index] = result[target]!; result[target] = current; return result;
}
function moduleIndex(draft: DraftManifest, moduleKey: ClientKey): number { return draft.modules.findIndex((module) => module.clientKey === moduleKey); }
function phaseIndex(module: DraftModule, phaseKey: ClientKey): number { return module.phases.findIndex((phase) => phase.clientKey === phaseKey); }
function surfaceIndex(phase: DraftPhase, surfaceKey: ClientKey): number { return phase.surfaces.findIndex((surface) => surface.clientKey === surfaceKey); }
function updateModule(draft: DraftManifest, moduleKey: ClientKey, update: (module: DraftModule) => DraftModule): DraftManifest { return { ...draft, modules: draft.modules.map((module) => module.clientKey === moduleKey ? update(module) : module) }; }
function updatePhase(draft: DraftManifest, moduleKey: ClientKey, phaseKey: ClientKey, update: (phase: DraftPhase) => DraftPhase): DraftManifest { return updateModule(draft, moduleKey, (module) => ({ ...module, phases: module.phases.map((phase) => phase.clientKey === phaseKey ? update(phase) : phase) })); }
function occupiedModuleIds(draft: DraftManifest): Set<string> { return new Set(draft.modules.map((module) => module.id)); }
function occupiedPhaseIds(module: DraftModule): Set<string> { return new Set(module.phases.map((phase) => phase.id)); }
function occupiedSurfaceIds(phase: DraftPhase): Set<string> { return new Set(phase.surfaces.map((surface) => surface.id)); }
function duplicateSurface(surface: DraftSurface, id: string, clientKey: ClientKey): DraftSurface { return { ...cloneSurface(projectSurface(surface), Number(clientKey.slice(6))), id, clientKey }; }

export function draftReducer(state: AuthorDocumentState, action: DraftAction): AuthorDocumentState {
  if (action.type === 'select') return { ...state, selection: action.selection, focusKey: undefined };
  if (action.type === 'course.update') return withDraft(state, { ...state.draft, ...action.patch });
  if (action.type === 'policy.update') return withDraft(state, { ...state.draft, policies: { ...state.draft.policies, ...action.patch, workspace_write_globs: action.patch.workspace_write_globs === undefined ? state.draft.policies.workspace_write_globs : [...action.patch.workspace_write_globs] } });
  if (action.type === 'module.create') {
    const source = action.module ?? createModuleStart(uniqueSlug('module', occupiedModuleIds(state.draft)));
    const decorated = decorateModule({ ...source, id: uniqueSlug(source.id, occupiedModuleIds(state.draft)) }, state.draft.nextClientKey);
    const draft = { ...state.draft, modules: [...state.draft.modules, decorated.module], nextClientKey: decorated.next, entry_module_id: state.draft.entry_module_id ?? decorated.module.id };
    return withDraft(state, draft, { selection: { type: 'module', moduleKey: decorated.module.clientKey }, focusKey: decorated.module.clientKey, notice: `Added module ${decorated.module.title}.` });
  }
  if (action.type === 'module.update') {
    const current = state.draft.modules.find((module) => module.clientKey === action.moduleKey); if (current === undefined) return state;
    const nextId = action.patch.id ?? current.id;
    const draft = updateModule(state.draft, action.moduleKey, (module) => ({ ...module, ...action.patch }));
    return withDraft(state, { ...draft, entry_module_id: draft.entry_module_id === current.id ? nextId : draft.entry_module_id });
  }
  if (action.type === 'module.delete') {
    const index = moduleIndex(state.draft, action.moduleKey); const deleted = state.draft.modules[index]; if (deleted === undefined) return state;
    const modules = state.draft.modules.filter((module) => module.clientKey !== action.moduleKey); const fallback = modules[Math.min(index, modules.length - 1)];
    const entry = state.draft.entry_module_id === deleted.id ? (fallback?.id ?? null) : state.draft.entry_module_id;
    return withDraft(state, { ...state.draft, modules, entry_module_id: entry }, { selection: fallback === undefined ? { type: 'course' } : { type: 'module', moduleKey: fallback.clientKey }, focusKey: fallback?.clientKey, notice: `Deleted module ${deleted.title}.` });
  }
  if (action.type === 'module.move') {
    const index = moduleIndex(state.draft, action.moduleKey); const current = state.draft.modules[index]; if (current === undefined) return state;
    return withDraft(state, { ...state.draft, modules: move(state.draft.modules, index, action.direction) }, { focusKey: current.clientKey, notice: `Moved module ${current.title} ${action.direction}.` });
  }
  if (action.type === 'module.duplicate') {
    const index = moduleIndex(state.draft, action.moduleKey); const source = state.draft.modules[index]; if (source === undefined) return state;
    let next = state.draft.nextClientKey; const moduleId = uniqueSlug(source.id, occupiedModuleIds(state.draft));
    const phases = source.phases.map((phase) => {
      const phaseId = uniqueSlug(phase.id, new Set([...occupiedPhaseIds(source), ...source.phases.map((candidate) => candidate.id)]));
      const phaseKey = key(next++);
      const surfaces = phase.surfaces.map((surface) => duplicateSurface(surface, uniqueSlug(surface.id, occupiedSurfaceIds(phase)), key(next++)));
      return { ...phase, id: phaseId, clientKey: phaseKey, surfaces, completion: cloneCompletion(phase.completion), capabilities: cloneCapabilities(phase.capabilities) };
    });
    const copy: DraftModule = { ...source, id: moduleId, clientKey: key(next++), phases };
    const modules = [...state.draft.modules]; modules.splice(index + 1, 0, copy);
    return withDraft(state, { ...state.draft, modules, nextClientKey: next }, { selection: { type: 'module', moduleKey: copy.clientKey }, focusKey: copy.clientKey, notice: `Duplicated module ${source.title}.` });
  }
  const module = state.draft.modules.find((candidate) => candidate.clientKey === action.moduleKey); if (module === undefined) return state;
  if (action.type === 'phase.create') {
    const source = createPhaseStart(uniqueSlug('phase', occupiedPhaseIds(module))); const decorated = decorateModule({ id: 'holder', title: '', description: '', phases: [source] }, state.draft.nextClientKey).module.phases[0]!;
    const draft = updateModule({ ...state.draft, nextClientKey: state.draft.nextClientKey + 3 }, action.moduleKey, (candidate) => ({ ...candidate, phases: [...candidate.phases, decorated] }));
    return withDraft(state, draft, { selection: { type: 'phase', moduleKey: module.clientKey, phaseKey: decorated.clientKey }, focusKey: decorated.clientKey, notice: `Added phase ${decorated.title}.` });
  }
  if (action.type === 'phase.update') return withDraft(state, updatePhase(state.draft, action.moduleKey, action.phaseKey, (phase) => ({ ...phase, ...action.patch, completion: action.patch.completion === undefined ? phase.completion : cloneCompletion(action.patch.completion), capabilities: action.patch.capabilities === undefined ? phase.capabilities : cloneCapabilities(action.patch.capabilities) })));
  if (action.type === 'phase.delete') {
    const index = phaseIndex(module, action.phaseKey); const deleted = module.phases[index]; if (deleted === undefined) return state;
    const phases = module.phases.filter((phase) => phase.clientKey !== action.phaseKey); const fallback = phases[Math.min(index, phases.length - 1)];
    return withDraft(state, updateModule(state.draft, action.moduleKey, (candidate) => ({ ...candidate, phases })), { selection: fallback === undefined ? { type: 'module', moduleKey: module.clientKey } : { type: 'phase', moduleKey: module.clientKey, phaseKey: fallback.clientKey }, focusKey: fallback?.clientKey, notice: `Deleted phase ${deleted.title}.` });
  }
  if (action.type === 'phase.move') {
    const index = phaseIndex(module, action.phaseKey); const current = module.phases[index]; if (current === undefined) return state;
    return withDraft(state, updateModule(state.draft, action.moduleKey, (candidate) => ({ ...candidate, phases: move(candidate.phases, index, action.direction) })), { focusKey: current.clientKey, notice: `Moved phase ${current.title} ${action.direction}.` });
  }
  if (action.type === 'phase.duplicate') {
    const index = phaseIndex(module, action.phaseKey); const source = module.phases[index]; if (source === undefined) return state;
    let next = state.draft.nextClientKey; const copy: DraftPhase = { ...source, id: uniqueSlug(source.id, occupiedPhaseIds(module)), clientKey: key(next++), surfaces: source.surfaces.map((surface) => duplicateSurface(surface, uniqueSlug(surface.id, occupiedSurfaceIds(source)), key(next++))), completion: cloneCompletion(source.completion), capabilities: cloneCapabilities(source.capabilities) };
    const phases = [...module.phases]; phases.splice(index + 1, 0, copy);
    return withDraft(state, updateModule({ ...state.draft, nextClientKey: next }, action.moduleKey, (candidate) => ({ ...candidate, phases })), { selection: { type: 'phase', moduleKey: module.clientKey, phaseKey: copy.clientKey }, focusKey: copy.clientKey, notice: `Duplicated phase ${source.title}.` });
  }
  const phase = module.phases.find((candidate) => candidate.clientKey === action.phaseKey); if (phase === undefined) return state;
  if (action.type === 'surface.create') {
    const source = createSurfaceStart(action.surfaceType); const surface = cloneSurface({ ...source, id: uniqueSlug(source.id, occupiedSurfaceIds(phase)) }, state.draft.nextClientKey);
    return withDraft(state, updatePhase({ ...state.draft, nextClientKey: state.draft.nextClientKey + 1 }, action.moduleKey, action.phaseKey, (candidate) => ({ ...candidate, surfaces: [...candidate.surfaces, surface] })), { selection: { type: 'surface', moduleKey: module.clientKey, phaseKey: phase.clientKey, surfaceKey: surface.clientKey }, focusKey: surface.clientKey, notice: `Added surface ${surface.id}.` });
  }
  if (action.type === 'surface.update') return withDraft(state, updatePhase(state.draft, action.moduleKey, action.phaseKey, (candidate) => ({ ...candidate, surfaces: candidate.surfaces.map((surface) => surface.clientKey === action.surfaceKey ? { ...surface, ...action.patch } as DraftSurface : surface) })));
  if (action.type === 'surface.replace') return withDraft(state, updatePhase(state.draft, action.moduleKey, action.phaseKey, (candidate) => ({ ...candidate, surfaces: candidate.surfaces.map((surface) => surface.clientKey === action.surfaceKey ? cloneSurface(action.surface, Number(surface.clientKey.slice(6))) : surface) })));
  if (action.type === 'surface.delete') {
    const index = surfaceIndex(phase, action.surfaceKey); const deleted = phase.surfaces[index]; if (deleted === undefined) return state;
    const surfaces = phase.surfaces.filter((surface) => surface.clientKey !== action.surfaceKey); const fallback = surfaces[Math.min(index, surfaces.length - 1)];
    return withDraft(state, updatePhase(state.draft, action.moduleKey, action.phaseKey, (candidate) => ({ ...candidate, surfaces })), { selection: fallback === undefined ? { type: 'phase', moduleKey: module.clientKey, phaseKey: phase.clientKey } : { type: 'surface', moduleKey: module.clientKey, phaseKey: phase.clientKey, surfaceKey: fallback.clientKey }, focusKey: fallback?.clientKey, notice: `Deleted surface ${deleted.id}.` });
  }
  if (action.type === 'surface.move') {
    const index = surfaceIndex(phase, action.surfaceKey); const current = phase.surfaces[index]; if (current === undefined) return state;
    return withDraft(state, updatePhase(state.draft, action.moduleKey, action.phaseKey, (candidate) => ({ ...candidate, surfaces: move(candidate.surfaces, index, action.direction) })), { focusKey: current.clientKey, notice: `Moved surface ${current.id} ${action.direction}.` });
  }
  if (action.type === 'surface.duplicate') {
    const index = surfaceIndex(phase, action.surfaceKey); const source = phase.surfaces[index]; if (source === undefined) return state;
    const copy = duplicateSurface(source, uniqueSlug(source.id, occupiedSurfaceIds(phase)), key(state.draft.nextClientKey)); const surfaces = [...phase.surfaces]; surfaces.splice(index + 1, 0, copy);
    return withDraft(state, updatePhase({ ...state.draft, nextClientKey: state.draft.nextClientKey + 1 }, action.moduleKey, action.phaseKey, (candidate) => ({ ...candidate, surfaces })), { selection: { type: 'surface', moduleKey: module.clientKey, phaseKey: phase.clientKey, surfaceKey: copy.clientKey }, focusKey: copy.clientKey, notice: `Duplicated surface ${source.id}.` });
  }
  return state;
}
