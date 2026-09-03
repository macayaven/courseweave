import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import type { AuthorManifest } from "@courseweave/ui";
import {
  createDraft,
  draftReducer,
  type AuthorDocumentState,
} from "../src/draft";
import { Inspector } from "../src/inspector";

const appMocks = vi.hoisted(() => ({
  getCourse: vi.fn(),
  validateCourse: vi.fn(),
  runtime: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("../src/api", async () => {
  class AuthorApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      readonly details: Record<string, unknown>,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AuthorApiError,
    createAuthorClient: () => ({
      getCourse: appMocks.getCourse,
      validateCourse: appMocks.validateCourse,
      putCourse: vi.fn(),
      getProposals: vi.fn(),
      postGuide: vi.fn(),
      createProposal: vi.fn(),
      editProposal: vi.fn(),
      acceptProposal: vi.fn(),
      rejectProposal: vi.fn(),
    }),
  };
});
vi.mock("../src/runtime", () => ({ useAuthorRuntime: appMocks.runtime }));
import { AuthorApp } from "../src/app";
import {
  ValidationSummary,
  pointerToControlId,
  type ValidationIssue,
} from "../src/validation";

afterEach(cleanup);

describe("Author validation presentation", () => {
  it("registers deterministic JSON Pointer IDs on real course and policy controls", async () => {
    const manifest: AuthorManifest = {
      schema_version: 1,
      id: "course",
      title: "Course",
      description: "",
      entry_module_id: "module",
      policies: {
        content_sharing: "explicit_only",
        durable_mutation: "proposal_or_direct_student_action",
        terminal_execution: "student_only",
        conversation_memory: "session_only",
        max_shared_chars: 1,
        workspace_write_globs: ["docs/**"],
      },
      modules: [
        {
          id: "module",
          title: "Module",
          description: "",
          phases: [
            {
              id: "phase",
              title: "Phase",
              kind: "read",
              teacher_mode: "reading_companion",
              completion: { type: "manual" },
              capabilities: {
                chat: false,
                hint_level: "none",
                share_selection: false,
                share_cell: false,
                share_output: false,
                create_profile_proposal: false,
                create_course_proposal: false,
                create_workspace_proposal: false,
              },
              surfaces: [
                {
                  id: "surface",
                  type: "markdown",
                  role: "primary",
                  path: "lesson.md",
                },
              ],
            },
          ],
        },
      ],
    };
    appMocks.runtime.mockReturnValue({
      status: "ready",
      runtime: {
        serviceOrigin: "https://course.test",
        capabilityToken: "token",
        sourceId: "author",
      },
      retry: appMocks.retry,
    });
    appMocks.getCourse.mockResolvedValue({
      manifest,
      raw: "{}",
      etag: '"etag"',
    });
    render(<AuthorApp />);
    expect(await screen.findByLabelText("Course ID")).toHaveAttribute(
      "id",
      pointerToControlId("/id"),
    );
    expect(screen.getByLabelText("Course title")).toHaveAttribute(
      "id",
      pointerToControlId("/title"),
    );
    expect(screen.getByLabelText("Entry module")).toHaveAttribute(
      "id",
      pointerToControlId("/entry_module_id"),
    );
    expect(screen.getByLabelText("Content sharing")).toHaveAttribute(
      "id",
      pointerToControlId("/policies/content_sharing"),
    );
    expect(screen.getByLabelText("Workspace write glob 1")).toHaveAttribute(
      "id",
      pointerToControlId("/policies/workspace_write_globs/0"),
    );
  });
  it("uses a later mapped course pointer after an unknown issue", async () => {
    const manifest: AuthorManifest = {
      schema_version: 1,
      id: "course",
      title: "Course",
      description: "",
      entry_module_id: null,
      policies: {
        content_sharing: "explicit_only",
        durable_mutation: "proposal_or_direct_student_action",
        terminal_execution: "student_only",
        conversation_memory: "session_only",
        max_shared_chars: 1,
        workspace_write_globs: [],
      },
      modules: [],
    };
    appMocks.runtime.mockReturnValue({
      status: "ready",
      runtime: {
        serviceOrigin: "https://course.test",
        capabilityToken: "token",
        sourceId: "author",
      },
      retry: appMocks.retry,
    });
    appMocks.getCourse.mockResolvedValue({
      manifest,
      raw: "{}",
      etag: '"etag"',
    });
    appMocks.validateCourse.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        details: {
          issues: [
            {
              path: "/not-a-control",
              code: "schema_validation",
              message: "Unknown.",
            },
            {
              path: "/title",
              code: "schema_validation",
              message: "Title required.",
            },
          ],
        },
      }),
    );
    render(<AuthorApp />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Validate structure" }),
    );
    await screen.findByText("Title required.");
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    expect(screen.getByLabelText("Course title")).toHaveFocus();
  });
  it("maps a surface pointer to its labelled control, summarizes issues, and focuses the first issue", () => {
    const issues: ValidationIssue[] = [
      {
        path: "/modules/0/phases/0/surfaces/0/path",
        code: "missing_artifact",
        message: "Choose a local artifact.",
      },
      {
        path: "/unknown/server/path",
        code: "schema_validation",
        message: "Server-only rule.",
      },
    ];
    render(
      <>
        <label htmlFor={pointerToControlId(issues[0]!.path)}>Path</label>
        <input id={pointerToControlId(issues[0]!.path)} />
        <ValidationSummary issues={issues} />
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose a local artifact.",
    );
    expect(screen.getByText("Server-only rule.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    expect(screen.getByLabelText("Path")).toHaveFocus();
    expect(screen.getByLabelText("Path")).toHaveAttribute(
      "aria-describedby",
      pointerToControlId(issues[0]!.path, "issue"),
    );
  });

  it("focuses the first mapped real Inspector field when an earlier server pointer is unknown", () => {
    const manifest: AuthorManifest = {
      schema_version: 1,
      id: "course",
      title: "Course",
      description: "",
      entry_module_id: "module",
      policies: {
        content_sharing: "explicit_only",
        durable_mutation: "proposal_or_direct_student_action",
        terminal_execution: "student_only",
        conversation_memory: "session_only",
        max_shared_chars: 1,
        workspace_write_globs: [],
      },
      modules: [
        {
          id: "module",
          title: "Module",
          description: "",
          phases: [
            {
              id: "phase",
              title: "Phase",
              kind: "read",
              teacher_mode: "reading_companion",
              completion: { type: "manual" },
              capabilities: {
                chat: false,
                hint_level: "none",
                share_selection: false,
                share_cell: false,
                share_output: false,
                create_profile_proposal: false,
                create_course_proposal: false,
                create_workspace_proposal: false,
              },
              surfaces: [
                {
                  id: "surface",
                  type: "markdown",
                  role: "primary",
                  path: "lesson.md",
                },
              ],
            },
          ],
        },
      ],
    };
    const draft = createDraft(manifest);
    const surface = draft.modules[0]!.phases[0]!.surfaces[0]!;
    function Harness() {
      const [state, dispatch] = useReducer(draftReducer, {
        draft,
        saved: manifest,
        validation: "invalid",
        selection: {
          type: "surface",
          moduleKey: "draft-1",
          phaseKey: "draft-2",
          surfaceKey: surface.clientKey,
        },
      } satisfies AuthorDocumentState);
      return (
        <>
          <Inspector state={state} dispatch={dispatch} />
          <ValidationSummary
            issues={[
              {
                path: "/unknown",
                code: "schema_validation",
                message: "Unknown.",
              },
              {
                path: "/modules/0/phases/0/surfaces/0/path",
                code: "missing_artifact",
                message: "Path missing.",
              },
            ]}
          />
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    expect(screen.getByLabelText("Path")).toHaveFocus();
    expect(screen.getByLabelText("Path")).toHaveAttribute(
      "id",
      pointerToControlId("/modules/0/phases/0/surfaces/0/path"),
    );
  });

  it("reveals and focuses the actual non-selected second-module Path field with its deterministic pointer association", async () => {
    const manifest: AuthorManifest = {
      schema_version: 1,
      id: "course",
      title: "Course",
      description: "",
      entry_module_id: "one",
      policies: {
        content_sharing: "explicit_only",
        durable_mutation: "proposal_or_direct_student_action",
        terminal_execution: "student_only",
        conversation_memory: "session_only",
        max_shared_chars: 1,
        workspace_write_globs: [],
      },
      modules: ["one", "two"].map((id) => ({
        id,
        title: id,
        description: "",
        phases: [
          {
            id: "phase",
            title: "Phase",
            kind: "read",
            teacher_mode: "reading_companion",
            completion: { type: "manual" as const },
            capabilities: {
              chat: false,
              hint_level: "none" as const,
              share_selection: false,
              share_cell: false,
              share_output: false,
              create_profile_proposal: false,
              create_course_proposal: false,
              create_workspace_proposal: false,
            },
            surfaces: [
              {
                id: "surface",
                type: "markdown" as const,
                role: "primary" as const,
                path: `${id}.md`,
              },
            ],
          },
        ],
      })),
    };
    appMocks.runtime.mockReturnValue({
      status: "ready",
      runtime: {
        serviceOrigin: "https://course.test",
        capabilityToken: "token",
        sourceId: "author",
      },
      retry: appMocks.retry,
    });
    appMocks.getCourse.mockResolvedValue({
      manifest,
      raw: "{}",
      etag: '"etag"',
    });
    appMocks.validateCourse.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        status: 422,
        code: "validation_error",
        details: {
          issues: [
            {
              path: "/unknown",
              code: "schema_validation",
              message: "Unknown.",
            },
            {
              path: "/modules/1/phases/0/surfaces/0/path",
              code: "missing_artifact",
              message: "Second path missing.",
            },
          ],
        },
      }),
    );
    render(<AuthorApp />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Validate structure" }),
    );
    await screen.findByText("Second path missing.");
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    const path = await screen.findByLabelText("Path");
    expect(path).toHaveValue("two.md");
    expect(path).toHaveFocus();
    expect(path).toHaveAttribute(
      "id",
      pointerToControlId("/modules/1/phases/0/surfaces/0/path"),
    );
    expect(path).toHaveAttribute(
      "aria-describedby",
      pointerToControlId("/modules/1/phases/0/surfaces/0/path", "issue"),
    );
  });
});
