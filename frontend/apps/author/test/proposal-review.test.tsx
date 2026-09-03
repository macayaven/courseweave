import { afterEach, describe, expect, it, vi } from "vitest";
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
        onRefresh={vi.fn().mockResolvedValue(true)}
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
    const onRefresh = vi.fn().mockResolvedValue(true);
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
      <ProposalReview proposals={[proposal]} savedRaw={savedRaw} savedEtag={savedEtag} client={client} clean={false} recovery={false} savePending={false} onRefresh={vi.fn()} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />,
    );
    expect(await screen.findByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/saved manifest/i);
    rerender(<ProposalReview proposals={[proposal]} savedRaw={savedRaw} savedEtag={savedEtag} client={client} clean recovery savePending={false} onRefresh={vi.fn()} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    rerender(<ProposalReview proposals={[{ ...proposal, status: "superseded" as const }]} savedRaw={savedRaw} savedEtag={savedEtag} client={client} clean recovery={false} savePending={false} onRefresh={vi.fn()} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("retains the edit and requests authoritative conflict review on a 409", async () => {
    const editProposal = vi.fn().mockRejectedValue({ status: 409 });
    const onConflict = vi.fn();
    render(
      <ProposalReview proposals={[proposal]} savedRaw={savedRaw} savedEtag={savedEtag} client={{ validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }), editProposal, acceptProposal: vi.fn(), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue(true)} onProposal={vi.fn()} onConflict={onConflict} onAcceptedCourse={vi.fn()} />,
    );
    fireEvent.change(await screen.findByLabelText("Edit full manifest"), { target: { value: "{\n  \"schema_version\": 1\n}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save proposal edit" }));
    await screen.findByText(/Proposal changed; review refreshed proposals/i);
    expect(screen.getByLabelText("Edit full manifest")).toHaveValue("{\n  \"schema_version\": 1\n}");
    expect(onConflict).toHaveBeenCalled();
  });

  it("retains a successful Accept as durable when refresh is unavailable", async () => {
    const onProposal = vi.fn();
    render(<ProposalReview proposals={[proposal]} savedRaw={savedRaw} savedEtag={savedEtag} client={{ validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }), editProposal: vi.fn(), acceptProposal: vi.fn().mockResolvedValue({ ...proposal, status: "accepted" }), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue(false)} onProposal={onProposal} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await screen.findByText(/proposal saved, refresh unavailable/i);
    expect(onProposal).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted" }));
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
      <ProposalReview proposals={[proposal, decoy]} savedRaw={savedRaw} savedEtag={savedEtag} client={{ validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }), editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue(true)} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />,
    );
    await screen.findByText("Improve the sequence");
    expect(screen.queryByText("profile-decoy")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(1);
    rerender(<ProposalReview proposals={[{ ...proposal, target_hash: "b".repeat(64) }]} savedRaw={savedRaw} savedEtag={savedEtag} client={{ validateCourse: vi.fn().mockResolvedValue({ formatted_json: "{}\n" }), editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue(true)} onProposal={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
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

  it("preserves a draft created during Accept when refreshed course authority changes", async () => {
    app.getCourse.mockReset(); app.getProposals.mockReset(); app.validateCourse.mockReset(); app.acceptProposal.mockReset();
    const remote = { ...proposal.payload.manifest, title: "Remote accepted title" };
    let resolveAccept: ((value: unknown) => void) | undefined;
    app.runtime.mockReturnValue({ status: "ready", runtime: { serviceOrigin: "https://course.test", capabilityToken: "token", sourceId: "author" }, retry: app.retry });
    app.getCourse.mockResolvedValueOnce({ manifest: proposal.payload.manifest, raw: savedRaw, etag: savedEtag }).mockResolvedValueOnce({ manifest: remote, raw: '{\n  "title": "Remote accepted title"\n}\n', etag: `"${"b".repeat(64)}"` });
    app.getProposals.mockResolvedValueOnce([proposal]).mockRejectedValueOnce(new Error("proposal refresh unavailable"));
    app.validateCourse.mockResolvedValue({ formatted_json: "{}\n" });
    app.acceptProposal.mockImplementation(() => new Promise((resolve) => { resolveAccept = resolve; }));
    render(<AuthorApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    fireEvent.change(screen.getByLabelText("Course title"), { target: { value: "Dirty while accept" } });
    resolveAccept?.({ ...proposal, status: "accepted" });
    await screen.findByText(/remote version changed/i);
    expect(screen.getByLabelText("Course title")).toHaveValue("Dirty while accept");
  });

  it("blocks Ask, Save, and later proposal decisions when Accept cannot reacquire the course", async () => {
    const second = { ...proposal, id: "proposal-b", summary: "Second proposal", revision: 1 };
    const initial = { manifest: proposal.payload.manifest, raw: savedRaw, etag: savedEtag };
    app.getCourse.mockReset(); app.getProposals.mockReset(); app.validateCourse.mockReset(); app.acceptProposal.mockReset(); app.putCourse.mockReset();
    app.runtime.mockReturnValue({ status: "ready", runtime: { serviceOrigin: "https://course.test", capabilityToken: "token", sourceId: "author" }, retry: app.retry });
    app.getCourse.mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("course refresh unavailable"));
    app.getProposals.mockResolvedValueOnce([proposal, second]).mockResolvedValueOnce([{ ...proposal, status: "accepted" }, second]);
    app.validateCourse.mockResolvedValue({ formatted_json: "{}\n" });
    app.acceptProposal.mockResolvedValue({ ...proposal, status: "accepted" });
    render(<AuthorApp />);
    await screen.findByText("Second proposal");
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0]!);
    await screen.findByText(/refresh unavailable; reconnect\/review/i);
    fireEvent.change(screen.getByLabelText("Ask the curriculum teacher"), { target: { value: "Do not send" } });
    expect(screen.getByRole("button", { name: "Ask teacher" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save course" })).toBeDisabled();
    const secondAccept = screen.getByRole("button", { name: "Accept" });
    expect(secondAccept).toBeDisabled();
    fireEvent.click(secondAccept);
    expect(app.acceptProposal).toHaveBeenCalledOnce();
    expect(screen.queryByText(/accepted proposal refreshed/i)).toBeNull();
  });
});
