import { useEffect } from 'react';

export interface ValidationIssue { path: string; code: string; message: string; }

function encoded(pointer: string): string { return pointer.split('/').filter(Boolean).map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('-') || 'form'; }
export function pointerToControlId(pointer: string, suffix = 'control'): string { return `author-${suffix}-${encoded(pointer)}`; }

function controlFor(pointer: string): HTMLElement | null {
  const direct = document.getElementById(pointerToControlId(pointer));
  if (direct !== null) return direct;
  const final = pointer.split('/').at(-1);
  const label = final === 'path' ? 'Path' : final === 'cwd' ? 'Working directory' : final === 'url' ? 'External URL' : undefined;
  if (label === undefined) return null;
  const nested = Array.from(document.querySelectorAll('label')).find((candidate) => candidate.textContent?.trim().startsWith(label))?.querySelector<HTMLElement>('input, select, textarea');
  if (nested !== null && nested !== undefined) nested.id = pointerToControlId(pointer);
  return nested ?? null;
}

/** Adds accessible issue references only to controls registered with their JSON Pointer. */
export function ValidationSummary({ issues }: { issues: readonly ValidationIssue[] }) {
  useEffect(() => {
    const touched: HTMLElement[] = [];
    for (const issue of issues) {
      const control = controlFor(issue.path);
      if (control !== null) {
        const description = pointerToControlId(issue.path, 'issue');
        control.setAttribute('aria-describedby', description);
        touched.push(control);
      }
    }
    return () => touched.forEach((control) => control.removeAttribute('aria-describedby'));
  }, [issues]);
  if (issues.length === 0) return null;
  const first = issues[0]!;
  const focusFirst = () => controlFor(first.path)?.focus();
  return <section aria-label="Validation issues" role="alert">
    <h2>Validation issues</h2>
    <button type="button" onClick={focusFirst}>Focus first issue</button>
    <ul>{issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`} id={pointerToControlId(issue.path, 'issue')}>
      <strong>{issue.path || 'Course'}:</strong> {issue.message}
    </li>)}</ul>
  </section>;
}
