import canonical from "./canonical-manifest.json";
import { describe, it, expect } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { useReducer } from "react";
import type { AuthorManifest } from "@courseweave/ui";
import {
  createDraft,
  projectDraft,
  draftReducer,
  type AuthorDocumentState,
} from "../src/draft";
import { Inspector } from "../src/inspector";
const manifest = canonical as AuthorManifest;
describe("canonical Author", () => {
  it("round trips every canonical field and deeply separates saved, draft, projection, and duplicate metadata", () => {
    const draft = createDraft(manifest);
    expect(projectDraft(draft)).toEqual(manifest);
    const before = structuredClone(manifest);
    const state = draftReducer(
      {
        draft,
        saved: manifest,
        selection: { type: "course" },
        validation: "valid",
      },
      { type: "module.duplicate", moduleKey: draft.modules[0]!.clientKey },
    );
    const copy = state.draft.modules[1]!;
    expect(copy.phases[0]!.teacher).toEqual(
      draft.modules[0]!.phases[0]!.teacher,
    );
    expect(copy.phases[0]!.learning).toEqual(
      draft.modules[0]!.phases[0]!.learning,
    );
    copy.phases[0]!.teacher.access.requires.push("another");
    copy.phases[0]!.completion!.requirements[0]!.prompt = "Copy only";
    copy.phases[0]!.learning!.checks![0]!.options[0]!.feedback =
      "Copy feedback";
    copy.phases[0]!.learning!.sources![0]!.label = "Copy source";
    copy.phases[0]!.learning!.hints![0]!.objective_ids!.push("copy-only");
    copy.phases[0]!.surfaces.forEach((surface) => {
      if (
        surface.type === "notebook" &&
        surface.selector.type !== "whole_notebook"
      )
        surface.selector.values.push("copy-cell");
      if (surface.type === "terminal") surface.command.push("copy-arg");
    });
    copy.phases[0]!.learning!.objectives![0]!.text = "Changed";
    const projected = projectDraft(draft);
    projected.modules[0]!.phases[0]!.learning!.hints![0]!.objective_ids!.push(
      "other",
    );
    expect(projectDraft(draft)).toEqual(before);
    expect(manifest).toEqual(before);
  });
  it("edits multiple requirements, independent policy, and nested Learning through labelled fields", () => {
    const draft = createDraft(manifest);
    const module = draft.modules[0]!;
    const phase = module.phases[0]!;
    function Harness() {
      const [state, dispatch] = useReducer(draftReducer, {
        draft,
        saved: manifest,
        selection: {
          type: "phase",
          moduleKey: module.clientKey,
          phaseKey: phase.clientKey,
        },
        validation: "valid",
      } satisfies AuthorDocumentState);
      return (
        <>
          <Inspector state={state} dispatch={dispatch} />
          <output>{JSON.stringify(projectDraft(state.draft))}</output>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByLabelText("Progress")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Requirement 1 prompt"), {
      target: { value: "Write your prediction" },
    });
    fireEvent.change(screen.getByLabelText("Objective 1 text"), {
      target: { value: "Explain the result" },
    });
    const updated = JSON.parse(document.querySelector("output")!.textContent!);
    expect(updated.modules[0].phases[0].completion.requirements[0].prompt).toBe(
      "Write your prediction",
    );
    expect(updated.modules[0].phases[0].learning.objectives[0].text).toBe(
      "Explain the result",
    );
    expect(updated.modules[0].phases[0].completion.requirements).toHaveLength(
      manifest.modules[0]!.phases[0]!.completion!.requirements.length,
    );
    cleanup();
  });
});

