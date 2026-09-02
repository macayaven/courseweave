import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AuthorManifest } from '@courseweave/ui';
import {
  createDraft,
  createModuleStart,
  draftReducer,
  isDraftDirty,
  projectDraft,
  uniqueSlug,
  type AuthorDocumentState,
} from '../src/draft';

const capabilities = {
  chat: true, hint_level: 'graduated' as const, share_selection: true, share_cell: true,
  share_output: true, create_profile_proposal: true, create_course_proposal: true,
  create_workspace_proposal: true,
};

const richManifest: AuthorManifest = {
  schema_version: 1, id: 'course', title: 'Course', description: 'Rich fixture', entry_module_id: 'module-a',
  policies: { content_sharing: 'explicit_only', durable_mutation: 'proposal_or_direct_student_action', terminal_execution: 'student_only', conversation_memory: 'session_only', max_shared_chars: 1000, workspace_write_globs: ['labs/**', 'notes/*.md'] },
  modules: [{ id: 'module-a', title: 'Module A', description: 'First', phases: [
    { id: 'orient', title: 'Orient', kind: 'orient', teacher_mode: 'orienter', capabilities, completion: { type: 'manual' }, surfaces: [
      { id: 'notebook', type: 'notebook', role: 'primary', path: 'notebooks/one.ipynb', match: { cell_ids: ['cell-a'], cell_tags: ['intro'] } },
      { id: 'local-video', type: 'video', role: 'reference', path: 'media/local.mp4', start_seconds: 1, end_seconds: 2 },
      { id: 'remote-video', type: 'video', role: 'reference', url: 'https://video.example/course.mp4', start_seconds: 3, end_seconds: 4 },
      { id: 'terminal', type: 'terminal', role: 'exercise', label: 'Run checks', argv: ['uv', 'run', 'pytest', '-q'], cwd: 'labs/week-1' },
      { id: 'external', type: 'external', role: 'evidence', url: 'https://example.test/reference' },
    ] },
    { id: 'predict', title: 'Predict', kind: 'predict', teacher_mode: 'socratic_guide', capabilities, completion: { type: 'prediction_recorded', record_id: 'prediction-record' }, surfaces: [{ id: 'markdown', type: 'markdown', role: 'primary', path: 'lessons/predict.md' }] },
    { id: 'review', title: 'Review', kind: 'review', teacher_mode: 'reviewer', capabilities, completion: { type: 'receipt_recorded', record_id: 'receipt-record' }, surfaces: [{ id: 'source', type: 'source', role: 'primary', path: 'src/main.py' }] },
    { id: 'ship', title: 'Ship', kind: 'ship', teacher_mode: 'observer', capabilities, completion: { type: 'artifact_exists', record_id: 'artifact-record', path: 'dist/result.txt' }, surfaces: [{ id: 'html', type: 'html', role: 'primary', path: 'docs/index.html' }] },
  ] }],
};

function state(manifest: AuthorManifest = richManifest): AuthorDocumentState {
  return { draft: createDraft(manifest), selection: { type: 'course' }, validation: 'valid', saved: manifest };
}

