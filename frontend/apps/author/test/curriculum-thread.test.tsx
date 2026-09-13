import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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
    ? `data: {"type":"CUSTOM","name":"courseweave.proposal_candidate","value":{"candidate":{"id":"candidate-a","type":"manifest_replace","origin":"teacher_suggested","summary":"Improve course","target":"courseweave.json","payload":{"manifest":{"schema_version":2}},"target_hash":null}}}\n\n`
    : "") +
  `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId, runId })}\n\n`;

afterEach(() => cleanup());

describe("CurriculumThread", () => {
  it("does not call a provider on load, discloses saved-manifest sharing, and sends only a fresh user message", async () => {
    const postGuide = vi
      .fn()
      .mockImplementation((body) =>
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
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    expect(postGuide).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        /asking sends the saved manifest to the configured provider/i,
      ),
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
      () =>
        new Promise<Response>((resolve) => {
          settle = resolve;
        }),
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
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
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
    fireEvent.click(
      screen.getByRole("button", { name: "Save suggested change" }),
    );
    await waitFor(() =>
      expect(createProposal).toHaveBeenCalledWith(
        "candidate-a",
        expect.any(AbortSignal),
      ),
    );
    expect(onProposal).toHaveBeenCalledWith({ id: "proposal-a" });
  });

  it("blocks Ask for a dirty draft and keeps CRUD independent after provider failure", async () => {
    const postGuide = vi.fn().mockRejectedValue({ code: "not_configured" });
    const onProvider = vi.fn();
    const { rerender } = render(
      <CurriculumThread
        client={{ postGuide, createProposal: vi.fn() }}
        sourceId="author-window"
        clean={false}
        recovery={false}
        onProvider={onProvider}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: false })}
      />,
    );
    expect(screen.getByRole("button", { name: "Ask teacher" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/saved manifest/i);
    rerender(
      <CurriculumThread
        client={{ postGuide, createProposal: vi.fn() }}
        sourceId="author-window"
        clean
        recovery={false}
        onProvider={onProvider}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: false })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "Retry" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    await screen.findByText("Teacher unavailable");
    expect(onProvider).toHaveBeenCalledWith("not_configured");
  });

  it("blocks a second teacher operation after candidate persistence has no complete refresh", async () => {
    const postGuide = vi
      .fn()
      .mockImplementation((body) =>
        Promise.resolve(response(completed(body.threadId, body.runId, true))),
      );
    const onProposal = vi.fn();
    const view = render(
      <CurriculumThread
        client={{
          postGuide,
          createProposal: vi.fn().mockResolvedValue({ id: "proposal-a" }),
        }}
        sourceId="author-window"
        clean
        recovery={false}
        onProvider={vi.fn()}
        onProposal={onProposal}
        onRefresh={vi.fn().mockResolvedValue({ committed: false })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "Save candidate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save suggested change" }),
    );
    await screen.findByText(/suggested change saved, refresh unavailable/i);
    expect(onProposal).toHaveBeenCalledWith({ id: "proposal-a" });
    view.rerender(
      <CurriculumThread
        client={{ postGuide, createProposal: vi.fn() }}
        sourceId="author-window"
        clean
        recovery={false}
        authorityBlocked
        onProvider={vi.fn()}
        onProposal={onProposal}
        onRefresh={vi.fn().mockResolvedValue({ committed: false })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "Second question" },
    });
    expect(screen.getByRole("button", { name: "Ask teacher" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    expect(postGuide).toHaveBeenCalledOnce();
  });

  it("keeps one thread across rerenders, creates a fresh run for Retry, and never replays history", async () => {
    const postGuide = vi.fn().mockImplementation((body) => {
      const error =
        `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: body.threadId, runId: body.runId })}\n\n` +
        `data: ${JSON.stringify({ type: "RUN_ERROR", message: "provider failed" })}\n\n`;
      return Promise.resolve(response(error));
    });
    const { rerender } = render(
      <CurriculumThread
        client={{ postGuide, createProposal: vi.fn() }}
        sourceId="outline-a"
        clean
        recovery={false}
        onProvider={vi.fn()}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "First question" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    await screen.findByText(/teacher run failed/i);
    rerender(
      <CurriculumThread
        client={{ postGuide, createProposal: vi.fn() }}
        sourceId="outline-b"
        clean
        recovery={false}
        onProvider={vi.fn()}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(postGuide).toHaveBeenCalledTimes(2));
    const first = postGuide.mock.calls[0]?.[0];
    const second = postGuide.mock.calls[1]?.[0];
    expect(second.threadId).toBe(first.threadId);
    expect(second.runId).not.toBe(first.runId);
    expect(second.messages).toEqual([
      { id: expect.any(String), role: "user", content: "First question" },
    ]);
    expect(second.messages[0].id).not.toBe(first.messages[0].id);
  });

  it("distinguishes an in-stream provider error, generic pre-stream failure, and interrupted EOF without disabling editing", async () => {
    const inStream = vi
      .fn()
      .mockImplementation((body) =>
        Promise.resolve(
          response(
            `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: body.threadId, runId: body.runId })}\n\n` +
              `data: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\n` +
              `data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":"Partial"}\n\n`,
          ),
        ),
      );
    const onProvider = vi.fn();
    const { rerender } = render(
      <CurriculumThread
        client={{ postGuide: inStream, createProposal: vi.fn() }}
        sourceId="author-window"
        clean
        recovery={false}
        onProvider={onProvider}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "EOF" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    const interrupted = await screen.findByText("Partial");
    await waitFor(() =>
      expect(interrupted).toHaveAttribute("data-state", "interrupted"),
    );
    expect(screen.getByRole("button", { name: "Ask teacher" })).toBeEnabled();
    const preStream = vi.fn().mockRejectedValue(new Error("network down"));
    rerender(
      <CurriculumThread
        client={{ postGuide: preStream, createProposal: vi.fn() }}
        sourceId="author-window"
        clean
        recovery={false}
        onProvider={onProvider}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "Network" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    await screen.findByText(/connection interrupted/i);
    expect(onProvider).not.toHaveBeenCalledWith("provider_error");
    expect(screen.getByRole("button", { name: "Ask teacher" })).toBeEnabled();
  });

  it.each([400, 403, 404, 409])(
    "drops an unavailable candidate (%i) without creating a proposal card",
    async (status) => {
      const postGuide = vi
        .fn()
        .mockImplementation((body) =>
          Promise.resolve(response(completed(body.threadId, body.runId, true))),
        );
      const onProposal = vi.fn();
      render(
        <CurriculumThread
          client={{
            postGuide,
            createProposal: vi.fn().mockRejectedValue({ status }),
          }}
          sourceId="author-window"
          clean
          recovery={false}
          onProvider={vi.fn()}
          onProposal={onProposal}
          onRefresh={vi.fn().mockResolvedValue({ committed: true })}
        />,
      );
      fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
        target: { value: "Persist candidate" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Save suggested change" }),
      );
      await screen.findByText(
        /suggested change (is unavailable|could not be saved)/i,
      );
      expect(
        screen.queryByRole("button", { name: "Save suggested change" }),
      ).toBeNull();
      expect(onProposal).not.toHaveBeenCalled();
    },
  );

  it("interrupts partial text and clears prior candidate authority on recovery", async () => {
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const postGuide = vi.fn().mockImplementation((body) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: body.threadId, runId: body.runId })}\n\ndata: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","messageId":"assistant","delta":"Partial"}\n\n`,
                ),
              );
            },
          }),
        ),
      ),
    );
    const { rerender } = render(
      <CurriculumThread
        client={{ postGuide, createProposal: vi.fn() }}
        sourceId="author-window"
        clean
        recovery={false}
        onProvider={vi.fn()}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "Partial run" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    const partial = await screen.findByText("Partial");
    expect(partial).toHaveAttribute("data-state", "streaming");
    rerender(
      <CurriculumThread
        client={{ postGuide, createProposal: vi.fn() }}
        sourceId="author-window"
        clean
        recovery
        onProvider={vi.fn()}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    expect(screen.getByText("Partial")).toHaveAttribute(
      "data-state",
      "interrupted",
    );
    expect(streamController).toBeDefined();
  });

  it("aborts pending candidate persistence and does not revive it after reconnect", async () => {
    const postGuide = vi
      .fn()
      .mockImplementation((body) =>
        Promise.resolve(response(completed(body.threadId, body.runId, true))),
      );
    let candidateSignal: AbortSignal | undefined;
    const createProposal = vi.fn().mockImplementation(
      (_id, signal) =>
        new Promise((resolve) => {
          candidateSignal = signal;
        }),
    );
    const { rerender } = render(
      <CurriculumThread
        client={{ postGuide, createProposal }}
        sourceId="author-window"
        clean
        recovery={false}
        onProvider={vi.fn()}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "Candidate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save suggested change" }),
    );
    await waitFor(() => expect(candidateSignal).toBeDefined());
    rerender(
      <CurriculumThread
        client={{ postGuide, createProposal }}
        sourceId="author-window"
        clean
        recovery
        onProvider={vi.fn()}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    expect(candidateSignal?.aborted).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Save suggested change" }),
    ).toBeNull();
    rerender(
      <CurriculumThread
        client={{ postGuide, createProposal }}
        sourceId="author-window"
        clean
        recovery={false}
        onProvider={vi.fn()}
        onProposal={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Save suggested change" }),
    ).toBeNull();
  });
});

