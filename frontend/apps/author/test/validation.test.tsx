import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useReducer } from 'react';
import type { AuthorManifest } from '@courseweave/ui';
import { createDraft, draftReducer, type AuthorDocumentState } from '../src/draft';
import { Inspector } from '../src/inspector';
import { ValidationSummary, pointerToControlId, type ValidationIssue } from '../src/validation';

afterEach(cleanup);

describe('Author validation presentation', () => {
  it('maps a surface pointer to its labelled control, summarizes issues, and focuses the first issue', () => {
    const issues: ValidationIssue[] = [
      { path: '/modules/0/phases/0/surfaces/0/path', code: 'missing_artifact', message: 'Choose a local artifact.' },
      { path: '/unknown/server/path', code: 'schema_validation', message: 'Server-only rule.' },
    ];
    render(<><label htmlFor={pointerToControlId(issues[0]!.path)}>Path</label><input id={pointerToControlId(issues[0]!.path)} /><ValidationSummary issues={issues} /></>);
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a local artifact.');
    expect(screen.getByText('Server-only rule.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Focus first issue' }));
    expect(screen.getByLabelText('Path')).toHaveFocus();
    expect(screen.getByLabelText('Path')).toHaveAttribute('aria-describedby', pointerToControlId(issues[0]!.path, 'issue'));
  });

  it('focuses the first mapped real Inspector field when an earlier server pointer is unknown', () => {
    const manifest: AuthorManifest = { schema_version: 1, id: 'course', title: 'Course', description: '', entry_module_id: 'module', policies: { content_sharing: 'explicit_only', durable_mutation: 'proposal_or_direct_student_action', terminal_execution: 'student_only', conversation_memory: 'session_only', max_shared_chars: 1, workspace_write_globs: [] }, modules: [{ id: 'module', title: 'Module', description: '', phases: [{ id: 'phase', title: 'Phase', kind: 'read', teacher_mode: 'reading_companion', completion: { type: 'manual' }, capabilities: { chat: false, hint_level: 'none', share_selection: false, share_cell: false, share_output: false, create_profile_proposal: false, create_course_proposal: false, create_workspace_proposal: false }, surfaces: [{ id: 'surface', type: 'markdown', role: 'primary', path: 'lesson.md' }] }] }] };
    const draft = createDraft(manifest); const surface = draft.modules[0]!.phases[0]!.surfaces[0]!;
    function Harness() { const [state, dispatch] = useReducer(draftReducer, { draft, saved: manifest, validation: 'invalid', selection: { type: 'surface', moduleKey: 'draft-1', phaseKey: 'draft-2', surfaceKey: surface.clientKey } } satisfies AuthorDocumentState); return <><Inspector state={state} dispatch={dispatch} /><ValidationSummary issues={[{ path: '/unknown', code: 'schema_validation', message: 'Unknown.' }, { path: '/modules/0/phases/0/surfaces/0/path', code: 'missing_artifact', message: 'Path missing.' }]} /></>; }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Focus first issue' }));
    expect(screen.getByLabelText('Path')).toHaveFocus();
    expect(screen.getByLabelText('Path')).toHaveAttribute('id', pointerToControlId('/modules/0/phases/0/surfaces/0/path'));
  });
});
