import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useReducer } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthorManifest } from '@courseweave/ui';
import { LearnerPhasePreview } from '@courseweave/ui';
import { createDraft, draftReducer, projectDraft, type AuthorDocumentState } from '../src/draft';
import { Inspector } from '../src/inspector';

const manifest: AuthorManifest = {
  schema_version: 1, id: 'course', title: 'Course', description: 'Description', entry_module_id: 'module',
  policies: { content_sharing: 'explicit_only', durable_mutation: 'proposal_or_direct_student_action', terminal_execution: 'student_only', conversation_memory: 'session_only', max_shared_chars: 500, workspace_write_globs: ['labs/**'] },
  modules: [{ id: 'module', title: 'Module', description: 'Module description', phases: [{ id: 'phase', title: 'Phase', kind: 'orient', teacher_mode: 'orienter', completion: { type: 'manual' }, capabilities: { chat: true, hint_level: 'full', share_selection: true, share_cell: true, share_output: true, create_profile_proposal: true, create_course_proposal: true, create_workspace_proposal: true }, surfaces: [{ id: 'surface', type: 'notebook', role: 'primary', path: 'lesson.ipynb', match: { cell_ids: ['cell-1'], cell_tags: ['intro'] } }] }] }],
};

function Harness({ selection }: { selection: AuthorDocumentState['selection'] }) {
  const [state, dispatch] = useReducer(draftReducer, { draft: createDraft(manifest), selection, validation: 'valid', saved: manifest } satisfies AuthorDocumentState);
  return <><Inspector state={state} dispatch={dispatch} /><output>{JSON.stringify(projectDraft(state.draft))}</output></>;
}
function projected(): AuthorManifest { return JSON.parse(document.querySelector('output')?.textContent ?? '') as AuthorManifest; }