it("confirms the exact saved activity before edit_learning and keeps its captured scope through navigation", async () => {
  let confirm: (() => void) | undefined;
  const confirmActivity = vi.fn().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        confirm = resolve;
      }),
  );
  const postGuide = vi.fn().mockImplementation((body) =>
    Promise.resolve(
      response(
        (() => {
          const wire = completed(body.threadId, body.runId, true);
          const boundary = wire.indexOf("\n\n") + 2;
          return (
            wire.slice(0, boundary) +
            `data: ${JSON.stringify({ type: "CUSTOM", name: "courseweave.turn_context", value: { version: "turn-context-v1", module_id: "m", phase_id: "p", surface_id: null, source_id: body.forwardedProps.source_id, manifest_etag: '"etag"', state_revision: 1, consent: false, teacher_mode: "curriculum_designer", policy: null, lesson_scope_id: null, privacy_epoch: 0, run_id: body.runId, evidence_dependency: "a".repeat(64), evidence_references: [], assistant_name: "Course assistant", lesson: {}, workspace_share: null } })}\n\n` +
            wire.slice(boundary)
          );
        })(),
      ),
    ),
  );
  const props = {
    client: { postGuide, createProposal: vi.fn(), confirmActivity },
    sourceId: "author-window",
    clean: true,
    recovery: false,
    onProvider: vi.fn(),
    onProposal: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue({ committed: true }),
  };
  const view = render(
    <CurriculumThread
      {...props}
      selection={{
        module_id: "m",
        phase_id: "p",
        title: "Saved activity",
        manifest_etag: '"etag"',
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
    target: { value: "Improve objectives" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Improve selected activity Learning" }),
  );
  await waitFor(() => expect(confirmActivity).toHaveBeenCalledOnce());
  expect(postGuide).not.toHaveBeenCalled();
  expect(confirmActivity.mock.calls[0]![0]).toMatchObject({
    module_id: "m",
    phase_id: "p",
    manifest_etag: '"etag"',
    sequence: 1,
    source_id: expect.stringMatching(/^author-learning-/),
  });
  view.rerender(
    <CurriculumThread
      {...props}
      selection={{
        module_id: "m",
        phase_id: "other",
        title: "Other activity",
        manifest_etag: '"etag"',
      }}
    />,
  );
  confirm!();
  await waitFor(() => expect(postGuide).toHaveBeenCalledOnce());
  expect(postGuide.mock.calls[0]![0].forwardedProps).toEqual({
    source_id: confirmActivity.mock.calls[0]![0].source_id,
    action: "edit_learning",
  });
  expect(
    await screen.findByText("Learning for Saved activity"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save suggested change" }),
  ).toBeEnabled();
});
it("keeps the request unsent when saved selection confirmation fails", async () => {
  const postGuide = vi.fn();
  render(
    <CurriculumThread
      client={{
        postGuide,
        createProposal: vi.fn(),
        confirmActivity: vi
          .fn()
          .mockRejectedValue(
            Object.assign(
              new Error(
                "The saved course changed. Reload before asking again.",
              ),
              { code: "context_changed" },
            ),
          ),
      }}
      sourceId="author-window"
      clean
      recovery={false}
      selection={{
        module_id: "m",
        phase_id: "p",
        title: "Saved activity",
        manifest_etag: '"etag"',
      }}
      onProvider={vi.fn()}
      onProposal={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
    target: { value: "Improve objectives" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Improve selected activity Learning" }),
  );
  expect(await screen.findByText(/saved course changed/i)).toBeInTheDocument();
  expect(postGuide).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Ask the curriculum teacher")).toHaveValue(
    "Improve objectives",
  );
});

it("withholds selected Learning candidates when the accepted context is missing or has a different byte ETag", async () => {
  for (const metadata of [
    null,
    {
      version: "turn-context-v1",
      module_id: "m",
      phase_id: "p",
      surface_id: null,
      source_id: "placeholder",
      manifest_etag: '"changed"',
      state_revision: 1,
      consent: false,
      teacher_mode: "curriculum_designer",
      policy: null,
      lesson_scope_id: null,
      privacy_epoch: 0,
      run_id: "placeholder",
      evidence_dependency: "a".repeat(64),
      evidence_references: [],
      assistant_name: "Course assistant",
      lesson: {},
      workspace_share: null,
    },
  ]) {
    const postGuide = vi.fn().mockImplementation((body) => {
      let wire = completed(body.threadId, body.runId, true);
      if (metadata) {
        const event = `data: ${JSON.stringify({ type: "CUSTOM", name: "courseweave.turn_context", value: { ...metadata, run_id: body.runId, source_id: body.forwardedProps.source_id } })}\n\n`;
        const boundary = wire.indexOf("\n\n") + 2;
        wire = wire.slice(0, boundary) + event + wire.slice(boundary);
      }
      return Promise.resolve(response(wire));
    });
    render(
      <CurriculumThread
        client={{
          postGuide,
          createProposal: vi.fn(),
          confirmActivity: vi.fn().mockResolvedValue(undefined),
        }}
        sourceId="author"
        clean
        recovery={false}
        selection={{
          module_id: "m",
          phase_id: "p",
          title: "Selected",
          manifest_etag: '"saved"',
        }}
        onProvider={vi.fn()}
        onProposal={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "Improve" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Improve selected activity Learning",
      }),
    );
    expect(
      await screen.findByText(/saved course changed/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save suggested change" }),
    ).not.toBeInTheDocument();
    cleanup();
  }
});

it("retries the captured selected activity instead of silently switching to full-course drafting", async () => {
  const confirmActivity = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("changed"), { code: "context_changed" }),
    );
  const postGuide = vi.fn();
  const props = {
    client: { confirmActivity, postGuide, createProposal: vi.fn() },
    sourceId: "author",
    clean: true,
    recovery: false,
    onProvider: vi.fn(),
    onProposal: vi.fn(),
    onRefresh: vi.fn(),
  };
  const view = render(
    <CurriculumThread
      {...props}
      selection={{
        module_id: "m",
        phase_id: "original",
        title: "Original",
        manifest_etag: '"saved"',
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
    target: { value: "Improve" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Improve selected activity Learning" }),
  );
  await screen.findByText(/saved course changed/i);
  view.rerender(
    <CurriculumThread
      {...props}
      selection={{
        module_id: "m",
        phase_id: "other",
        title: "Other",
        manifest_etag: '"saved"',
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(confirmActivity).toHaveBeenCalledTimes(2));
  expect(confirmActivity.mock.calls[1]![0]).toMatchObject({
    module_id: "m",
    phase_id: "original",
    sequence: 2,
    manifest_etag: '"saved"',
  });
  expect(postGuide).not.toHaveBeenCalled();
});
