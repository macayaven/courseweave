import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const app = vi.hoisted(() => ({
  getCourse: vi.fn(), getProposals: vi.fn(), validateCourse: vi.fn(), putCourse: vi.fn(),
  postGuide: vi.fn(), createProposal: vi.fn(), editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn(),
  runtime: vi.fn(), retry: vi.fn(),
}));
vi.mock("../src/api", () => ({
  createAuthorClient: () => ({ getCourse: app.getCourse, getProposals: app.getProposals, validateCourse: app.validateCourse, putCourse: app.putCourse, postGuide: app.postGuide, createProposal: app.createProposal, editProposal: app.editProposal, acceptProposal: app.acceptProposal, rejectProposal: app.rejectProposal }),
  AuthorApiError: class AuthorApiError extends Error {},
}));
vi.mock("../src/runtime", () => ({ useAuthorRuntime: app.runtime }));
import { ProposalReview } from "../src/proposal-review";
import { AuthorApp } from "../src/app";

const proposal = {
  id: "proposal-a",
  revision: 4,
  type: "manifest_replace",
  origin: "teacher_suggested",
  status: "pending" as const,
  summary: "Improve the sequence",
  created_at: "2026-09-01T00:00:00Z",
  target: "courseweave.json",
  payload: {
    manifest: {
      schema_version: 1,
      id: "course",
      title: "Suggested title",
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
    },
  },
  target_hash: "a".repeat(64),
  result: null,
};

const readyRuntime = {
  status: "ready" as const,
  runtime: {
    serviceOrigin: "https://course.test",
    capabilityToken: "token",
    sourceId: "author",
  },
  retry: app.retry,
};

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

const candidateResponse = (threadId: string, runId: string) =>
  `data: ${JSON.stringify({ type: "RUN_STARTED", threadId, runId })}\n\n` +
  `data: {"type":"TEXT_MESSAGE_START","messageId":"assistant"}\n\n` +
  `data: {"type":"TEXT_MESSAGE_END","messageId":"assistant"}\n\n` +
  `data: {"type":"CUSTOM","name":"courseweave.proposal_candidate","value":{"candidate":{"id":"candidate-a","type":"manifest_replace","origin":"teacher_suggested","summary":"Improve course","target":"courseweave.json","payload":{"manifest":{"schema_version":1}},"target_hash":null}}}\n\n` +
  `data: ${JSON.stringify({ type: "RUN_FINISHED", threadId, runId })}\n\n`;

