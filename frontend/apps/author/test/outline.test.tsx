import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthorManifest } from "@courseweave/ui";
import {
  createDraft,
  draftReducer,
  projectDraft,
  type AuthorDocumentState,
} from "../src/draft";
import { Inspector } from "../src/inspector";
import { Outline } from "../src/outline";

const manifest: AuthorManifest = {
  runtime: { type: "jupyter", kernel: { type: "python_uv_project" } },
  schema_version: 2,
  id: "course",
  title: "Course",
  description: "",
  entry_module_id: "first",
  policies: {
    allowed_share_kinds: ["selection", "cell", "output"],
    allowed_proposal_types: ["profile", "course", "workspace"],
    content_sharing: "explicit_only",
    durable_mutation: "proposal_or_direct_student_action",
    terminal_execution: "student_only",
    conversation_memory: "session_only",
    max_shared_chars: 100,
    workspace_write_globs: [],
  },
  modules: [
    {
      id: "first",
      title: "First",
      description: "",
      phases: [
        {
          id: "read",
          title: "Read",
          progress: "required" as const,
          experience: { type: "builtin" as const, id: "reading" as const },
          teacher: {
            access: { mode: "available" as const, requires: [] },
            guidance: {
              style: { type: "builtin" as const, id: "explanatory" as const },
              hint_level: "none" as const,
            },
            sharing: { allow: [] },
            proposals: { allow: [] },
          },
          completion: { requirements: [] },
          surfaces: [
            {
              id: "page",
              type: "markdown",
              purpose: "primary" as const,
              label: "Content",
              path: "one.md",
            },
          ],
        },
      ],
    },
    {
      id: "second",
      title: "Second",
      description: "",
      phases: [
        {
          id: "watch",
          title: "Watch",
          progress: "required" as const,
          experience: { type: "builtin" as const, id: "media" as const },
          teacher: {
            access: { mode: "observer_only" as const, requires: [] },
            guidance: {
              style: { type: "builtin" as const, id: "explanatory" as const },
              hint_level: "none" as const,
            },
            sharing: { allow: [] },
            proposals: { allow: [] },
          },
          completion: { requirements: [] },
          surfaces: [
            {
              id: "video",
              type: "video",
              purpose: "primary" as const,
              label: "Content",
              src: "two.mp4",
            },
          ],
        },
      ],
    },
  ],
};

function Harness({ course = manifest }: { course?: AuthorManifest }) {
  const [state, dispatch] = useReducer(draftReducer, {
    draft: createDraft(course),
    selection: { type: "course" },
    validation: "valid",
    saved: course,
  } satisfies AuthorDocumentState);
  return (
    <>
      <Outline state={state} dispatch={dispatch} />
      <output>
        {state.draft.modules.map((module) => module.id).join(",")}
      </output>
    </>
  );
}

function EditorHarness() {
  const [state, dispatch] = useReducer(draftReducer, {
    draft: createDraft(manifest),
    selection: { type: "course" },
    validation: "valid",
    saved: manifest,
  } satisfies AuthorDocumentState);
  return (
    <>
      <Outline state={state} dispatch={dispatch} />
      <Inspector state={state} dispatch={dispatch} />
      <output>{JSON.stringify(projectDraft(state.draft))}</output>
    </>
  );
}

describe("Outline", () => {
  it("opens a valid-start wizard that creates one module, phase, and surface locally", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add module" }));
    expect(
      screen.getByRole("dialog", { name: "New module" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("New module ID"), {
      target: { value: "third" },
    });
    fireEvent.change(screen.getByLabelText("New module title"), {
      target: { value: "Third" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create module" }));
    expect(screen.getByText("first,second,third")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select module Third" }),
    ).toBeInTheDocument();
  });

  it("is keyboard navigable with labelled create, duplicate, delete, and move controls plus announcements and predictable focus", () => {
    render(<Harness />);
    const first = screen.getByRole("button", { name: "Select module First" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(
      screen.getByRole("button", { name: "Select module Second" }),
    ).toHaveFocus();
    const second = screen.getByRole("button", { name: "Select module Second" });
    fireEvent.click(second);
    expect(
      screen.getByRole("button", { name: "Add module" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Duplicate module Second" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Move module Second up" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Move module Second up" }),
    );
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      "Moved module Second up.",
    );
    expect(
      screen.getByRole("button", { name: "Select module Second" }),
    ).toHaveFocus();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete module Second" }),
    );
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      "Deleted module Second.",
    );
    expect(
      screen.getByRole("button", { name: "Select module First" }),
    ).toHaveFocus();
    expect(screen.getByText("first")).toBeInTheDocument();
  });

  it("keeps phase and surface creation reachable and restores focus to their parent after final deletion", () => {
    const single: AuthorManifest = {
      ...manifest,
      modules: [manifest.modules[0]!],
    };
    render(<Harness course={single} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Select module First" }),
    );
    expect(
      screen.getByRole("button", { name: "Add phase" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select phase Read" }));
    expect(
      screen.getByRole("button", { name: "Add surface" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Select surface page" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Delete surface page" }),
    );
    expect(
      screen.getByRole("button", { name: "Select phase Read" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Add surface" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete phase Read" }));
    expect(
      screen.getByRole("button", { name: "Select module First" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Add phase" }),
    ).toBeInTheDocument();
  });

  it("returns from an unsaved entity edit to the Course inspector through an accessible local selection", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<EditorHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Select phase Read" }));
    fireEvent.change(screen.getByLabelText("Phase title"), {
      target: { value: "Edited read" },
    });
    const course = screen.getByRole("button", { name: "Select course Course" });
    course.focus();
    expect(course).toHaveFocus();
    expect(course).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(course);
    expect(course).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("Course title"), {
      target: { value: "Edited course" },
    });
    fireEvent.change(screen.getByLabelText("Max shared characters"), {
      target: { value: "200" },
    });
    const draft = JSON.parse(
      document.querySelector("output")?.textContent ?? "",
    ) as AuthorManifest;
    expect(draft.title).toBe("Edited course");
    expect(draft.policies.max_shared_chars).toBe(200);
    expect(draft.modules[0]!.phases[0]!.title).toBe("Edited read");
    expect(fetch).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
