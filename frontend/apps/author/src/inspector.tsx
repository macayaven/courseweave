import type { ChangeEvent, Dispatch } from 'react';
import type { AuthorCapabilities, AuthorCompletion, AuthorPhase, AuthorSurface } from '@courseweave/ui';
import type { AuthorDocumentState, DraftAction, DraftPhase, DraftSurface } from './draft';

type InspectorProps = { state: AuthorDocumentState; dispatch: Dispatch<DraftAction> };
const kinds: AuthorPhase['kind'][] = ['orient', 'read', 'watch', 'predict', 'experiment', 'lab', 'review', 'audit', 'ship'];
const modes: AuthorPhase['teacher_mode'][] = ['orienter', 'reading_companion', 'socratic_guide', 'debugging_coach', 'reviewer', 'observer', 'curriculum_designer'];
const surfaceTypes: AuthorSurface['type'][] = ['html', 'markdown', 'source', 'notebook', 'video', 'terminal', 'external'];
const roles: AuthorSurface['role'][] = ['primary', 'reference', 'exercise', 'evidence'];
const completions: AuthorCompletion['type'][] = ['manual', 'prediction_recorded', 'receipt_recorded', 'artifact_exists'];
const hints: AuthorCapabilities['hint_level'][] = ['none', 'gentle', 'graduated', 'full'];

