import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthorManifest } from "@courseweave/ui";
import { LearnerPhasePreview } from "@courseweave/ui";
import {
  createDraft,
  draftReducer,
  projectDraft,
  type AuthorDocumentState,
} from "../src/draft";
import { Inspector } from "../src/inspector";

const manifest: AuthorManifest = {
  runtime: { type: "jupyter", kernel: { type: "python_uv_project" } },
  schema_version: 2,
  id: "course",
  title: "Course",
  description: "Description",
  entry_module_id: "module",
  policies: {
    allowed_share_kinds: ["selection", "cell", "output"],
    allowed_proposal_types: ["profile", "course", "workspace"],
    content_sharing: "explicit_only",
    durable_mutation: "proposal_or_direct_student_action",
    terminal_execution: "student_only",
    conversation_memory: "session_only",
    max_shared_chars: 500,
    workspace_write_globs: ["labs/**"],
  },
  modules: [
    {
      id: "module",
      title: "Module",
      description: "Module description",
      phases: [
        {
          id: "phase",
          title: "Phase",
          progress: "required" as const,
          experience: { type: "builtin" as const, id: "orientation" as const },
          teacher: {
            access: { mode: "available" as const, requires: [] },
            guidance: {
              style: { type: "builtin" as const, id: "explanatory" as const },
              hint_level: "full" as const,
            },
            sharing: { allow: ["selection", "cell", "output"] },
            proposals: { allow: ["profile", "course", "workspace"] },
          },
          completion: { requirements: [] },
          surfaces: [
            {
              id: "surface",
              type: "notebook",
              purpose: "primary" as const,
              label: "Content",
              path: "lesson.ipynb",
              selector: { type: "cell_ids" as const, values: ["cell-1"] },
            },
          ],
        },
      ],
    },
  ],
};

function Harness({
  selection,
}: {
  selection: AuthorDocumentState["selection"];
}) {
  const [state, dispatch] = useReducer(draftReducer, {
    draft: createDraft(manifest),
    selection,
    validation: "valid",
    saved: manifest,
  } satisfies AuthorDocumentState);
  return (
    <>
      <Inspector state={state} dispatch={dispatch} />
      <output>{JSON.stringify(projectDraft(state.draft))}</output>
    </>
  );
}
function projected(): AuthorManifest {
  return JSON.parse(
    document.querySelector("output")?.textContent ?? "",
  ) as AuthorManifest;
}

