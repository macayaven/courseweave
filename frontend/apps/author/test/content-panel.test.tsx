import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContentPanel } from "../src/content-panel";

afterEach(cleanup);
const sha = "a".repeat(64);
const pending = { change_id: "change-one", project_id: "one", target_path: "lesson.md", revision: 0,
  before_exists: true, before_sha256: sha, after_sha256: "b".repeat(64), context_digest: "c".repeat(64),
  status: "pending" as const, issues: [], sources: [] };
const review = { ...pending, diff: "--- lesson.md\n+++ lesson.md\n-Original\n+Edited\n", text: "Edited\n" };
const markdown = { path: "lesson.md", exists: true, sha256: sha, size: 9, kind: "markdown" as const,
  text: "Original\n", project_revision: 0, manifest_sha256: sha };

function client() {
  return {
    getContentFiles: vi.fn().mockResolvedValue({ files: [{ path: "lesson.md", size: 9, sha256: sha }, { path: "lab.ipynb", size: 42, sha256: sha }], omitted: [] }),
    getContent: vi.fn().mockResolvedValue(markdown),
    getChanges: vi.fn().mockResolvedValue({ changes: [], total: 0 }),
    stageContent: vi.fn().mockResolvedValue(pending),
    getChange: vi.fn().mockResolvedValue(review),
    applyChange: vi.fn().mockResolvedValue({ operation_id: "saved" }),
    rejectChange: vi.fn().mockResolvedValue({ ...pending, status: "rejected" }),
  };
}

async function openFile(path = "lesson.md") {
  fireEvent.change(await screen.findByLabelText("File path"), { target: { value: path } });
  fireEvent.click(screen.getByRole("button", { name: "Open file" }));
}

it("saves a pending diff before apply and requires explicit review of that revision", async () => {
  const api = client();
  const dirty = vi.fn();
  render(<ContentPanel client={api} disabled={false} onDirtyChange={dirty} onChanged={vi.fn()} />);
  await openFile();
  fireEvent.change(await screen.findByLabelText("Markdown source"), { target: { value: "Edited\n" } });
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Review file edit" }));
  expect((await screen.findByText(/-Original/)).textContent).toBe(review.diff);
  expect(api.applyChange).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Apply reviewed change" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("I reviewed this exact diff"));
  expect(screen.getByRole("button", { name: "Apply reviewed change" })).toBeEnabled();
  api.getChange.mockResolvedValue({ ...review, status: "rejected" });
  fireEvent.click(screen.getByRole("button", { name: "Reject change" }));
  await waitFor(() => expect(api.rejectChange).toHaveBeenCalledWith("change-one", 0, expect.anything()));
  expect(api.applyChange).not.toHaveBeenCalled();
});

it("retains unsaved Markdown after a stale save and offers an explicit discard/reload", async () => {
  const api = client();
  api.stageContent.mockRejectedValue(new Error("File changed; keep your local edit and reload the saved file."));
  render(<ContentPanel client={api} disabled={false} onDirtyChange={vi.fn()} onChanged={vi.fn()} />);
  await openFile();
  fireEvent.change(await screen.findByLabelText("Markdown source"), { target: { value: "Keep my work" } });
  fireEvent.click(screen.getByRole("button", { name: "Review file edit" }));
  await screen.findByText(/File changed; keep your local edit/);
  expect(screen.getByLabelText("Markdown source")).toHaveValue("Keep my work");
  api.getContent.mockResolvedValue({ ...markdown, text: "Saved elsewhere\n" });
  fireEvent.click(screen.getByRole("button", { name: "Discard local edits and reload" }));
  await waitFor(() => expect(screen.getByLabelText("Markdown source")).toHaveValue("Saved elsewhere\n"));
});

