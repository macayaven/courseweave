import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
