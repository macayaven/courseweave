import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthorAssistant } from "../src/curriculum-thread";

afterEach(cleanup);

const clientFor = () => ({
  getSources: vi.fn().mockResolvedValue({ sources: [
    { source_id: "approved", title: "Reference", status: "approved", revision: 1 },
    { source_id: "candidate", title: "Unreviewed", status: "candidate", revision: 0 },
  ] }),
  getContentFiles: vi.fn().mockResolvedValue({ files: [{ path: "lesson.md" }], omitted: [] }),
  getContent: vi.fn().mockResolvedValue({ path: "lesson.md", kind: "markdown", text: "Before" }),
  previewAuthorContext: vi.fn().mockImplementation(async (body) => ({
    context_id: "context-one", conversation_retained: true,
    context: { digest: "a".repeat(64), role: body.role, selection: body.selection,
      sources: body.source_ids.map((source_id: string) => ({ source_id })), content: '{"target":{"text":"Before"}}',
      omissions: ["Unselected files are omitted."], budget: { max_input_chars: 24000, max_output_chars: 16000 } },
  })),
  postGuide: vi.fn(),
  saveAuthorDraft: vi.fn(),
  saveAuthorReview: vi.fn(),
});

it("shows six hats and exact context before sending, with explicit approved-source permission", async () => {
  const client = clientFor();
  render(<AuthorAssistant client={client} projectId="project" courseId="course" clean onSaved={vi.fn()} />);
  await screen.findByText("Unselected files are omitted.");
  expect(screen.getByLabelText("Author role").querySelectorAll("option")).toHaveLength(6);
  expect(client.postGuide).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Permit Reference")).not.toBeChecked();
  expect(screen.queryByLabelText("Permit Unreviewed")).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Permit Reference"));
  await waitFor(() => expect(client.previewAuthorContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ source_ids: ["approved"] }), expect.any(AbortSignal)));
  fireEvent.change(screen.getByLabelText("Author role"), { target: { value: "fact_checker" } });
  await waitFor(() => expect(client.previewAuthorContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ role: "fact_checker", source_ids: ["approved"] }), expect.any(AbortSignal)));
});

it("keeps the composer and blocks provider requests while saved scope is unavailable", async () => {
  const client = clientFor();
  const props = { client, projectId: "project", courseId: "course", onSaved: vi.fn() };
  const view = render(<AuthorAssistant {...props} clean />);
  await screen.findByText("Unselected files are omitted.");
  fireEvent.change(screen.getByLabelText("Message to Author assistant"), { target: { value: "Keep this request" } });
  view.rerender(<AuthorAssistant {...props} clean={false} />);
  expect(screen.getByLabelText("Message to Author assistant")).toHaveValue("Keep this request");
  expect(screen.getByRole("button", { name: "Request draft" })).toBeDisabled();
  expect(client.postGuide).not.toHaveBeenCalled();
});