describe("Inspector", () => {
  it("projects every learner phase kind as explicitly inert draft-only preview", () => {
    for (const kind of [
      "generic",
      "orientation",
      "reading",
      "media",
      "prediction",
      "experiment",
      "practice",
      "review",
      "project",
    ] as const) {
      const phase = {
        ...manifest.modules[0]!.phases[0]!,
        experience: { type: "builtin" as const, id: kind },
      };
      const view = render(<LearnerPhasePreview phase={phase} />);
      expect(screen.getByRole("status")).toHaveTextContent("Preview only");
      expect(
        screen.getByRole("heading", { name: new RegExp(kind, "i") }),
      ).toBeInTheDocument();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      view.unmount();
    }
  });

  it("renders every course, policy, module, phase, capability, and completion control using native labelled fields", () => {
    const view = render(<Harness selection={{ type: "course" }} />);
    for (const label of [
      "Course ID",
      "Course title",
      "Course description",
      "Entry module",
      "Content sharing",
      "Durable mutation",
      "Terminal execution",
      "Conversation memory",
      "Max shared characters",
      "Workspace write glob 1",
    ])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    view.unmount();
    render(
      <Harness
        selection={{
          type: "module",
          moduleKey: createDraft(manifest).modules[0]!.clientKey,
        }}
      />,
    );
    for (const label of ["Module ID", "Module title", "Module description"])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it("renders activity experience, independent policy, and multiple completion variants", () => {
    const draft = createDraft(manifest);
    const moduleKey = draft.modules[0]!.clientKey;
    const phaseKey = draft.modules[0]!.phases[0]!.clientKey;
    render(<Harness selection={{ type: "phase", moduleKey, phaseKey }} />);
    for (const label of [
      "Phase ID",
      "Phase title",
      "Progress",
      "Experience",
      "Teacher access",
      "Hint level",
      "Share selection",
      "Share cell",
      "Share output",
      "Propose profile",
      "Propose course",
    ])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByLabelText("Experience")).toHaveTextContent(
      "genericorientationreadingmediapredictionexperimentpracticereviewproject",
    );
    expect(screen.getByLabelText("Teacher access")).toHaveTextContent(
      "availabledisabledobserver_only",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add requirement" }));
    expect(
      screen.getByLabelText("Requirement 1 record kind"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add requirement" }));
    fireEvent.change(screen.getByLabelText("Requirement 2 type"), {
      target: { value: "artifact_exists" },
    });
    expect(
      screen.getByLabelText("Requirement 2 artifact path"),
    ).toBeInTheDocument();
    expect(
      projected().modules[0]!.phases[0]!.completion!.requirements.map(
        (r) => r.type,
      ),
    ).toEqual(["learner_record", "artifact_exists"]);
    fireEvent.change(screen.getByLabelText("Teacher access"), {
      target: { value: "observer_only" },
    });
    expect(projected().modules[0]!.phases[0]!.teacher).toMatchObject({
      access: { mode: "observer_only", requires: [] },
      sharing: { allow: [] },
      proposals: { allow: [] },
    });
    expect(screen.getByLabelText("Share selection")).toBeDisabled();
  });

  it("renders each surface discriminator and strips stale forbidden fields when changing variants", () => {
    const draft = createDraft(manifest);
    const moduleKey = draft.modules[0]!.clientKey;
    const phaseKey = draft.modules[0]!.phases[0]!.clientKey;
    const surfaceKey = draft.modules[0]!.phases[0]!.surfaces[0]!.clientKey;
    function StableHarness() {
      const [state, dispatch] = useReducer(draftReducer, {
        draft,
        selection: { type: "surface", moduleKey, phaseKey, surfaceKey },
        validation: "valid",
        saved: manifest,
      } satisfies AuthorDocumentState);
      return (
        <>
          <Inspector state={state} dispatch={dispatch} />
          <output>{JSON.stringify(projectDraft(state.draft))}</output>
        </>
      );
    }
    render(<StableHarness />);
    for (const label of [
      "Surface ID",
      "Surface type",
      "Surface purpose",
      "Surface label",
      "Path",
      "Notebook selector",
      "Cell ID 1",
    ])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    for (const type of [
      "html",
      "markdown",
      "source",
      "notebook",
      "video",
      "terminal",
      "external",
    ]) {
      fireEvent.change(screen.getByLabelText("Surface type"), {
        target: { value: type },
      });
      expect(screen.getByLabelText("Surface type")).toHaveValue(type);
    }
    expect(screen.getByLabelText("External URL")).toBeInTheDocument();
    expect(screen.queryByLabelText("Path")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Cell ID 1")).not.toBeInTheDocument();
    expect(projected().modules[0]!.phases[0]!.surfaces[0]).toEqual({
      id: "surface",
      type: "external",
      purpose: "primary" as const,
      label: "Content",
      url: "https://example.test/",
    });
    fireEvent.change(screen.getByLabelText("Surface type"), {
      target: { value: "terminal" },
    });
    for (const label of ["Terminal label", "Argument 1", "Working directory"])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Surface type"), {
      target: { value: "video" },
    });
    expect(screen.getByLabelText("Video source")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Video source"), {
      target: { value: "https://example.test/video.mp4" },
    });
    expect(screen.queryByLabelText("Path")).not.toBeInTheDocument();
    expect(projected().modules[0]!.phases[0]!.surfaces[0]).toEqual({
      id: "surface",
      type: "video",
      purpose: "primary",
      label: "Content",
      src: "https://example.test/video.mp4",
    });
  });

  it("adds and removes list values and removes empty optional video ranges from the projection", () => {
    const courseView = render(<Harness selection={{ type: "course" }} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add workspace write glob" }),
    );
    fireEvent.change(screen.getByLabelText("Workspace write glob 2"), {
      target: { value: "notes/**" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove workspace write glob 1" }),
    );
    expect(projected().policies.workspace_write_globs).toEqual(["notes/**"]);
    courseView.unmount();

    const view = render(
      <Harness
        selection={{
          type: "surface",
          moduleKey: "draft-1",
          phaseKey: "draft-2",
          surfaceKey: "draft-3",
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Notebook selector"), {
      target: { value: "cell_tags" },
    });
    fireEvent.change(screen.getByLabelText("Cell tag 1"), {
      target: { value: "intro" },
    });
    fireEvent.change(screen.getByLabelText("Tag matching"), {
      target: { value: "all" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add cell tag" }));
    fireEvent.change(screen.getByLabelText("Cell tag 2"), {
      target: { value: "predict" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove cell tag 1" }));
    expect(projected().modules[0]!.phases[0]!.surfaces[0]).toMatchObject({
      selector: { type: "cell_tags", values: ["predict"], match: "all" },
    });
    fireEvent.change(screen.getByLabelText("Notebook selector"), {
      target: { value: "whole_notebook" },
    });
    expect(projected().modules[0]!.phases[0]!.surfaces[0]).toMatchObject({
      selector: { type: "whole_notebook" },
    });
    expect(screen.queryByLabelText("Cell tag 1")).not.toBeInTheDocument();
    view.unmount();

    const videoView = render(
      <Harness
        selection={{
          type: "surface",
          moduleKey: "draft-1",
          phaseKey: "draft-2",
          surfaceKey: "draft-3",
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Surface type"), {
      target: { value: "video" },
    });
    fireEvent.change(screen.getByLabelText("Start seconds"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("End seconds"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("Start seconds"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("End seconds"), {
      target: { value: "" },
    });
    expect(projected().modules[0]!.phases[0]!.surfaces[0]).toEqual({
      id: "surface",
      type: "video",
      purpose: "primary" as const,
      label: "Content",
      src: "video.mp4",
    });
    videoView.unmount();
  });
});

afterEach(cleanup);