beforeEach(() => {
  app.getCourse.mockReset();
  app.getProposals.mockReset();
  app.validateCourse.mockReset();
  app.putCourse.mockReset();
  app.postGuide.mockReset();
  app.createProposal.mockReset();
  app.editProposal.mockReset();
  app.acceptProposal.mockReset();
  app.rejectProposal.mockReset();
  app.runtime.mockReset();
  app.retry.mockReset();
  app.runtime.mockReturnValue(readyRuntime);
  app.getProposals.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("ProposalReview", () => {
  const savedRaw = '{\n  "title": "Old title"\n}\n';
  const savedEtag = `"${"a".repeat(64)}"`;

  it("renders canonical current target data and a derived text diff with its exact revision", async () => {
    const validateCourse = vi.fn().mockResolvedValue({
      manifest: proposal.payload.manifest,
      formatted_json: '{\n  "title": "Suggested title"\n}\n',
    });
    render(
      <ProposalReview
        proposals={[proposal]}
        savedRaw={savedRaw}
        savedEtag={savedEtag}
        client={{ validateCourse, editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() }}
        clean
        recovery={false}
        savePending={false}
        onRefresh={vi.fn().mockResolvedValue({ committed: true })}
        onProposal={vi.fn()}
        onConflict={vi.fn()}
        onAcceptedCourse={vi.fn()}
      />,
    );
    await screen.findByText("Pending revision: 4");
    expect(screen.getAllByText(/Old title/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Suggested title/).length).toBeGreaterThan(0);
    expect(
      Array.from(document.querySelectorAll("pre")).some(
        (node) => node.textContent?.includes("- {") && node.textContent.includes("+ {") ,
      ),
    ).toBe(true);
  });

  it("validates an edited full replacement before REST Edit and refreshes after it", async () => {
    const validateCourse = vi.fn().mockResolvedValue({ manifest: proposal.payload.manifest, formatted_json: "{}\n" });
    const editProposal = vi.fn().mockResolvedValue({ ...proposal, revision: 5 });
    const onRefresh = vi.fn().mockResolvedValue({ committed: true });
    render(
      <ProposalReview proposals={[proposal]} savedRaw={savedRaw} savedEtag={savedEtag} client={{ validateCourse, editProposal, acceptProposal: vi.fn(), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={onRefresh} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />,
    );
    fireEvent.change(await screen.findByLabelText("Edit full manifest"), {
      target: { value: JSON.stringify(proposal.payload.manifest) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save proposal edit" }));
    await waitFor(() => expect(editProposal).toHaveBeenCalledOnce());
    expect(validateCourse).toHaveBeenCalledWith(proposal.payload.manifest, expect.any(AbortSignal));
    expect(editProposal).toHaveBeenCalledWith(
      "proposal-a",
      {
        expected_revision: 4,
        request: {
          payload: { manifest: proposal.payload.manifest },
          target_hash: proposal.target_hash,
        },
      },
      expect.any(AbortSignal),
    );
    expect(onRefresh).toHaveBeenCalled();
  });

  it("blocks destructive actions for a dirty draft, recovery, and direct Save; superseded revisions are inert", async () => {
    const client = { validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }), editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() };
    const { rerender } = render(
      <ProposalReview proposals={[proposal]} savedRaw={savedRaw} savedEtag={savedEtag} client={client} clean={false} recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue({ committed: false })} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />,
    );
    expect(await screen.findByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/saved manifest/i);
    rerender(<ProposalReview proposals={[proposal]} savedRaw={savedRaw} savedEtag={savedEtag} client={client} clean recovery savePending={false} onRefresh={vi.fn().mockResolvedValue({ committed: false })} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    rerender(<ProposalReview proposals={[{ ...proposal, status: "superseded" as const }]} savedRaw={savedRaw} savedEtag={savedEtag} client={client} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue({ committed: false })} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("retains the edit and requests authoritative conflict review on a 409", async () => {
    const editProposal = vi.fn().mockRejectedValue({ status: 409 });
    const onConflict = vi.fn();
    render(
      <ProposalReview proposals={[proposal]} savedRaw={savedRaw} savedEtag={savedEtag} client={{ validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }), editProposal, acceptProposal: vi.fn(), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue({ committed: true })} onProposal={vi.fn()} onConflict={onConflict} onAcceptedCourse={vi.fn()} />,
    );
    fireEvent.change(await screen.findByLabelText("Edit full manifest"), { target: { value: "{\n  \"schema_version\": 1\n}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save proposal edit" }));
    await screen.findByText(/Proposal changed; review refreshed proposals/i);
    expect(screen.getByLabelText("Edit full manifest")).toHaveValue("{\n  \"schema_version\": 1\n}");
    expect(onConflict).toHaveBeenCalled();
  });

  it("retains a successful Accept as durable when refresh is unavailable", async () => {
    const onProposal = vi.fn();
    render(<ProposalReview proposals={[proposal]} savedRaw={savedRaw} savedEtag={savedEtag} client={{ validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }), editProposal: vi.fn(), acceptProposal: vi.fn().mockResolvedValue({ ...proposal, status: "accepted" }), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue({ committed: false })} onProposal={onProposal} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await screen.findByText(/proposal saved, refresh unavailable/i);
    expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted" }));
  });

  it("restores keyboard focus within the reviewed proposal after Reject refreshes it", async () => {
    const rejected = { ...proposal, status: "rejected" as const };
    const rejectProposal = vi.fn().mockResolvedValue(rejected);
    const client = {
      validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }),
      editProposal: vi.fn(),
      acceptProposal: vi.fn(),
      rejectProposal,
    };
    let view: ReturnType<typeof render>;
    const renderReview = (reviewedProposal: typeof proposal | typeof rejected = proposal) => (
      <ProposalReview
        proposals={[reviewedProposal]}
        savedRaw={savedRaw}
        savedEtag={savedEtag}
        client={client}
        clean
        recovery={false}
        savePending={false}
        onRefresh={onRefresh}
        onProposal={vi.fn()}
        onConflict={vi.fn()}
        onAcceptedCourse={vi.fn()}
      />
    );
    const onRefresh = vi.fn().mockImplementation(async () => {
      view.rerender(renderReview(rejected));
      return { committed: true };
    });
    view = render(renderReview());
    const reject = await screen.findByRole("button", { name: "Reject" });

    reject.focus();
    expect(reject).toHaveFocus();
    fireEvent.click(reject);

    await screen.findByText("Status: rejected");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Improve the sequence" })).toHaveFocus(),
    );
    expect(rejectProposal).toHaveBeenCalledOnce();
  });

  it("omits global decoy proposals and marks a changed target stale", async () => {
    const decoy = {
      ...proposal,
      id: "profile-decoy",
      type: "profile_patch",
      target: "profile",
      payload: { changes: { goal: "x" }, manifest: proposal.payload.manifest },
    };
    const { rerender } = render(
      <ProposalReview proposals={[proposal, decoy]} savedRaw={savedRaw} savedEtag={savedEtag} client={{ validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }), editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue({ committed: true })} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />,
    );
    await screen.findByText("Improve the sequence");
    expect(screen.queryByText("profile-decoy")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(1);
    rerender(<ProposalReview proposals={[{ ...proposal, target_hash: "b".repeat(64) }]} savedRaw={savedRaw} savedEtag={savedEtag} client={{ validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }), editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue({ committed: true })} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
    await screen.findByText(/target no longer matches/i);
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("keeps a profile-patch decoy out of the AuthorApp action surface", async () => {
    app.runtime.mockReturnValue({ status: "ready", runtime: { serviceOrigin: "https://course.test", capabilityToken: "token", sourceId: "author" }, retry: app.retry });
    app.getCourse.mockResolvedValue({ manifest: proposal.payload.manifest, raw: savedRaw, etag: savedEtag });
    app.getProposals.mockResolvedValue([{ ...proposal }, { ...proposal, id: "profile-decoy", type: "profile_patch", target: "profile", summary: "Profile decoy", payload: { changes: { goal: "x" }, manifest: proposal.payload.manifest } }]);
    app.validateCourse.mockResolvedValue({ formatted_json: "{}\n" });
    app.acceptProposal.mockResolvedValue({ ...proposal, status: "accepted" });
    render(<AuthorApp />);
    await screen.findByText("Improve the sequence");
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(1));
    expect(screen.queryByText("Profile decoy")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(app.acceptProposal).toHaveBeenCalledWith("proposal-a", { expected_revision: 4 }, expect.any(AbortSignal)));
    expect(app.acceptProposal).not.toHaveBeenCalledWith("profile-decoy", expect.anything(), expect.anything());
  });

  it("publishes no partial Accept snapshot and commits a later complete pair into dirty-draft conflict", async () => {
    const remoteManifest = {
      ...proposal.payload.manifest,
      title: "Remote accepted title",
    };
    const remoteRaw = '{\n  "title": "Remote accepted title"\n}\n';
    const remoteProposal = {
      ...proposal,
      id: "proposal-remote",
      revision: 1,
      summary: "Authoritative follow-up",
      target_hash: "b".repeat(64),
    };
    const initial = {
      manifest: proposal.payload.manifest,
      raw: savedRaw,
      etag: savedEtag,
    };
    let resolveAccept: ((value: unknown) => void) | undefined;
    app.getCourse
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({
        manifest: remoteManifest,
        raw: remoteRaw,
        etag: `"${"b".repeat(64)}"`,
      })
      .mockResolvedValueOnce({
        manifest: remoteManifest,
        raw: remoteRaw,
        etag: `"${"b".repeat(64)}"`,
      });
    app.getProposals
      .mockResolvedValueOnce([proposal])
      .mockRejectedValueOnce(new Error("proposal refresh unavailable"))
      .mockResolvedValueOnce([remoteProposal]);
    app.validateCourse.mockImplementation((manifest) =>
      Promise.resolve({
        manifest,
        formatted_json:
          (manifest as { title?: string }).title === "Dirty while accept"
            ? '{\n  "title": "Dirty while accept"\n}\n'
            : "{}\n",
      }),
    );
    app.acceptProposal.mockImplementation(
      () => new Promise((resolve) => { resolveAccept = resolve; }),
    );

    render(<AuthorApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const actionSignal = app.acceptProposal.mock.calls[0]?.[2] as AbortSignal;
    fireEvent.change(screen.getByLabelText("Course title"), {
      target: { value: "Dirty while accept" },
    });
    resolveAccept?.({ ...proposal, status: "accepted" });

    await screen.findByText(/refresh unavailable; reconnect\/review/i);
    expect(screen.queryByText(/accepted proposal refreshed/i)).toBeNull();
    expect(screen.queryByText("Authoritative follow-up")).toBeNull();
    expect(screen.queryByLabelText("Remote conflict")).toBeNull();
    expect(screen.getByLabelText("Course title")).toHaveValue("Dirty while accept");
    expect(app.getCourse).toHaveBeenCalledTimes(2);
    expect(app.getProposals).toHaveBeenCalledTimes(2);
    expect(app.getCourse.mock.calls[1]?.[0]).toBe(actionSignal);
    expect(app.getProposals.mock.calls[1]?.[0]).toBe(actionSignal);
    expect(app.acceptProposal).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Retry authoritative refresh" }));
    expect(await screen.findByLabelText("Remote conflict")).toBeInTheDocument();
    expect(screen.getByText("Authoritative follow-up")).toBeInTheDocument();
    expect(screen.getByLabelText("Course title")).toHaveValue("Dirty while accept");
    expect(
      screen.getByRole("alert", { name: "Remote conflict" }).textContent,
    ).toContain(remoteRaw.trim());
    expect(app.getCourse).toHaveBeenCalledTimes(3);
    expect(app.getProposals).toHaveBeenCalledTimes(3);
    const retryCourseSignal = app.getCourse.mock.calls[2]?.[0] as AbortSignal;
    expect(retryCourseSignal).toBeInstanceOf(AbortSignal);
    expect(retryCourseSignal).not.toBe(actionSignal);
    expect(app.getProposals.mock.calls[2]?.[0]).toBe(retryCourseSignal);
    expect(app.acceptProposal).toHaveBeenCalledOnce();
  });

  it("blocks Ask, Save, and later proposal decisions when Accept cannot reacquire the course", async () => {
    const second = { ...proposal, id: "proposal-b", summary: "Second proposal", revision: 1 };
    const initial = { manifest: proposal.payload.manifest, raw: savedRaw, etag: savedEtag };
    app.getCourse.mockReset(); app.getProposals.mockReset(); app.validateCourse.mockReset(); app.acceptProposal.mockReset(); app.putCourse.mockReset();
    app.runtime.mockReturnValue({ status: "ready", runtime: { serviceOrigin: "https://course.test", capabilityToken: "token", sourceId: "author" }, retry: app.retry });
    app.getCourse.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("course refresh unavailable")).mockResolvedValueOnce(initial);
    app.getProposals.mockResolvedValueOnce([proposal, second]).mockResolvedValueOnce([{ ...proposal, status: "accepted" }, second]).mockResolvedValueOnce([{ ...proposal, status: "accepted" }, second]);
    app.validateCourse.mockResolvedValue({ formatted_json: "{}\n" });
    app.acceptProposal.mockResolvedValue({ ...proposal, status: "accepted" });
    render(<AuthorApp />);
    await screen.findByText("Second proposal");
    fireEvent.click((await screen.findAllByRole("button", { name: "Accept" }))[0]!);
    await screen.findByText(/refresh unavailable; reconnect\/review/i);
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), { target: { value: "Do not send" } });
    expect(screen.getByRole("button", { name: "Ask teacher" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save course" })).toBeDisabled();
    const secondAccept = screen.getByRole("button", { name: "Accept" });
    expect(secondAccept).toBeDisabled();
    fireEvent.click(secondAccept);
    expect(app.acceptProposal).toHaveBeenCalledOnce();
    expect(screen.queryByText(/accepted proposal refreshed/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry authoritative refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask teacher" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
  });

  it.each(["rejects", "returns a non-array"] as const)(
    "settles a reconnect proposal read that %s to blocked and recovers without losing the draft",
    async (outcome) => {
      const initial = {
        manifest: proposal.payload.manifest,
        raw: savedRaw,
        etag: savedEtag,
      };
      app.getCourse.mockReset().mockResolvedValue(initial);
      app.getProposals.mockReset().mockResolvedValueOnce([]);
      if (outcome === "rejects") {
        app.getProposals.mockRejectedValueOnce(new Error("proposal read failed"));
      } else {
        app.getProposals.mockResolvedValueOnce({ invalid: "not-an-array" });
      }
      app.getProposals.mockResolvedValueOnce([]);

      const view = render(<AuthorApp />);
      await waitFor(() => expect(app.getProposals).toHaveBeenCalledOnce());
      fireEvent.change(screen.getByLabelText("Course title"), {
        target: { value: "Retained reconnect draft" },
      });
      app.runtime.mockReturnValue({
        status: "disconnected",
        runtime: null,
        retry: app.retry,
      });
      view.rerender(<AuthorApp />);
      app.runtime.mockReturnValue({
        ...readyRuntime,
        runtime: {
          ...readyRuntime.runtime,
          capabilityToken: `fresh-${outcome}`,
          sourceId: `author-${outcome}`,
        },
      });
      view.rerender(<AuthorApp />);

      const retry = await screen.findByRole("button", {
        name: "Retry authoritative refresh",
      });
      await waitFor(() => expect(retry).toBeEnabled());
      expect(screen.getByRole("button", { name: "Save course" })).toBeDisabled();
      expect(screen.getByLabelText("Course title")).toHaveValue(
        "Retained reconnect draft",
      );
      expect(app.getCourse).toHaveBeenCalledTimes(2);
      expect(app.getProposals).toHaveBeenCalledTimes(2);
      expect(app.getCourse.mock.calls[1]?.[0]).toBeInstanceOf(AbortSignal);
      expect(app.getProposals.mock.calls[1]?.[0]).toBeInstanceOf(AbortSignal);

      fireEvent.click(retry);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save course" })).toBeEnabled(),
      );
      expect(screen.queryByLabelText("Authority recovery")).toBeNull();
      expect(screen.getByLabelText("Course title")).toHaveValue(
        "Retained reconnect draft",
      );
      expect(app.getCourse).toHaveBeenCalledTimes(3);
      expect(app.getProposals).toHaveBeenCalledTimes(3);
      const retrySignal = app.getCourse.mock.calls[2]?.[0] as AbortSignal;
      expect(retrySignal).toBeInstanceOf(AbortSignal);
      expect(app.getProposals.mock.calls[2]?.[0]).toBe(retrySignal);
      expect(app.putCourse).not.toHaveBeenCalled();
      expect(app.createProposal).not.toHaveBeenCalled();
      expect(app.acceptProposal).not.toHaveBeenCalled();
    },
  );

  it("blocks and explicitly recovers after a generic candidate completion without replay", async () => {
    const initial = {
      manifest: proposal.payload.manifest,
      raw: savedRaw,
      etag: savedEtag,
    };
    app.getCourse.mockResolvedValue(initial);
    app.getProposals.mockResolvedValue([]);
    app.postGuide.mockImplementation((body) =>
      Promise.resolve(response(candidateResponse(body.threadId, body.runId))),
    );
    app.createProposal.mockRejectedValue(new Error("ambiguous candidate result"));

    render(<AuthorApp />);
    await waitFor(() => expect(app.getProposals).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), {
      target: { value: "Suggest a change" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save suggested change" }),
    );

    const retry = await screen.findByRole("button", {
      name: "Retry authoritative refresh",
    });
    expect(retry).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save course" })).toBeDisabled();
    expect(app.getCourse).toHaveBeenCalledOnce();
    expect(app.getProposals).toHaveBeenCalledOnce();
    expect(app.postGuide).toHaveBeenCalledOnce();
    expect(app.createProposal).toHaveBeenCalledOnce();
    const candidateSignal = app.createProposal.mock.calls[0]?.[1] as AbortSignal;
    expect(candidateSignal).toBeInstanceOf(AbortSignal);
    expect(candidateSignal.aborted).toBe(false);

    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save course" })).toBeEnabled(),
    );
    expect(app.getCourse).toHaveBeenCalledTimes(2);
    expect(app.getProposals).toHaveBeenCalledTimes(2);
    const retrySignal = app.getCourse.mock.calls[1]?.[0] as AbortSignal;
    expect(app.getProposals.mock.calls[1]?.[0]).toBe(retrySignal);
    expect(retrySignal).not.toBe(candidateSignal);
    expect(app.postGuide).toHaveBeenCalledOnce();
    expect(app.createProposal).toHaveBeenCalledOnce();
  });

  it("blocks and explicitly recovers after a generic proposal completion without replay", async () => {
    const initial = {
      manifest: proposal.payload.manifest,
      raw: savedRaw,
      etag: savedEtag,
    };
    app.getCourse.mockResolvedValue(initial);
    app.getProposals.mockResolvedValue([proposal]);
    app.validateCourse.mockResolvedValue({ formatted_json: "{}\n" });
    app.acceptProposal.mockRejectedValue(new Error("ambiguous proposal result"));

    render(<AuthorApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));

    const retry = await screen.findByRole("button", {
      name: "Retry authoritative refresh",
    });
    expect(retry).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save course" })).toBeDisabled();
    expect(app.getCourse).toHaveBeenCalledOnce();
    expect(app.getProposals).toHaveBeenCalledOnce();
    expect(app.acceptProposal).toHaveBeenCalledOnce();
    const mutationSignal = app.acceptProposal.mock.calls[0]?.[2] as AbortSignal;
    expect(mutationSignal).toBeInstanceOf(AbortSignal);
    expect(mutationSignal.aborted).toBe(false);

    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save course" })).toBeEnabled(),
    );
    expect(app.getCourse).toHaveBeenCalledTimes(2);
    expect(app.getProposals).toHaveBeenCalledTimes(2);
    expect(app.getProposals.mock.calls[1]?.[0]).toBe(
      app.getCourse.mock.calls[1]?.[0],
    );
    expect(app.getCourse.mock.calls[1]?.[0]).not.toBe(mutationSignal);
    expect(app.acceptProposal).toHaveBeenCalledOnce();
  });

  it("reblocks when an aborted candidate resolves after reconnect and never replays it", async () => {
    const initial = {
      manifest: proposal.payload.manifest,
      raw: savedRaw,
      etag: savedEtag,
    };
    let resolveCandidate: ((value: unknown) => void) | undefined;
    app.getCourse.mockResolvedValue(initial);
    app.getProposals.mockResolvedValue([]);
    app.postGuide.mockImplementation((body) =>
      Promise.resolve(response(candidateResponse(body.threadId, body.runId))),
    );
    app.createProposal.mockImplementation(
      () => new Promise((resolve) => { resolveCandidate = resolve; }),
    );

    const view = render(<AuthorApp />);
    fireEvent.change(await screen.findByLabelText("Ask the curriculum teacher"), {
      target: { value: "Persist then disconnect" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask teacher" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Save suggested change" }),
    );
    await waitFor(() => expect(app.createProposal).toHaveBeenCalledOnce());
    const mutationSignal = app.createProposal.mock.calls[0]?.[1] as AbortSignal;
    fireEvent.change(screen.getByLabelText("Course title"), {
      target: { value: "Retained candidate draft" },
    });
    app.runtime.mockReturnValue({
      status: "disconnected",
      runtime: null,
      retry: app.retry,
    });
    view.rerender(<AuthorApp />);
    expect(mutationSignal.aborted).toBe(true);
    app.runtime.mockReturnValue({
      ...readyRuntime,
      runtime: {
        ...readyRuntime.runtime,
        capabilityToken: "fresh-candidate",
        sourceId: "author-candidate",
      },
    });
    view.rerender(<AuthorApp />);
    await waitFor(() => expect(app.getCourse).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(app.getProposals).toHaveBeenCalledTimes(2));

    resolveCandidate?.({ id: "proposal-late" });
    const retry = await screen.findByRole("button", {
      name: "Retry authoritative refresh",
    });
    expect(retry).toBeEnabled();
    expect(screen.getByLabelText("Course title")).toHaveValue(
      "Retained candidate draft",
    );
    expect(app.getCourse).toHaveBeenCalledTimes(2);
    expect(app.getProposals).toHaveBeenCalledTimes(2);
    expect(app.createProposal).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Save suggested change" })).toBeNull();

    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save course" })).toBeEnabled(),
    );
    expect(app.getCourse).toHaveBeenCalledTimes(3);
    expect(app.getProposals).toHaveBeenCalledTimes(3);
    expect(app.createProposal).toHaveBeenCalledOnce();
    expect(app.postGuide).toHaveBeenCalledOnce();
  });

  it("reblocks when an aborted proposal resolves after reconnect and never replays it", async () => {
    const initial = {
      manifest: proposal.payload.manifest,
      raw: savedRaw,
      etag: savedEtag,
    };
    let resolveAccept: ((value: unknown) => void) | undefined;
    app.getCourse.mockResolvedValue(initial);
    app.getProposals.mockResolvedValue([proposal]);
    app.validateCourse.mockResolvedValue({ formatted_json: "{}\n" });
    app.acceptProposal.mockImplementation(
      () => new Promise((resolve) => { resolveAccept = resolve; }),
    );

    const view = render(<AuthorApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const mutationSignal = app.acceptProposal.mock.calls[0]?.[2] as AbortSignal;
    fireEvent.change(screen.getByLabelText("Course title"), {
      target: { value: "Retained proposal draft" },
    });
    app.runtime.mockReturnValue({
      status: "disconnected",
      runtime: null,
      retry: app.retry,
    });
    view.rerender(<AuthorApp />);
    expect(mutationSignal.aborted).toBe(true);
    app.runtime.mockReturnValue({
      ...readyRuntime,
      runtime: {
        ...readyRuntime.runtime,
        capabilityToken: "fresh-proposal",
        sourceId: "author-proposal",
      },
    });
    view.rerender(<AuthorApp />);
    await waitFor(() => expect(app.getCourse).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(app.getProposals).toHaveBeenCalledTimes(2));

    resolveAccept?.({ ...proposal, status: "accepted" });
    const retry = await screen.findByRole("button", {
      name: "Retry authoritative refresh",
    });
    expect(retry).toBeEnabled();
    expect(screen.getByLabelText("Course title")).toHaveValue(
      "Retained proposal draft",
    );
    expect(app.getCourse).toHaveBeenCalledTimes(2);
    expect(app.getProposals).toHaveBeenCalledTimes(2);
    expect(app.acceptProposal).toHaveBeenCalledOnce();

    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save course" })).toBeEnabled(),
    );
    expect(app.getCourse).toHaveBeenCalledTimes(3);
    expect(app.getProposals).toHaveBeenCalledTimes(3);
    expect(app.acceptProposal).toHaveBeenCalledOnce();
  });

  it("ignores an old-epoch refresh pair that settles after newer authority", async () => {
    const initial = {
      manifest: proposal.payload.manifest,
      raw: savedRaw,
      etag: savedEtag,
    };
    const staleManifest = {
      ...proposal.payload.manifest,
      title: "Stale old epoch",
    };
    const newestManifest = {
      ...proposal.payload.manifest,
      title: "Newest epoch",
    };
    const staleProposal = { ...proposal, summary: "Stale proposal" };
    const newestProposal = {
      ...proposal,
      id: "proposal-newest",
      summary: "Newest proposal",
      target_hash: "c".repeat(64),
    };
    let resolveOldCourse: ((value: unknown) => void) | undefined;
    let resolveOldProposals: ((value: unknown) => void) | undefined;
    app.getCourse
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveOldCourse = resolve; }),
      )
      .mockResolvedValueOnce({
        manifest: newestManifest,
        raw: '{\n  "title": "Newest epoch"\n}\n',
        etag: `"${"c".repeat(64)}"`,
      });
    app.getProposals
      .mockResolvedValueOnce([proposal])
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveOldProposals = resolve; }),
      )
      .mockResolvedValueOnce([newestProposal]);
    app.validateCourse.mockResolvedValue({ formatted_json: "{}\n" });
    app.acceptProposal.mockResolvedValue({ ...proposal, status: "accepted" });

    const view = render(<AuthorApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await waitFor(() => expect(app.getCourse).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(app.getProposals).toHaveBeenCalledTimes(2));
    const oldSignal = app.getCourse.mock.calls[1]?.[0] as AbortSignal;
    expect(app.getProposals.mock.calls[1]?.[0]).toBe(oldSignal);
    app.runtime.mockReturnValue({
      status: "disconnected",
      runtime: null,
      retry: app.retry,
    });
    view.rerender(<AuthorApp />);
    expect(oldSignal.aborted).toBe(true);
    app.runtime.mockReturnValue({
      ...readyRuntime,
      runtime: {
        ...readyRuntime.runtime,
        capabilityToken: "fresh-epoch",
        sourceId: "author-epoch",
      },
    });
    view.rerender(<AuthorApp />);

    await waitFor(() =>
      expect(screen.getByLabelText("Course title")).toHaveValue("Newest epoch"),
    );
    expect(await screen.findByText("Newest proposal")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save course" })).toBeEnabled(),
    );
    resolveOldCourse?.({
      manifest: staleManifest,
      raw: '{\n  "title": "Stale old epoch"\n}\n',
      etag: `"${"b".repeat(64)}"`,
    });
    resolveOldProposals?.([staleProposal]);
    await waitFor(() => expect(app.acceptProposal).toHaveBeenCalledOnce());
    await Promise.resolve();

    expect(screen.getByLabelText("Course title")).toHaveValue("Newest epoch");
    expect(screen.getByText("Newest proposal")).toBeInTheDocument();
    expect(screen.queryByText("Stale proposal")).toBeNull();
    expect(screen.queryByText(/Stale old epoch/)).toBeNull();
    expect(screen.queryByLabelText("Authority recovery")).toBeNull();
    expect(screen.getByRole("button", { name: "Save course" })).toBeEnabled();
    expect(app.getCourse).toHaveBeenCalledTimes(3);
    expect(app.getProposals).toHaveBeenCalledTimes(3);
    expect(app.acceptProposal).toHaveBeenCalledOnce();
  });
});
