import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
      getProposals: vi.fn().mockResolvedValue([]),
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
  it("reveals every representative real Inspector pointer on its stable owning entity", async () => {
    const capability = {
      chat: false,
      hint_level: "none" as const,
      share_selection: false,
      share_cell: false,
      share_output: false,
      create_profile_proposal: false,
      create_course_proposal: false,
      create_workspace_proposal: false,
    };
    const phase = (
      id: string,
      completion: AuthorManifest["modules"][number]["phases"][number]["completion"],
      surfaces: AuthorManifest["modules"][number]["phases"][number]["surfaces"],
    ) => ({
      id,
      title: id,
      kind: "read" as const,
      teacher_mode: "reading_companion" as const,
      completion,
      capabilities: capability,
      surfaces,
    });
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
        workspace_write_globs: ["docs/**"],
      },
      modules: [
        {
          id: "one",
          title: "One",
          description: "",
          phases: [
            phase("notebook", { type: "manual" }, [
              {
                id: "nb",
                type: "notebook",
                role: "primary",
                path: "n.ipynb",
                match: { cell_ids: ["cell"], cell_tags: ["tag"] },
              },
              {
                id: "term",
                type: "terminal",
                role: "exercise",
                label: "Run",
                argv: ["pnpm"],
                cwd: ".",
              },
            ]),
          ],
        },
        {
          id: "two",
          title: "Two",
          description: "",
          phases: [
            phase(
              "complete",
              {
                type: "artifact_exists",
                record_id: "receipt",
                path: "proof.txt",
              },
              [
                {
                  id: "two-path",
                  type: "markdown",
                  role: "primary",
                  path: "two.md",
                },
              ],
            ),
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
    await screen.findByLabelText("Course title");
    const cases: Array<[string, string, string]> = [
      ["/title", "Course title", ""],
      ["/policies/max_shared_chars", "Max shared characters", ""],
      ["/modules/1/title", "Module title", "Select module Two"],
      [
        "/modules/1/phases/0/teacher_mode",
        "Teacher mode",
        "Select phase complete",
      ],
      [
        "/modules/1/phases/0/completion/path",
        "Artifact path",
        "Select phase complete",
      ],
      [
        "/modules/0/phases/0/surfaces/0/match/cell_ids/0",
        "Cell ID 1",
        "Select surface nb",
      ],
      [
        "/modules/0/phases/0/surfaces/1/cwd",
        "Working directory",
        "Select surface term",
      ],
    ];
    for (const [path, label, selection] of cases) {
      const message = `Issue ${path}`;
      appMocks.validateCourse.mockRejectedValueOnce(
        Object.assign(new Error("invalid"), {
          details: { issues: [{ path, code: "schema_validation", message }] },
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Validate structure" }),
      );
      await screen.findByText(message);
      fireEvent.click(
        screen.getByRole("button", { name: "Focus first issue" }),
      );
      const control = await screen.findByLabelText(label);
      expect(control).toHaveAttribute("id", pointerToControlId(path));
      expect(control).toHaveAttribute(
        "aria-describedby",
        pointerToControlId(path, "issue"),
      );
      expect(control).toHaveFocus();
      if (selection)
        expect(screen.getByRole("button", { name: selection })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
    }
    const first = "/modules/0/phases/0/surfaces/0/path";
    const second = "/modules/1/phases/0/surfaces/0/path";
    appMocks.validateCourse.mockRejectedValueOnce(
      Object.assign(new Error("invalid"), {
        details: {
          issues: [
            { path: first, code: "missing_artifact", message: "First path." },
            { path: second, code: "missing_artifact", message: "Second path." },
          ],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Validate structure" }));
    await screen.findByText("Second path.");
    expect(
      document.getElementById(pointerToControlId(first, "issue")),
    ).not.toBe(document.getElementById(pointerToControlId(second, "issue")));
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    const firstControl = await screen.findByLabelText("Path");
    expect(firstControl).toHaveAttribute("id", pointerToControlId(first));
    expect(firstControl).toHaveFocus();
  });
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
  it("keeps an unknown-only real AuthorApp issue summary focusable", async () => {
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
              path: "/server-only",
              code: "schema_validation",
              message: "Server-only.",
            },
          ],
        },
      }),
    );
    render(<AuthorApp />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Validate structure" }),
    );
    await screen.findByText("Server-only.");
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    expect(
      screen.getByRole("alert", { name: "Validation issues" }),
    ).toHaveFocus();
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
  it("resolves an issue against an imported current tree rather than the initial draft", async () => {
    const initial: AuthorManifest = {
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
      modules: [
        {
          id: "one",
          title: "One",
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
                  id: "one",
                  type: "markdown",
                  role: "primary",
                  path: "one.md",
                },
              ],
            },
          ],
        },
      ],
    };
    const imported: AuthorManifest = {
      ...initial,
      modules: [
        ...initial.modules,
        {
          ...initial.modules[0]!,
          id: "two",
          title: "Two",
          phases: [
            {
              ...initial.modules[0]!.phases[0]!,
              surfaces: [
                {
                  id: "new",
                  type: "markdown",
                  role: "primary",
                  path: "new.md",
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
      manifest: initial,
      raw: "{}",
      etag: '"etag"',
    });
    const firstPath = "/modules/0/phases/0/surfaces/0/path";
    const secondPath = "/modules/1/phases/0/surfaces/0/path";
    appMocks.validateCourse
      .mockResolvedValueOnce({ manifest: imported, formatted_json: "{}\n" })
      .mockRejectedValueOnce(
        Object.assign(new Error("invalid"), {
          details: {
            issues: [
              {
                path: firstPath,
                code: "missing_artifact",
                message: "Original path.",
              },
              {
                path: secondPath,
                code: "missing_artifact",
                message: "Imported path.",
              },
            ],
          },
        }),
      );
    render(<AuthorApp />);
    fireEvent.change(await screen.findByLabelText("Import course file"), {
      target: { files: [new File([JSON.stringify(imported)], "import.json")] },
    });
    await screen.findByText(/Imported local draft is ready/i);
    fireEvent.click(screen.getByRole("button", { name: "Validate structure" }));
    await screen.findByText("Imported path.");
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    const control = await screen.findByLabelText("Path");
    expect(control).toHaveValue("one.md");
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("id", pointerToControlId(firstPath));
    expect(control).toHaveAttribute(
      "aria-describedby",
      pointerToControlId(firstPath, "issue"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select surface new" }));
    const second = await screen.findByLabelText("Path");
    expect(second).toHaveValue("new.md");
    expect(second).toHaveAttribute(
      "aria-describedby",
      pointerToControlId(secondPath, "issue"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select surface one" }));
    expect(await screen.findByLabelText("Path")).toHaveAttribute(
      "aria-describedby",
      pointerToControlId(firstPath, "issue"),
    );
  });
  it("resolves a post-CRUD pointer to the surviving Outline entity after nested indices change", async () => {
    const manifest: AuthorManifest = {
      schema_version: 1,
      id: "course",
      title: "Course",
      description: "",
      entry_module_id: "deleted-module",
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
          id: "deleted-module",
          title: "Deleted module",
          description: "",
          phases: [
            {
              id: "deleted-phase",
              title: "Deleted phase",
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
                  id: "deleted-surface",
                  type: "markdown",
                  role: "primary",
                  path: "deleted.md",
                },
              ],
            },
          ],
        },
      ],
    };
    appMocks.getCourse.mockReset();
    appMocks.validateCourse.mockReset();
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

    fireEvent.click(
      await screen.findByRole("button", { name: "Select module Deleted module" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Duplicate module Deleted module" }),
    );
    fireEvent.change(screen.getByLabelText("Module title"), {
      target: { value: "Target module" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Move module Target module up" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Move module Target module down" }),
    );
    const targetModuleKey = screen
      .getByRole("button", { name: "Select module Target module" })
      .getAttribute("data-outline-key");
    expect(targetModuleKey).toMatch(/^draft-/);
    fireEvent.click(screen.getByRole("button", { name: "Add module" }));
    fireEvent.change(screen.getByLabelText("New module ID"), {
      target: { value: "decoy-module" },
    });
    fireEvent.change(screen.getByLabelText("New module title"), {
      target: { value: "Decoy module" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create module" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Move module Decoy module up" }),
    );

    const targetModule = screen
      .getByRole("button", { name: "Select module Target module" })
      .closest("li");
    expect(targetModule).not.toBeNull();
    fireEvent.click(
      within(targetModule!).getByRole("button", {
        name: "Select phase Deleted phase",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Duplicate phase Deleted phase" }),
    );
    fireEvent.change(screen.getByLabelText("Phase title"), {
      target: { value: "Target phase" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Move phase Target phase up" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Move phase Target phase down" }),
    );
    const targetPhaseKey = within(targetModule!)
      .getByRole("button", { name: "Select phase Target phase" })
      .getAttribute("data-outline-key");
    expect(targetPhaseKey).toMatch(/^draft-/);
    fireEvent.click(
      screen.getByRole("button", { name: "Select module Target module" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add phase" }));
    fireEvent.change(screen.getByLabelText("Phase title"), {
      target: { value: "Decoy phase" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Move phase Decoy phase up" }),
    );

    const targetPhase = within(targetModule!)
      .getByRole("button", { name: "Select phase Target phase" })
      .closest("li");
    expect(targetPhase).not.toBeNull();
    fireEvent.click(
      within(targetPhase!).getByRole("button", { name: /^Select surface / }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Duplicate surface / }),
    );
    fireEvent.change(screen.getByLabelText("Surface ID"), {
      target: { value: "target-surface" },
    });
    fireEvent.change(screen.getByLabelText("Path"), {
      target: { value: "target.md" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Move surface target-surface up" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Move surface target-surface down" }),
    );
    const targetSurfaceKey = within(targetPhase!)
      .getByRole("button", { name: "Select surface target-surface" })
      .getAttribute("data-outline-key");
    expect(targetSurfaceKey).toMatch(/^draft-/);
    fireEvent.click(
      within(targetModule!).getByRole("button", {
        name: "Select phase Target phase",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add surface" }));
    fireEvent.change(screen.getByLabelText("Surface ID"), {
      target: { value: "decoy-surface" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Move surface decoy-surface up" }),
    );

    fireEvent.click(
      within(targetPhase!).getByRole("button", {
        name: /^Select surface deleted-surface/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /^Delete surface deleted-surface/ }),
    );
    fireEvent.click(
      within(targetModule!).getByRole("button", {
        name: "Select phase Deleted phase",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete phase Deleted phase" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select module Deleted module" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete module Deleted module" }),
    );

    expect(
      screen.queryByRole("button", { name: "Select module Deleted module" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Select phase Deleted phase" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Select surface deleted-surface/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("deleted.md")).not.toBeInTheDocument();

    const path = "/modules/1/phases/1/surfaces/1/path";
    appMocks.validateCourse.mockRejectedValueOnce(
      Object.assign(new Error("invalid"), {
        details: {
          issues: [
            {
              path,
              code: "missing_artifact",
              message: "Target path is missing.",
            },
          ],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Validate structure" }));
    await screen.findByText("Target path is missing.");
    expect(appMocks.validateCourse).toHaveBeenCalledWith(
      expect.objectContaining({
        modules: [
          expect.anything(),
          expect.objectContaining({
            title: "Target module",
            phases: [
              expect.anything(),
              expect.objectContaining({
                title: "Target phase",
                surfaces: [
                  expect.anything(),
                  expect.objectContaining({
                    id: "target-surface",
                    path: "target.md",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      "structural",
      expect.any(AbortSignal),
    );

    expect(screen.queryByLabelText("Path")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    const control = await screen.findByLabelText("Path");
    const selectedSurface = screen.getByRole("button", {
      name: "Select surface target-surface",
    });
    expect(selectedSurface).toHaveAttribute("aria-pressed", "true");
    expect(selectedSurface).toHaveAttribute(
      "data-outline-key",
      targetSurfaceKey!,
    );
    expect(
      screen.getByRole("button", { name: "Select module Target module" }),
    ).toHaveAttribute("data-outline-key", targetModuleKey!);
    expect(
      screen.getByRole("button", { name: "Select phase Target phase" }),
    ).toHaveAttribute("data-outline-key", targetPhaseKey!);
    expect(control).toHaveValue("target.md");
    expect(control).toHaveAttribute("id", pointerToControlId(path));
    expect(control).toHaveAttribute(
      "aria-describedby",
      pointerToControlId(path, "issue"),
    );
    expect(control).toHaveFocus();
  });

  it("routes collection issues to the selected repair control and begins each repair", async () => {
    const manifest: AuthorManifest = {
      schema_version: 1,
      id: "course",
      title: "Collections",
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
              id: "terminal-phase",
              title: "Terminal phase",
              kind: "lab",
              teacher_mode: "debugging_coach",
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
                  id: "terminal",
                  type: "terminal",
                  role: "exercise",
                  label: "Run",
                  argv: [],
                  cwd: ".",
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
    await screen.findByLabelText("Course title");

    const phasePath = "/modules/0/phases";
    appMocks.validateCourse.mockRejectedValueOnce(
      Object.assign(new Error("invalid"), {
        details: {
          issues: [
            { path: phasePath, code: "min_items", message: "Add a phase." },
          ],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Validate structure" }));
    await screen.findByText("Add a phase.");
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    const addPhase = await screen.findByRole("button", { name: "Add phase" });
    expect(addPhase).toHaveAttribute("id", pointerToControlId(phasePath));
    expect(addPhase).toHaveAttribute(
      "aria-describedby",
      pointerToControlId(phasePath, "issue"),
    );
    expect(addPhase).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Select module Module" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(addPhase);
    expect(
      screen.getByRole("button", { name: "Select phase New phase" }),
    ).toBeInTheDocument();

    const surfacePath = "/modules/0/phases/0/surfaces";
    appMocks.validateCourse.mockRejectedValueOnce(
      Object.assign(new Error("invalid"), {
        details: {
          issues: [
            {
              path: surfacePath,
              code: "min_items",
              message: "Add a surface.",
            },
          ],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Validate structure" }));
    await screen.findByText("Add a surface.");
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    const addSurface = await screen.findByRole("button", {
      name: "Add surface",
    });
    expect(addSurface).toHaveAttribute("id", pointerToControlId(surfacePath));
    expect(addSurface).toHaveAttribute(
      "aria-describedby",
      pointerToControlId(surfacePath, "issue"),
    );
    expect(addSurface).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Select phase Terminal phase" }),
    ).toHaveAttribute("aria-pressed", "true");
    const surfacesBeforeRepair = screen.getAllByRole("button", {
      name: "Select surface surface",
    }).length;
    fireEvent.click(addSurface);
    expect(
      screen.getAllByRole("button", { name: "Select surface surface" }),
    ).toHaveLength(surfacesBeforeRepair + 1);

    const argvPath = "/modules/0/phases/0/surfaces/0/argv";
    appMocks.validateCourse.mockRejectedValueOnce(
      Object.assign(new Error("invalid"), {
        details: {
          issues: [
            {
              path: argvPath,
              code: "min_items",
              message: "Add an argument.",
            },
          ],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Validate structure" }));
    await screen.findByText("Add an argument.");
    fireEvent.click(screen.getByRole("button", { name: "Focus first issue" }));
    const argument = await screen.findByLabelText("Argument 1");
    expect(argument).toHaveAttribute("id", pointerToControlId(argvPath));
    expect(argument).toHaveAttribute(
      "aria-describedby",
      pointerToControlId(argvPath, "issue"),
    );
    expect(argument).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Select surface terminal" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(argument, { target: { value: "node" } });
    expect(screen.getByLabelText("Argument 1")).toHaveValue("node");
  });
});
