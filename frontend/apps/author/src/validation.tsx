import { useEffect, useRef } from "react";

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

function encoded(pointer: string): string {
  return (
    pointer
      .split("/")
      .filter(Boolean)
      .map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1"))
      .join("-") || "form"
  );
}
export function pointerToControlId(
  pointer: string,
  suffix = "control",
): string {
  return `author-${suffix}-${encoded(pointer)}`;
}

function controlFor(pointer: string): HTMLElement | null {
  return document.getElementById(pointerToControlId(pointer));
}

/** Adds accessible issue references only to controls registered with their JSON Pointer. */
export function ValidationSummary({
  issues,
  onFocusIssues,
}: {
  issues: readonly ValidationIssue[];
  onFocusIssues?(issues: readonly ValidationIssue[]): boolean;
}) {
  const summary = useRef<HTMLElement>(null);
  useEffect(() => {
    const touched: HTMLElement[] = [];
    for (const issue of issues) {
      const control = controlFor(issue.path);
      if (control !== null) {
        const description = pointerToControlId(issue.path, "issue");
        control.setAttribute("aria-describedby", description);
        touched.push(control);
      }
    }
    return () =>
      touched.forEach((control) => control.removeAttribute("aria-describedby"));
  }, [issues]);
  if (issues.length === 0) return null;
  const focusFirst = () => {
    if (onFocusIssues?.(issues)) return;
    const first = issues.find((issue) => controlFor(issue.path) !== null);
    const control = first === undefined ? null : controlFor(first.path);
    if (control === null) summary.current?.focus();
    else control.focus();
  };
  return (
    <section
      ref={summary}
      tabIndex={-1}
      aria-label="Validation issues"
      role="alert"
    >
      <h2>Validation issues</h2>
      <button type="button" onClick={focusFirst}>
        Focus first issue
      </button>
      <ul>
        {issues.map((issue, index) => (
          <li
            key={`${issue.path}:${issue.code}:${index}`}
            id={pointerToControlId(issue.path, "issue")}
          >
            <strong>{issue.path || "Course"}:</strong> {issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