it("sends only selected notebook cells and retains their stable selection after reload", async () => {
  const api = client();
  api.getContent.mockResolvedValue({ ...markdown, path: "lab.ipynb", kind: "notebook", notebook: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { id: "read", cell_type: "markdown", metadata: { tags: ["keep"] }, source: ["Read this.\n"] },
    { id: "attempt", cell_type: "code", metadata: {}, source: ["prediction = None\n"], outputs: [], execution_count: null },
  ] } });
  api.getChange.mockResolvedValue({ ...review, target_path: "lab.ipynb" });
  render(<ContentPanel client={api} disabled={false} onDirtyChange={vi.fn()} onChanged={vi.fn()} />);
  await openFile("lab.ipynb");
  fireEvent.click(await screen.findByLabelText("Select cell attempt"));
  fireEvent.change(screen.getByLabelText("Source for cell attempt"), { target: { value: "prediction = 7\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Review cell edits" }));
  await waitFor(() => expect(api.stageContent).toHaveBeenCalledWith(expect.objectContaining({
    action: { kind: "notebook_cells", replace_sources: { attempt: "prediction = 7\n" } },
  }), expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Reload saved file" }));
  await waitFor(() => expect(screen.getByLabelText("Select cell attempt")).toBeChecked());
  expect(screen.getByLabelText("Select cell read")).not.toBeChecked();
});

it("reuses the operation ID when an explicit apply retry follows an uncertain response", async () => {
  const api = client();
  api.getChanges.mockResolvedValue({ changes: [pending], total: 1 });
  api.applyChange.mockRejectedValueOnce(new Error("Response interrupted"));
  render(<ContentPanel client={api} disabled={false} onDirtyChange={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review lesson.md" }));
  fireEvent.click(await screen.findByLabelText("I reviewed this exact diff"));
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed change" }));
  await screen.findByText(/Response interrupted/);
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed change" }));
  await waitFor(() => expect(api.applyChange).toHaveBeenCalledTimes(2));
  expect(api.applyChange.mock.calls[0]![1].operation_id).toEqual(api.applyChange.mock.calls[1]![1].operation_id);
});

it("keeps a deselected edited cell when a different cell is staged", async () => {
  const api = client();
  api.getContent.mockResolvedValue({ ...markdown, path: "lab.ipynb", kind: "notebook", notebook: {
    nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      { id: "read", cell_type: "markdown", metadata: {}, source: ["Original reading\n"] },
      { id: "attempt", cell_type: "code", metadata: {}, source: ["pass\n"], outputs: [], execution_count: null },
    ],
  } });
  render(<ContentPanel client={api} disabled={false} onDirtyChange={vi.fn()} onChanged={vi.fn()} />);
  await openFile("lab.ipynb");
  fireEvent.click(await screen.findByLabelText("Select cell read"));
  fireEvent.change(screen.getByLabelText("Source for cell read"), { target: { value: "Retain this separate draft" } });
  fireEvent.click(screen.getByLabelText("Select cell read"));
  fireEvent.click(screen.getByLabelText("Select cell attempt"));
  fireEvent.change(screen.getByLabelText("Source for cell attempt"), { target: { value: "print(7)\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Review cell edits" }));
  await screen.findByText("Pending change saved. Review the diff before applying this file.");
  await waitFor(() => expect(screen.getByLabelText("Select cell read")).toBeEnabled());
  fireEvent.click(screen.getByLabelText("Select cell read"));
  expect(screen.getByLabelText("Source for cell read")).toHaveValue("Retain this separate draft");
  expect(screen.getByRole("button", { name: "Apply reviewed change" })).toBeDisabled();
});

it("edits a copy of a saved candidate before creating a new reviewed change", async () => {
  const api = client();
  api.getChanges.mockResolvedValue({ changes: [pending], total: 1 });
  render(<ContentPanel client={api} disabled={false} onDirtyChange={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Review lesson.md" }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit this change" }));
  await waitFor(() => expect(screen.getByLabelText("Markdown source")).toHaveValue("Edited\n"));
  fireEvent.change(screen.getByLabelText("Markdown source"), { target: { value: "Human corrected candidate\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Review file edit" }));
  await waitFor(() => expect(api.stageContent).toHaveBeenCalledWith(expect.objectContaining({
    action: { kind: "markdown_replace", text: "Human corrected candidate\n" },
  }), expect.anything()));
  expect(api.applyChange).not.toHaveBeenCalled();
});