it("requires the author to choose the correct answer after deleting it instead of silently awarding another option", () => {
  const input = structuredClone(manifest);
  const selected = input.modules[0]!.phases[0]!;
  selected.learning = {
    checks: [
      {
        id: "choice",
        type: "single_choice",
        prompt: "Choose",
        options: [
          { id: "a", text: "A", feedback: "A feedback" },
          { id: "b", text: "B", feedback: "B feedback" },
          { id: "c", text: "C", feedback: "C feedback" },
        ],
        correct_option_id: "c",
      },
    ],
  };
  const draft = createDraft(input);
  function Harness() {
    const [state, dispatch] = useReducer(draftReducer, {
      draft,
      saved: input,
      selection: {
        type: "phase",
        moduleKey: draft.modules[0]!.clientKey,
        phaseKey: draft.modules[0]!.phases[0]!.clientKey,
      },
      validation: "valid",
    } satisfies AuthorDocumentState);
    return (
      <>
        <Inspector state={state} dispatch={dispatch} />
        <output>{JSON.stringify(projectDraft(state.draft))}</output>
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(
    screen.getByRole("button", { name: "Remove check 1 option 3" }),
  );
  const course = JSON.parse(document.querySelector("output")!.textContent!);
  expect(course.modules[0].phases[0].learning.checks[0].correct_option_id).toBe(
    "c",
  );
  expect(screen.getByLabelText("Check 1 correct option")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  expect(
    screen.getByText("Choose an existing correct option before saving."),
  ).toBeInTheDocument();
  cleanup();
});

it("links invalid gate and objective references to their native controls before save", () => {
  const draft = createDraft(manifest);
  const phase = draft.modules[0]!.phases[0]!;
  phase.teacher.access.requires = ["unknown"];
  phase.learning!.hints![0]!.objective_ids = ["missing"];
  render(
    <Inspector
      state={{
        draft,
        saved: manifest,
        selection: {
          type: "phase",
          moduleKey: draft.modules[0]!.clientKey,
          phaseKey: phase.clientKey,
        },
        validation: "idle",
      }}
      dispatch={() => undefined}
    />,
  );
  for (const label of ["Gate requirement ID 1", "Hint 1 objective ID 1"]) {
    const control = screen.getByLabelText(label);
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(
      document.getElementById(control.getAttribute("aria-describedby")!),
    ).toHaveTextContent("Choose an existing");
  }
  cleanup();
});

it("repairs scoped references during deliberate renames and edits the full Learning metadata without dropping siblings", () => {
  const draft = createDraft(manifest);
  const module = draft.modules[0]!,
    phase = module.phases[0]!;
  function Harness() {
    const [state, dispatch] = useReducer(draftReducer, {
      draft,
      saved: manifest,
      selection: {
        type: "phase",
        moduleKey: module.clientKey,
        phaseKey: phase.clientKey,
      },
      validation: "valid",
    } satisfies AuthorDocumentState);
    return (
      <>
        <Inspector state={state} dispatch={dispatch} />
        <output>{JSON.stringify(projectDraft(state.draft))}</output>
      </>
    );
  }
  render(<Harness />);
  const change = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  change("Requirement 1 ID", "prediction-renamed");
  change("Objective 2 ID", "time-bounds");
  change("Check 1 option 2 id", "deadline");
  change("Check 1 option 2 feedback", "A deadline bounds waiting.");
  change("Source 1 reviewed date", "2026-09-09");
  change("Minimum minutes", "15");
  change("Maximum minutes", "25");
  change("Learning overview", "Compare each event in the trace.");
  change("Custom experience", "example.org/trace-review");
  change("Custom guidance style", "example.org/paired-inquiry");
  fireEvent.click(screen.getByRole("button", { name: "Move hint 2 up" }));
  const updated = JSON.parse(
    document.querySelector("output")!.textContent!,
  ) as AuthorManifest;
  const activity = updated.modules[0]!.phases[0]!;
  expect(activity.teacher.access.requires).toEqual([
    "prediction-renamed",
    "evidence",
  ]);
  expect(activity.learning!.hints![0]!.objective_ids).toEqual([
    "pairing",
    "time-bounds",
  ]);
  expect(activity.learning!.checks![0]!.objective_ids).toEqual(["time-bounds"]);
  expect(activity.learning!.checks![0]!.correct_option_id).toBe("deadline");
  expect(activity.learning!.checks![0]!.options[1]!.feedback).toBe(
    "A deadline bounds waiting.",
  );
  expect(activity.learning!.sources![0]!.reviewed_date).toBe("2026-09-09");
  expect(activity.learning!.duration).toEqual({
    min_minutes: 15,
    max_minutes: 25,
  });
  expect(activity.experience).toEqual({
    type: "custom",
    id: "example.org/trace-review",
  });
  expect(activity.teacher.guidance.style).toEqual({
    type: "custom",
    id: "example.org/paired-inquiry",
  });
  expect(updated.modules[0]!.phases.slice(1)).toEqual(
    manifest.modules[0]!.phases.slice(1),
  );
  cleanup();
});
it("keeps HTML fragments separate from local paths and provides runtime when adding notebooks", () => {
  const input = structuredClone(manifest);
  delete input.runtime;
  input.modules[0]!.phases[0]!.surfaces =
    input.modules[0]!.phases[0]!.surfaces.slice(0, 1);
  input.modules[0]!.phases = input.modules[0]!.phases.slice(0, 1);
  const draft = createDraft(input),
    module = draft.modules[0]!,
    phase = module.phases[0]!,
    surface = phase.surfaces[0]!;
  function Harness() {
    const [state, dispatch] = useReducer(draftReducer, {
      draft,
      saved: input,
      selection: {
        type: "surface",
        moduleKey: module.clientKey,
        phaseKey: phase.clientKey,
        surfaceKey: surface.clientKey,
      },
      validation: "valid",
    } satisfies AuthorDocumentState);
    return (
      <>
        <Inspector state={state} dispatch={dispatch} />
        <output>{JSON.stringify(projectDraft(state.draft))}</output>
      </>
    );
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("HTML fragment"), {
    target: { value: "Quiz:2" },
  });
  let updated = JSON.parse(document.querySelector("output")!.textContent!);
  expect(updated.modules[0].phases[0].surfaces[0]).toMatchObject({
    path: "lessons/trace.html",
    fragment: "Quiz:2",
  });
  fireEvent.change(screen.getByLabelText("Surface type"), {
    target: { value: "notebook" },
  });
  updated = JSON.parse(document.querySelector("output")!.textContent!);
  expect(updated.runtime).toEqual({
    type: "jupyter",
    kernel: { type: "python_uv_project" },
  });
  expect(updated.modules[0].phases[0].surfaces[0]).not.toHaveProperty(
    "fragment",
  );
  expect(updated.modules[0].phases[0].surfaces[0].selector).toEqual({
    type: "whole_notebook",
  });
  cleanup();
});