function text(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>): string { return event.currentTarget.value; }
function ArrayFields({ label, values, onChange }: { label: string; values: string[]; onChange(values: string[]): void }) {
  const items = values.length > 0 ? values : [''];
  return <fieldset><legend>{label}</legend>{items.map((value, index) => <label key={index}>{label.slice(0, -1)} {index + 1}<input aria-label={`${label.slice(0, -1)} ${index + 1}`} value={value} onChange={(event) => { const next = [...items]; next[index] = text(event); onChange(next); }} /></label>)}</fieldset>;
}
function CourseInspector({ state, dispatch }: InspectorProps) {
  const course = state.draft;
  return <fieldset><legend>Course</legend>
    <label>Course ID<input value={course.id} onChange={(event) => dispatch({ type: 'course.update', patch: { id: text(event) } })} /></label>
    <label>Course title<input value={course.title} onChange={(event) => dispatch({ type: 'course.update', patch: { title: text(event) } })} /></label>
    <label>Course description<textarea value={course.description} onChange={(event) => dispatch({ type: 'course.update', patch: { description: text(event) } })} /></label>
    <label>Entry module<select value={course.entry_module_id ?? ''} onChange={(event) => dispatch({ type: 'course.update', patch: { entry_module_id: text(event) || null } })}><option value="">None</option>{course.modules.map((module) => <option key={module.clientKey} value={module.id}>{module.title || module.id || 'Unnamed module'}</option>)}</select></label>
    <fieldset><legend>Policies</legend>
      <label>Content sharing<select value={course.policies.content_sharing} onChange={(event) => dispatch({ type: 'policy.update', patch: { content_sharing: text(event) as 'explicit_only' } })}><option value="explicit_only">explicit_only</option></select></label>
      <label>Durable mutation<select value={course.policies.durable_mutation} onChange={(event) => dispatch({ type: 'policy.update', patch: { durable_mutation: text(event) as 'proposal_or_direct_student_action' } })}><option value="proposal_or_direct_student_action">proposal_or_direct_student_action</option></select></label>
      <label>Terminal execution<select value={course.policies.terminal_execution} onChange={(event) => dispatch({ type: 'policy.update', patch: { terminal_execution: text(event) as 'student_only' } })}><option value="student_only">student_only</option></select></label>
      <label>Conversation memory<select value={course.policies.conversation_memory} onChange={(event) => dispatch({ type: 'policy.update', patch: { conversation_memory: text(event) as 'session_only' } })}><option value="session_only">session_only</option></select></label>
      <label>Max shared characters<input type="number" value={course.policies.max_shared_chars} onChange={(event) => dispatch({ type: 'policy.update', patch: { max_shared_chars: Number(text(event)) } })} /></label>
      <ArrayFields label="Workspace write globs" values={course.policies.workspace_write_globs} onChange={(workspace_write_globs) => dispatch({ type: 'policy.update', patch: { workspace_write_globs } })} />
    </fieldset>
  </fieldset>;
}
function ModuleInspector({ state, dispatch, moduleKey }: InspectorProps & { moduleKey: string }) {
  const module = state.draft.modules.find((candidate) => candidate.clientKey === moduleKey); if (module === undefined) return null;
  return <fieldset><legend>Module</legend>
    <label>Module ID<input value={module.id} onChange={(event) => dispatch({ type: 'module.update', moduleKey, patch: { id: text(event) } })} /></label>
    <label>Module title<input value={module.title} onChange={(event) => dispatch({ type: 'module.update', moduleKey, patch: { title: text(event) } })} /></label>
    <label>Module description<textarea value={module.description} onChange={(event) => dispatch({ type: 'module.update', moduleKey, patch: { description: text(event) } })} /></label>
  </fieldset>;
}
function CapabilitiesFields({ phase, change }: { phase: DraftPhase; change(patch: Partial<AuthorCapabilities>): void }) {
  const booleanFields: [keyof Omit<AuthorCapabilities, 'hint_level'>, string][] = [['chat', 'Chat'], ['share_selection', 'Share selection'], ['share_cell', 'Share cell'], ['share_output', 'Share output'], ['create_profile_proposal', 'Create profile proposal'], ['create_course_proposal', 'Create course proposal'], ['create_workspace_proposal', 'Create workspace proposal']];
  return <fieldset><legend>Capabilities</legend>{booleanFields.map(([field, label]) => <label key={field}>{label}<input type="checkbox" checked={phase.capabilities[field]} onChange={(event) => change({ [field]: event.currentTarget.checked })} /></label>)}
    <label>Hint level<select value={phase.capabilities.hint_level} onChange={(event) => change({ hint_level: text(event) as AuthorCapabilities['hint_level'] })}>{hints.map((hint) => <option key={hint} value={hint}>{hint}</option>)}</select></label>
  </fieldset>;
}
function CompletionFields({ completion, change }: { completion: AuthorCompletion; change(completion: AuthorCompletion): void }) {
  const changeType = (type: AuthorCompletion['type']) => { if (type === 'manual') change({ type }); else if (type === 'artifact_exists') change({ type, record_id: 'record', path: 'artifact.txt' }); else change({ type, record_id: 'record' }); };
  return <fieldset><legend>Completion</legend><label>Completion type<select value={completion.type} onChange={(event) => changeType(text(event) as AuthorCompletion['type'])}>{completions.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
    {completion.type !== 'manual' ? <label>Completion record ID<input value={completion.record_id} onChange={(event) => change({ ...completion, record_id: text(event) })} /></label> : null}
    {completion.type === 'artifact_exists' ? <label>Artifact path<input value={completion.path} onChange={(event) => change({ ...completion, path: text(event) })} /></label> : null}
  </fieldset>;
}
function PhaseInspector({ state, dispatch, moduleKey, phaseKey }: InspectorProps & { moduleKey: string; phaseKey: string }) {
  const module = state.draft.modules.find((candidate) => candidate.clientKey === moduleKey); const phase = module?.phases.find((candidate) => candidate.clientKey === phaseKey); if (phase === undefined) return null;
  const update = (change: Partial<Pick<AuthorPhase, 'id' | 'title' | 'kind' | 'teacher_mode' | 'completion' | 'capabilities'>>) => dispatch({ type: 'phase.update', moduleKey, phaseKey, patch: change });
  return <fieldset><legend>Phase</legend>
    <label>Phase ID<input value={phase.id} onChange={(event) => update({ id: text(event) })} /></label>
    <label>Phase title<input value={phase.title} onChange={(event) => update({ title: text(event) })} /></label>
    <label>Phase kind<select value={phase.kind} onChange={(event) => update({ kind: text(event) as AuthorPhase['kind'] })}>{kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
    <label>Teacher mode<select value={phase.teacher_mode} onChange={(event) => update({ teacher_mode: text(event) as AuthorPhase['teacher_mode'] })}>{modes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>
    <CapabilitiesFields phase={phase} change={(capabilities) => update({ capabilities: { ...phase.capabilities, ...capabilities } })} />
    <CompletionFields completion={phase.completion} change={(completion) => update({ completion })} />
  </fieldset>;
}
function changedSurface(type: AuthorSurface['type'], surface: DraftSurface): AuthorSurface {
  const common = { id: surface.id, type, role: surface.role } as const;
  switch (type) {
    case 'html': case 'markdown': case 'source': return { ...common, type, path: 'content.md' };
    case 'notebook': return { ...common, type, path: 'notebook.ipynb' };
    case 'video': return { ...common, type, path: 'video.mp4' };
    case 'terminal': return { ...common, type, label: 'Command', argv: ['command'], cwd: '.' };
    case 'external': return { ...common, type, url: 'https://example.test/' };
  }
}
function SurfaceFields({ surface, update, replace }: { surface: DraftSurface; update(patch: Record<string, unknown>): void; replace(surface: AuthorSurface): void }) {
  const common = <><label>Surface ID<input value={surface.id} onChange={(event) => update({ id: text(event) })} /></label><label>Surface type<select value={surface.type} onChange={(event) => replace(changedSurface(text(event) as AuthorSurface['type'], surface))}>{surfaceTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label><label>Surface role<select value={surface.role} onChange={(event) => update({ role: text(event) })}>{roles.map((role) => <option key={role} value={role}>{role}</option>)}</select></label></>;
  if (surface.type === 'html' || surface.type === 'markdown' || surface.type === 'source') return <>{common}<label>Path<input value={surface.path} onChange={(event) => update({ path: text(event) })} /></label></>;
  if (surface.type === 'notebook') return <>{common}<label>Path<input value={surface.path} onChange={(event) => update({ path: text(event) })} /></label><ArrayFields label="Cell IDs" values={surface.match?.cell_ids ?? []} onChange={(cell_ids) => update({ match: { ...surface.match, cell_ids } })} /><ArrayFields label="Cell tags" values={surface.match?.cell_tags ?? []} onChange={(cell_tags) => update({ match: { ...surface.match, cell_tags } })} /></>;
  if (surface.type === 'terminal') return <>{common}<label>Terminal label<input value={surface.label} onChange={(event) => update({ label: text(event) })} /></label><ArrayFields label="Arguments" values={surface.argv} onChange={(argv) => update({ argv })} /><label>Working directory<input value={surface.cwd} onChange={(event) => update({ cwd: text(event) })} /></label></>;
  if (surface.type === 'external') return <>{common}<label>External URL<input value={surface.url} onChange={(event) => update({ url: text(event) })} /></label></>;
  const video = surface as Extract<DraftSurface, { type: 'video' }>;
  const remote = 'url' in video;
  return <>{common}<label>Video location<select value={remote ? 'remote' : 'local'} onChange={(event) => replace(text(event) === 'remote' ? { id: video.id, type: 'video', role: video.role, url: 'https://example.test/video.mp4' } : { id: video.id, type: 'video', role: video.role, path: 'video.mp4' })}><option value="local">local</option><option value="remote">remote</option></select></label>{remote ? <label>Video URL<input value={video.url} onChange={(event) => update({ url: text(event) })} /></label> : <label>Path<input value={video.path} onChange={(event) => update({ path: text(event) })} /></label>}<label>Start seconds<input type="number" value={video.start_seconds ?? ''} onChange={(event) => update({ start_seconds: Number(text(event)) })} /></label><label>End seconds<input type="number" value={video.end_seconds ?? ''} onChange={(event) => update({ end_seconds: Number(text(event)) })} /></label></>;
}
function SurfaceInspector({ state, dispatch, moduleKey, phaseKey, surfaceKey }: InspectorProps & { moduleKey: string; phaseKey: string; surfaceKey: string }) {
  const surface = state.draft.modules.find((module) => module.clientKey === moduleKey)?.phases.find((phase) => phase.clientKey === phaseKey)?.surfaces.find((candidate) => candidate.clientKey === surfaceKey); if (surface === undefined) return null;
  const update = (patch: Record<string, unknown>) => dispatch({ type: 'surface.update', moduleKey, phaseKey, surfaceKey, patch });
  const replace = (next: AuthorSurface) => dispatch({ type: 'surface.replace', moduleKey, phaseKey, surfaceKey, surface: next });
  return <fieldset><legend>Surface</legend><SurfaceFields surface={surface} update={update} replace={replace} /></fieldset>;
}
export function Inspector({ state, dispatch }: InspectorProps) {
  return <section aria-label="Inspector"><h2>Inspector</h2>{state.selection.type === 'course' ? <CourseInspector state={state} dispatch={dispatch} /> : null}{state.selection.type === 'module' ? <ModuleInspector state={state} dispatch={dispatch} moduleKey={state.selection.moduleKey} /> : null}{state.selection.type === 'phase' ? <PhaseInspector state={state} dispatch={dispatch} moduleKey={state.selection.moduleKey} phaseKey={state.selection.phaseKey} /> : null}{state.selection.type === 'surface' ? <SurfaceInspector state={state} dispatch={dispatch} moduleKey={state.selection.moduleKey} phaseKey={state.selection.phaseKey} surfaceKey={state.selection.surfaceKey} /> : null}</section>;
}