function completed(body: { threadId: string; runId: string }, terminal = true, wrongScope = false) {
  const context = { version: "turn-context-v1", module_id: null, phase_id: null, surface_id: null,
    source_id: "author-selection", manifest_etag: '"saved"', state_revision: 0, consent: false,
    teacher_mode: "curriculum_designer", policy: null, lesson_scope_id: null, privacy_epoch: 0,
    run_id: body.runId, evidence_dependency: "a".repeat(64), evidence_references: [], assistant_name: "Course assistant",
    lesson: {}, workspace_share: null, author: { context_id: wrongScope ? "old" : "context-one", digest: "a".repeat(64),
      role: "curriculum_designer", selection: {}, source_count: 0, omissions: [] } };
  const reply = { version: "author-reply-v1", role: "curriculum_designer", message: "A clearer prompt.", findings: [],
    change: { kind: "markdown_replace", text: "After" } };
  const rows = [
    { type: "RUN_STARTED", ...body }, { type: "CUSTOM", name: "courseweave.turn_context", value: context },
    { type: "TEXT_MESSAGE_START", messageId: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant", delta: JSON.stringify(reply) },
    { type: "CUSTOM", name: "courseweave.provider_outcome", value: { version: "provider-evidence-v1", status: "ok",
      profile: "text-only-v1", capability_version: "capabilities-v1", prompt_version: "author-assistant-v2",
      config_fingerprint: "a".repeat(64), duration_ms: 10, input_tokens: 10, output_tokens: 10, requests: 1 } },
    { type: "TEXT_MESSAGE_END", messageId: "assistant" },
    { type: "CUSTOM", name: "courseweave.author_reply", value: { draft_id: "draft-" + "a".repeat(32), context_digest: "a".repeat(64), reply } },
    ...(terminal ? [{ type: "RUN_FINISHED", ...body }] : []),
  ];
  return new Response(rows.map(row => "data: " + JSON.stringify(row) + "\n\n").join(""));
}

it("accepts a completed matching stream and saves only on explicit action while keeping the conversation on a hat change", async () => {
  const client = clientFor(), onSaved = vi.fn();
  client.postGuide.mockImplementation(async body => completed({ threadId: body.threadId, runId: body.runId }));
  client.saveAuthorDraft.mockResolvedValue({ change_id: "change-one" });
  render(<AuthorAssistant client={client} projectId="project" courseId="course" clean onSaved={onSaved} />);
  await screen.findByText("Unselected files are omitted.");
  fireEvent.change(screen.getByLabelText("Message to Author assistant"), { target: { value: "Make this clearer" } });
  fireEvent.click(screen.getByRole("button", { name: "Request draft" }));
  await screen.findByText("A clearer prompt.");
  expect(client.saveAuthorDraft).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save draft for review" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ change_id: "change-one" }));
  fireEvent.change(screen.getByLabelText("Author role"), { target: { value: "curator" } });
  expect(screen.getByText("A clearer prompt.")).toBeInTheDocument();
});

it.each([false, true])("rejects an incomplete or wrong-context stream without enabling save (wrong context: %s)", async wrongScope => {
  const client = clientFor();
  client.postGuide.mockImplementation(async body => completed({ threadId: body.threadId, runId: body.runId }, wrongScope, wrongScope));
  render(<AuthorAssistant client={client} projectId="project" courseId="course" clean onSaved={vi.fn()} />);
  await screen.findByText("Unselected files are omitted.");
  fireEvent.change(screen.getByLabelText("Message to Author assistant"), { target: { value: "Keep the request" } });
  fireEvent.click(screen.getByRole("button", { name: "Request draft" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Request draft" })).toBeEnabled());
  expect(screen.queryByRole("button", { name: "Save draft for review" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Message to Author assistant")).toHaveValue("Keep the request");
  expect(client.saveAuthorDraft).not.toHaveBeenCalled();
});

it("saves a report separately while preserving a pending content draft", async () => {
  const client = clientFor(), onReviewSaved = vi.fn();
  client.postGuide.mockImplementation(async body => completed({ threadId: body.threadId, runId: body.runId }));
  client.saveAuthorReview.mockResolvedValue({ report_id: "review-one" });
  render(<AuthorAssistant client={client} projectId="project" courseId="course" clean onSaved={vi.fn()} onReviewSaved={onReviewSaved} />);
  await screen.findByText("Unselected files are omitted.");
  fireEvent.change(screen.getByLabelText("Message to Author assistant"), { target: { value: "Review this" } });
  fireEvent.click(screen.getByRole("button", { name: "Request review" }));
  await screen.findByText("A clearer prompt.");
  expect(client.saveAuthorReview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save review report" }));
  await waitFor(() => expect(onReviewSaved).toHaveBeenCalledWith("review-one"));
  expect(client.saveAuthorDraft).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Save draft for review" })).toBeEnabled();
});
