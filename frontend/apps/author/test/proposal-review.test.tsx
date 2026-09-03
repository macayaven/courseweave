import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ProposalReview } from "../src/proposal-review";

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
    diff: "- Old title\n+ Suggested title",
  },
  target_hash: "a".repeat(64),
  result: null,
};

afterEach(() => cleanup());

describe("ProposalReview", () => {
  it("renders authoritative pending REST data as text with its exact revision", () => {
    render(
      <ProposalReview
        proposals={[proposal]}
        savedManifest={{ ...proposal.payload.manifest, title: "Old title" }}
        client={{ validateCourse: vi.fn(), editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() }}
        clean
        recovery={false}
        savePending={false}
        onRefresh={vi.fn()}
        onConflict={vi.fn()}
        onAcceptedCourse={vi.fn()}
      />,
    );
    expect(screen.getByText("Pending revision: 4")).toBeInTheDocument();
    expect(screen.getAllByText(/Old title/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Suggested title/).length).toBeGreaterThan(0);
    expect(
      Array.from(document.querySelectorAll("pre")).some(
        (node) => node.textContent === "- Old title\n+ Suggested title",
      ),
    ).toBe(true);
  });

  it("validates an edited full replacement before REST Edit and refreshes after it", async () => {
    const validateCourse = vi.fn().mockResolvedValue({ manifest: proposal.payload.manifest });
    const editProposal = vi.fn().mockResolvedValue({ ...proposal, revision: 5 });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <ProposalReview proposals={[proposal]} savedManifest={{}} client={{ validateCourse, editProposal, acceptProposal: vi.fn(), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={onRefresh} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Edit full manifest"), {
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

  it("blocks destructive actions for a dirty draft, recovery, and direct Save; superseded revisions are inert", () => {
    const client = { validateCourse: vi.fn(), editProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() };
    const { rerender } = render(
      <ProposalReview proposals={[proposal]} savedManifest={{}} client={client} clean={false} recovery={false} savePending={false} onRefresh={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/saved manifest/i);
    rerender(<ProposalReview proposals={[proposal]} savedManifest={{}} client={client} clean recovery savePending={false} onRefresh={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
    rerender(<ProposalReview proposals={[{ ...proposal, status: "superseded" as const }]} savedManifest={{}} client={client} clean recovery={false} savePending={false} onRefresh={vi.fn()} onConflict={vi.fn()} onAcceptedCourse={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("retains the edit and requests authoritative conflict review on a 409", async () => {
    const editProposal = vi.fn().mockRejectedValue({ status: 409 });
    const onConflict = vi.fn();
    render(
      <ProposalReview proposals={[proposal]} savedManifest={{}} client={{ validateCourse: vi.fn().mockResolvedValue({}), editProposal, acceptProposal: vi.fn(), rejectProposal: vi.fn() }} clean recovery={false} savePending={false} onRefresh={vi.fn().mockResolvedValue(undefined)} onConflict={onConflict} onAcceptedCourse={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Edit full manifest"), { target: { value: "{\n  \"schema_version\": 1\n}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save proposal edit" }));
    await screen.findByText(/Proposal changed; review refreshed proposals/i);
    expect(screen.getByLabelText("Edit full manifest")).toHaveValue("{\n  \"schema_version\": 1\n}");
    expect(onConflict).toHaveBeenCalled();
  });
});
