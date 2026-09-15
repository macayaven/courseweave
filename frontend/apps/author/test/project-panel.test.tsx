import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectPanel, SourceLibrary } from "../src/project-panel";

afterEach(cleanup);
const inventory = { digest: "reviewed", files: [{ path: "lesson.md", size: 20, sha256: "hash" }],
  omitted: [{ path: ".env", reason: "excluded private or runtime path" }], total_bytes: 20 };
const client = () => ({ inspectSource: vi.fn().mockResolvedValue(inventory),
  createProject: vi.fn().mockResolvedValue({ project_id: "new-course" }) });

it("creates an empty project only on direct action", async () => {
  const api = client();
  const onSelect = vi.fn();
  render(<ProjectPanel client={api} projects={[]} unavailable={[]} selected={null}
    disabled={false} onSelect={onSelect} />);
  fireEvent.change(screen.getByLabelText("Project ID"), { target: { value: "new-course" } });
  expect(api.createProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByText("Project created.");
  expect(api.createProject).toHaveBeenCalledWith({ project_id: "new-course", selected_paths: [] }, expect.any(AbortSignal));
  expect(onSelect).toHaveBeenCalledWith("new-course");
});

it("imports only reviewed selected files and invalidates an edited directory", async () => {
  const api = client();
  render(<ProjectPanel client={api} projects={[]} unavailable={[]} selected={null}
    disabled={false} onSelect={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("Import selected files"));
  fireEvent.change(screen.getByLabelText("Project ID"), { target: { value: "new-course" } });
  fireEvent.change(screen.getByLabelText("Source directory"), { target: { value: "/local/source" } });
  expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect source" }));
  const file = await screen.findByLabelText("lesson.md");
  expect(file).not.toBeChecked();
  expect(screen.getByText(".env: excluded private or runtime path")).toBeInTheDocument();
  fireEvent.click(file);
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByText("Project created.");
  expect(api.createProject).toHaveBeenCalledWith({ project_id: "new-course", source_root: "/local/source",
    expected_inventory: "reviewed", selected_paths: ["lesson.md"] }, expect.any(AbortSignal));
  fireEvent.change(screen.getByLabelText("Source directory"), { target: { value: "/local/other" } });
  expect(screen.queryByLabelText("lesson.md")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
});

it("does not accept a late inventory after the directory or connection changes", async () => {
  let finish!: (result: typeof inventory) => void;
  const api = { ...client(), inspectSource: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) };
  const view = render(<ProjectPanel client={api} projects={[]} unavailable={[]} selected={null}
    disabled={false} onSelect={vi.fn()} />);
  fireEvent.click(screen.getByLabelText("Import selected files"));
  fireEvent.change(screen.getByLabelText("Source directory"), { target: { value: "/local/source" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect source" }));
  view.rerender(<ProjectPanel client={api} projects={[]} unavailable={[]} selected={null}
    disabled={true} onSelect={vi.fn()} />);
  await act(async () => finish(inventory));
  expect(screen.queryByLabelText("lesson.md")).not.toBeInTheDocument();
});

it("shows provenance, duplicates and unsupported extraction without automatic approval", async () => {
  const base = { source_id: "one", revision: 0, title: "Source one", origin: "/local/one.pdf",
    imported_at: "2026-09-15T09:00:00Z", publication_date: null, raw_sha256: "same-hash", extraction: "unsupported",
    status: "candidate", intended_use: "author_reference", redistribution: "undecided", review_note: "", policy_decision: "local" };
  const api = { getSources: vi.fn().mockResolvedValue({ sources: [base, { ...base, source_id: "two", title: "Source two" }] }),
    updateSource: vi.fn().mockImplementation((_id, value) => Promise.resolve({ ...base, ...value, revision: 1 })) };
  const onDirtyChange = vi.fn();
  render(<SourceLibrary client={api} projectId="course" disabled={false} onDirtyChange={onDirtyChange} />);
  await screen.findByText("Source one");
  expect(screen.getAllByText(/Duplicate content/)).toHaveLength(2);
  expect(screen.getAllByText(/Extraction: unsupported/)).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Review status for Source one"), { target: { value: "approved" } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  expect(api.updateSource).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save decision for Source one" }));
  expect(await screen.findByText("Source decision saved.")).toBeInTheDocument();
  expect(api.updateSource).toHaveBeenCalledWith("one", expect.objectContaining({ revision: 0, status: "approved" }), expect.any(AbortSignal));
});