describe('Inspector', () => {
  it('projects every learner phase kind as explicitly inert draft-only preview', () => {
    for (const kind of ['orient', 'read', 'watch', 'predict', 'experiment', 'lab', 'review', 'audit', 'ship'] as const) {
      const phase = { ...manifest.modules[0]!.phases[0]!, kind };
      const view = render(<LearnerPhasePreview phase={phase} />);
      expect(screen.getByRole('status')).toHaveTextContent('Preview only');
      expect(screen.getByRole('heading', { name: new RegExp(kind === 'orient' ? 'Orientation' : kind, 'i') })).toBeInTheDocument();
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      view.unmount();
    }
  });

  it('renders every course, policy, module, phase, capability, and completion control using native labelled fields', () => {
    const view = render(<Harness selection={{ type: 'course' }} />);
    for (const label of ['Course ID', 'Course title', 'Course description', 'Entry module', 'Content sharing', 'Durable mutation', 'Terminal execution', 'Conversation memory', 'Max shared characters', 'Workspace write glob 1']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    view.unmount();
    render(<Harness selection={{ type: 'module', moduleKey: createDraft(manifest).modules[0]!.clientKey }} />);
    for (const label of ['Module ID', 'Module title', 'Module description']) expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it('renders module metadata, all enum options, capabilities, and all completion variants', () => {
    const draft = createDraft(manifest); const moduleKey = draft.modules[0]!.clientKey; const phaseKey = draft.modules[0]!.phases[0]!.clientKey;
    function StableHarness() { const [state, dispatch] = useReducer(draftReducer, { draft, selection: { type: 'phase', moduleKey, phaseKey }, validation: 'valid', saved: manifest } satisfies AuthorDocumentState); return <Inspector state={state} dispatch={dispatch} />; }
    render(<StableHarness />);
    for (const label of ['Phase ID', 'Phase title', 'Phase kind', 'Teacher mode', 'Chat', 'Hint level', 'Share selection', 'Share cell', 'Share output', 'Create profile proposal', 'Create course proposal', 'Create workspace proposal', 'Completion type']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByLabelText('Phase kind')).toHaveTextContent('orientreadwatchpredictexperimentlabreviewauditship');
    expect(screen.getByLabelText('Teacher mode')).toHaveTextContent('orienterreading_companionsocratic_guidedebugging_coachreviewerobservercurriculum_designer');
    fireEvent.change(screen.getByLabelText('Completion type'), { target: { value: 'prediction_recorded' } });
    expect(screen.getByLabelText('Completion record ID')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Completion type'), { target: { value: 'artifact_exists' } });
    expect(screen.getByLabelText('Completion record ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Artifact path')).toBeInTheDocument();
  });

  it('renders each surface discriminator and strips stale forbidden fields when changing variants', () => {
    const draft = createDraft(manifest); const moduleKey = draft.modules[0]!.clientKey; const phaseKey = draft.modules[0]!.phases[0]!.clientKey; const surfaceKey = draft.modules[0]!.phases[0]!.surfaces[0]!.clientKey;
    function StableHarness() { const [state, dispatch] = useReducer(draftReducer, { draft, selection: { type: 'surface', moduleKey, phaseKey, surfaceKey }, validation: 'valid', saved: manifest } satisfies AuthorDocumentState); return <><Inspector state={state} dispatch={dispatch} /><output>{JSON.stringify(projectDraft(state.draft))}</output></>; }
    render(<StableHarness />);
    for (const label of ['Surface ID', 'Surface type', 'Surface role', 'Path', 'Cell ID 1', 'Cell tag 1']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    for (const type of ['html', 'markdown', 'source', 'notebook', 'video', 'terminal', 'external']) {
      fireEvent.change(screen.getByLabelText('Surface type'), { target: { value: type } });
      expect(screen.getByLabelText('Surface type')).toHaveValue(type);
    }
    expect(screen.getByLabelText('External URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Path')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cell ID 1')).not.toBeInTheDocument();
    expect(projected().modules[0]!.phases[0]!.surfaces[0]).toEqual({ id: 'surface', type: 'external', role: 'primary', url: 'https://example.test/' });
    fireEvent.change(screen.getByLabelText('Surface type'), { target: { value: 'terminal' } });
    for (const label of ['Terminal label', 'Argument 1', 'Working directory']) expect(screen.getByLabelText(label)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Surface type'), { target: { value: 'video' } });
    expect(screen.getByLabelText('Video location')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Video location'), { target: { value: 'remote' } });
    expect(screen.getByLabelText('Video URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Path')).not.toBeInTheDocument();
    expect(projected().modules[0]!.phases[0]!.surfaces[0]).toEqual({ id: 'surface', type: 'video', role: 'primary', url: 'https://example.test/video.mp4' });
  });

  it('adds and removes list values and removes empty optional video ranges from the projection', () => {
    const courseView = render(<Harness selection={{ type: 'course' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add workspace write glob' }));
    fireEvent.change(screen.getByLabelText('Workspace write glob 2'), { target: { value: 'notes/**' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove workspace write glob 1' }));
    expect(projected().policies.workspace_write_globs).toEqual(['notes/**']);
    courseView.unmount();

    const view = render(<Harness selection={{ type: 'surface', moduleKey: 'draft-1', phaseKey: 'draft-2', surfaceKey: 'draft-3' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove cell tag 1' }));
    expect(projected().modules[0]!.phases[0]!.surfaces[0]).toMatchObject({ match: { cell_ids: ['cell-1'] } });
    fireEvent.change(screen.getByLabelText('Surface type'), { target: { value: 'video' } });
    fireEvent.change(screen.getByLabelText('Start seconds'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('End seconds'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Start seconds'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('End seconds'), { target: { value: '' } });
    expect(projected().modules[0]!.phases[0]!.surfaces[0]).toEqual({ id: 'surface', type: 'video', role: 'primary', path: 'video.mp4' });
    view.unmount();
  });
});

afterEach(cleanup);