describe('Author draft reducer', () => {
  it('treats both canonical example manifests as clean immediately after draft hydration', () => {
    for (const path of ['../../../../examples/minimal-course/courseweave.json', '../../../../examples/cli-course/courseweave.json']) {
      const manifest = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as AuthorManifest;
      expect(isDraftDirty(createDraft(manifest), manifest)).toBe(false);
    }
  });

  it('creates, edits, moves, duplicates, and deletes modules without mutating its input', () => {
    const before = state();
    const snapshot = structuredClone(before);
    const created = draftReducer(before, { type: 'module.create', module: createModuleStart('module-b') });
    const moduleA = created.draft.modules[0]!;
    const moduleB = created.draft.modules[1]!;
    expect(projectDraft(created.draft).modules.map((module) => module.id)).toEqual(['module-a', 'module-b']);
    const renamed = draftReducer(created, { type: 'module.update', moduleKey: moduleB.clientKey, patch: { id: 'renamed-module', title: 'Renamed' } });
    const moved = draftReducer(renamed, { type: 'module.move', moduleKey: moduleB.clientKey, direction: 'up' });
    expect(projectDraft(moved.draft).modules.map((module) => module.id)).toEqual(['renamed-module', 'module-a']);
    const duplicated = draftReducer(moved, { type: 'module.duplicate', moduleKey: moduleA.clientKey });
    expect(projectDraft(duplicated.draft).modules.map((module) => module.id)).toEqual(['renamed-module', 'module-a', 'module-a-copy']);
    const deleted = draftReducer(duplicated, { type: 'module.delete', moduleKey: moduleB.clientKey });
    expect(projectDraft(deleted.draft).modules.map((module) => module.id)).toEqual(['module-a', 'module-a-copy']);
    expect(before).toEqual(snapshot);
    expect(deleted.validation).toBe('idle');
  });

  it('creates, edits, moves, duplicates, and deletes phases and surfaces in exact order', () => {
    const initial = state();
    const module = initial.draft.modules[0]!;
    const orient = module.phases[0]!;
    const notebook = orient.surfaces[0]!;
    const phaseCreated = draftReducer(initial, { type: 'phase.create', moduleKey: module.clientKey });
    const extraPhase = phaseCreated.draft.modules[0]!.phases[4]!;
    const phaseMoved = draftReducer(phaseCreated, { type: 'phase.move', moduleKey: module.clientKey, phaseKey: extraPhase.clientKey, direction: 'up' });
    expect(projectDraft(phaseMoved.draft).modules[0]!.phases.map((phase) => phase.id)).toEqual(['orient', 'predict', 'review', 'phase', 'ship']);
    const phaseUpdated = draftReducer(phaseMoved, { type: 'phase.update', moduleKey: module.clientKey, phaseKey: extraPhase.clientKey, patch: { id: '' } });
    const phaseDuplicated = draftReducer(phaseUpdated, { type: 'phase.duplicate', moduleKey: module.clientKey, phaseKey: orient.clientKey });
    expect(projectDraft(phaseDuplicated.draft).modules[0]!.phases.map((phase) => phase.id)).toEqual(['orient', 'orient-copy', 'predict', 'review', '', 'ship']);
    const surfaceCreated = draftReducer(phaseDuplicated, { type: 'surface.create', moduleKey: module.clientKey, phaseKey: orient.clientKey, surfaceType: 'external' });
    const external = surfaceCreated.draft.modules[0]!.phases[0]!.surfaces[5]!;
    const surfaceUpdated = draftReducer(surfaceCreated, { type: 'surface.update', moduleKey: module.clientKey, phaseKey: orient.clientKey, surfaceKey: external.clientKey, patch: { url: 'https://docs.example/new' } });
    const surfaceMoved = draftReducer(surfaceUpdated, { type: 'surface.move', moduleKey: module.clientKey, phaseKey: orient.clientKey, surfaceKey: external.clientKey, direction: 'up' });
    expect(projectDraft(surfaceMoved.draft).modules[0]!.phases[0]!.surfaces.map((surface) => surface.id)).toEqual(['notebook', 'local-video', 'remote-video', 'terminal', 'surface', 'external']);
    const surfaceDuplicated = draftReducer(surfaceMoved, { type: 'surface.duplicate', moduleKey: module.clientKey, phaseKey: orient.clientKey, surfaceKey: notebook.clientKey });
    expect(projectDraft(surfaceDuplicated.draft).modules[0]!.phases[0]!.surfaces.map((surface) => surface.id)).toEqual(['notebook', 'notebook-copy', 'local-video', 'remote-video', 'terminal', 'surface', 'external']);
    const surfaceDeleted = draftReducer(surfaceDuplicated, { type: 'surface.delete', moduleKey: module.clientKey, phaseKey: orient.clientKey, surfaceKey: external.clientKey });
    expect(projectDraft(surfaceDeleted.draft).modules[0]!.phases[0]!.surfaces.map((surface) => surface.id)).toEqual(['notebook', 'notebook-copy', 'local-video', 'remote-video', 'terminal', 'external']);
    const phaseDeleted = draftReducer(surfaceDeleted, { type: 'phase.delete', moduleKey: module.clientKey, phaseKey: extraPhase.clientKey });
    expect(projectDraft(phaseDeleted.draft).modules[0]!.phases.map((phase) => phase.id)).toEqual(['orient', 'orient-copy', 'predict', 'review', 'ship']);
  });

  it('deep-duplicates rich content while refreshing only manifest entity IDs and client keys', () => {
    const initial = state();
    const original = initial.draft.modules[0]!;
    const next = draftReducer(initial, { type: 'module.duplicate', moduleKey: original.clientKey });
    const copy = next.draft.modules[1]!;
    const projectedCopy = projectDraft(next.draft).modules[1]!;
    expect(copy.clientKey).not.toBe(original.clientKey);
    expect(projectedCopy.id).toBe('module-a-copy');
    expect(projectedCopy.phases.map((phase) => phase.id)).toEqual(['orient-copy', 'predict-copy', 'review-copy', 'ship-copy']);
    expect(projectedCopy.phases.flatMap((phase) => phase.surfaces.map((surface) => surface.id))).toEqual(['notebook-copy', 'local-video-copy', 'remote-video-copy', 'terminal-copy', 'external-copy', 'markdown-copy', 'source-copy', 'html-copy']);
    expect(projectedCopy.phases[0]!.surfaces[0]).toMatchObject({ path: 'notebooks/one.ipynb', match: { cell_ids: ['cell-a'], cell_tags: ['intro'] } });
    expect(projectedCopy.phases[0]!.surfaces[1]).toMatchObject({ path: 'media/local.mp4', start_seconds: 1, end_seconds: 2 });
    expect(projectedCopy.phases[0]!.surfaces[2]).toMatchObject({ url: 'https://video.example/course.mp4', start_seconds: 3, end_seconds: 4 });
    expect(projectedCopy.phases[0]!.surfaces[3]).toMatchObject({ argv: ['uv', 'run', 'pytest', '-q'], cwd: 'labs/week-1' });
    expect(projectedCopy.phases[0]!.surfaces[4]).toMatchObject({ url: 'https://example.test/reference' });
    expect(projectedCopy.phases.map((phase) => phase.completion)).toEqual([
      { type: 'manual' }, { type: 'prediction_recorded', record_id: 'prediction-record' },
      { type: 'receipt_recorded', record_id: 'receipt-record' }, { type: 'artifact_exists', record_id: 'artifact-record', path: 'dist/result.txt' },
    ]);
    expect(projectedCopy.phases[0]!.capabilities).toEqual(capabilities);
  });

  it('allocates collision-safe slugs and keeps editable IDs separate from stable selection keys', () => {
    expect(uniqueSlug('lesson', new Set(['lesson', 'lesson-copy', 'lesson-copy-2', 'lesson-copy-3']))).toBe('lesson-copy-4');
    const initial = state();
    const module = initial.draft.modules[0]!;
    const selected: AuthorDocumentState = { ...initial, selection: { type: 'phase', moduleKey: module.clientKey, phaseKey: module.phases[0]!.clientKey } };
    const blank = draftReducer(selected, { type: 'phase.update', moduleKey: module.clientKey, phaseKey: module.phases[0]!.clientKey, patch: { id: '' } });
    const duplicateId = draftReducer(blank, { type: 'phase.update', moduleKey: module.clientKey, phaseKey: module.phases[1]!.clientKey, patch: { id: '' } });
    const reordered = draftReducer(duplicateId, { type: 'phase.move', moduleKey: module.clientKey, phaseKey: module.phases[0]!.clientKey, direction: 'down' });
    expect(reordered.selection).toEqual(selected.selection);
    expect(reordered.draft.modules[0]!.phases.map((phase) => phase.id)).toEqual(['', '', 'review', 'ship']);
    expect(reordered.draft.modules[0]!.phases.map((phase) => phase.clientKey)).toContain(module.phases[0]!.clientKey);
  });

  it('repairs the entry module for rename, deletion, final deletion, unrelated deletion, and reorder', () => {
    const manifest: AuthorManifest = { ...richManifest, entry_module_id: 'module-a', modules: [richManifest.modules[0]!, { ...richManifest.modules[0]!, id: 'module-b' }, { ...richManifest.modules[0]!, id: 'module-c' }] };
    const initial = state(manifest);
    const [first, second, third] = initial.draft.modules;
    const renamed = draftReducer(initial, { type: 'module.update', moduleKey: first!.clientKey, patch: { id: 'module-renamed' } });
    expect(projectDraft(renamed.draft).entry_module_id).toBe('module-renamed');
    const deletedEntry = draftReducer(initial, { type: 'module.delete', moduleKey: first!.clientKey });
    expect(projectDraft(deletedEntry.draft).entry_module_id).toBe('module-b');
    const unrelated = draftReducer(initial, { type: 'module.delete', moduleKey: third!.clientKey });
    expect(projectDraft(unrelated.draft).entry_module_id).toBe('module-a');
    const reordered = draftReducer(initial, { type: 'module.move', moduleKey: second!.clientKey, direction: 'up' });
    expect(projectDraft(reordered.draft).entry_module_id).toBe('module-a');
    const one = state({ ...richManifest, modules: [richManifest.modules[0]!] });
    const finalDelete = draftReducer(one, { type: 'module.delete', moduleKey: one.draft.modules[0]!.clientKey });
    expect(projectDraft(finalDelete.draft).entry_module_id).toBeNull();
  });

  it('keeps entry ownership attached to its client key while non-entry IDs are duplicate or blank', () => {
    const initial = state({ ...richManifest, modules: [richManifest.modules[0]!, { ...richManifest.modules[0]!, id: 'module-b' }] });
    const [entry, other] = initial.draft.modules;
    const duplicate = draftReducer(initial, { type: 'module.update', moduleKey: other!.clientKey, patch: { id: entry!.id } });
    const renamed = draftReducer(duplicate, { type: 'module.update', moduleKey: other!.clientKey, patch: { id: '' } });
    expect(projectDraft(renamed.draft).entry_module_id).toBe('module-a');
    const deleted = draftReducer(duplicate, { type: 'module.delete', moduleKey: other!.clientKey });
    expect(projectDraft(deleted.draft).entry_module_id).toBe('module-a');
  });

  it('allocates unique copied nested IDs sequentially from duplicate and blank source IDs', () => {
    const initial = state();
    const module = initial.draft.modules[0]!;
    const blankPhase = draftReducer(draftReducer(initial, { type: 'phase.update', moduleKey: module.clientKey, phaseKey: module.phases[0]!.clientKey, patch: { id: '' } }), { type: 'phase.update', moduleKey: module.clientKey, phaseKey: module.phases[1]!.clientKey, patch: { id: '' } });
    const moduleCopy = draftReducer(blankPhase, { type: 'module.duplicate', moduleKey: module.clientKey });
    expect(projectDraft(moduleCopy.draft).modules[1]!.phases.map((phase) => phase.id)).toEqual(['copy', 'copy-copy', 'review-copy', 'ship-copy']);

    const sourcePhase = initial.draft.modules[0]!.phases[0]!;
    const blankSurface = draftReducer(draftReducer(initial, { type: 'surface.update', moduleKey: module.clientKey, phaseKey: sourcePhase.clientKey, surfaceKey: sourcePhase.surfaces[0]!.clientKey, patch: { id: '' } }), { type: 'surface.update', moduleKey: module.clientKey, phaseKey: sourcePhase.clientKey, surfaceKey: sourcePhase.surfaces[1]!.clientKey, patch: { id: '' } });
    const phaseCopy = draftReducer(blankSurface, { type: 'phase.duplicate', moduleKey: module.clientKey, phaseKey: sourcePhase.clientKey });
    expect(projectDraft(phaseCopy.draft).modules[0]!.phases[1]!.surfaces.map((surface) => surface.id)).toEqual(['copy', 'copy-copy', 'remote-video-copy', 'terminal-copy', 'external-copy']);
  });

  it('keeps valid starts and intentionally incomplete local edits in memory without automatic repair or save', () => {
    const empty: AuthorManifest = { ...richManifest, modules: [], entry_module_id: null };
    const start = createModuleStart('new-module');
    expect(projectDraft(createDraft({ ...empty, modules: [start], entry_module_id: 'new-module' }))).toMatchObject({ entry_module_id: 'new-module', modules: [{ id: 'new-module', phases: [{ surfaces: [{ type: 'markdown', path: 'content.md' }] }] }] });
    const initial = state(empty);
    const created = draftReducer(initial, { type: 'module.create', module: start });
    const incomplete = draftReducer(created, { type: 'module.update', moduleKey: created.draft.modules[0]!.clientKey, patch: { id: '', title: '' } });
    expect(projectDraft(incomplete.draft).modules[0]).toMatchObject({ id: '', title: '' });
    expect(incomplete.validation).toBe('idle');
    expect(isDraftDirty(incomplete.draft, empty)).toBe(true);
  });
});
