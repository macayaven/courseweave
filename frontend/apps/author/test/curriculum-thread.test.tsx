import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CurriculumThread } from "../src/curriculum-thread";

function response(wire: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
        controller.close();
      },
    }),
  );
}

const completed = (threadId: string, runId: string, candidate = false) =>
  `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId })}\n\n` +
  `data: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\n` +
  `data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":"Advice"}\n\n` +
  `data: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\n` +
  (candidate
    ? `data: {"type":"CUSTOM","name":"courseweave.proposal_candidate","value":{"candidate":{"id":"candidate-a","type":"manifest_replace","origin":"teacher_suggested","summary":"Improve course","target":"courseweave.json","payload":{"manifest":{"schema_version":1}},"target_hash":null}}}\n\n`
    : "") +
  `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId, runId })}\n\n`;

afterEach(() => cleanup());

describe("CurriculumThread", () => {
  it("does not call a provider on load, discloses saved-manifest sharing, and sends only a fresh user message", async () => {
    const postGuide = vi.fn().mockImplementation((body) =>
      Promise.resolve(response(completed(body.threadId, body.runId))),
    );
    render(
      <CurriculumThread
        client={{ postGuide, createProposal: vi.fn() }}
        sourceId="author-window"
        clean
        recovery={false}
        onProvider={vi.fn()}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(postGuide).not.toHaveBeenCalled();
    expect(
      screen.getByText(/asking sends the saved manifest to the configured provider/i),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "Review the order" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    await waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
    expect(postGuide.mock.calls[0]?.[0]).toMatchObject({
      messages: [{ role: "user", content: "Review the order" }],
      tools: [],
      context: [],
      forwardedProps: { source_id: "author-window" },
    });
    expect(screen.getByText("Advice")).toBeInTheDocument();
  });

  it("keeps a newer composer edit when an older run settles and persists only a candidate ID through REST", async () => {
    let settle: ((response: Response) => void) | undefined;
    const postGuide = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => { settle = resolve; }),
    );
    const createProposal = vi.fn().mockResolvedValue({ id: "proposal-a" });
    const onProposal = vi.fn();
    render(
      <CurriculumThread
        client={{ postGuide, createProposal }}
        sourceId="author-window"
        clean
        recovery={false}
        onProvider={vi.fn()}
        onProposal={onProposal}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const composer = screen.getByLabelText("Ask the curriculum teacher");
    fireEvent.change(composer, { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    fireEvent.change(composer, { target: { value: "Newer draft" } });
    const body = postGuide.mock.calls[0]?.[0];
    settle?.(response(completed(body.threadId, body.runId, true)));
    await screen.findByText("Suggested change ready for review.");
    expect(composer).toHaveValue("Newer draft");
    fireEvent.click(screen.getByRole("button", { name: "Save suggested change" }));
    await waitFor(() => expect(createProposal).toHaveBeenCalledWith("candidate-a", expect.any(AbortSignal)));
    expect(onProposal).toHaveBeenCalledWith({ id: "proposal-a" });
  });

  it("blocks Ask for a dirty draft and keeps CRUD independent after provider failure", async () => {
    const postGuide = vi.fn().mockRejectedValue({ code: "not_configured" });
    const onProvider = vi.fn();
    const { rerender } = render(
      <CurriculumThread client={{ postGuide, createProposal: vi.fn() }} sourceId="author-window" clean={false} recovery={false} onProvider={onProvider} onProposal={vi.fn()} onRefresh={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Ask teacher" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/saved manifest/i);
    rerender(<CurriculumThread client={{ postGuide, createProposal: vi.fn() }} sourceId="author-window" clean recovery={false} onProvider={onProvider} onProposal={vi.fn()} onRefresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), { target: { value: "Retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    await screen.findByText("Teacher unavailable");
    expect(onProvider).toHaveBeenCalledWith("not_configured");
  });
});
