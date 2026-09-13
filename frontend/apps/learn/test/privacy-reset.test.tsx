import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearnApp } from "../src/app";
import { course, state } from "./fixtures";
const harness = vi.hoisted(() => ({
  version: 0,
  runtime: {
    serviceOrigin: "https://courseweave.test",
    capabilityToken: "synthetic",
    sourceId: "source",
    expectedParentOrigin: "https://lab.test",
  },
  client: {
    getBootstrap: vi.fn(),
    getProposals: vi.fn(),
    getContext: vi.fn(),
    patchState: vi.fn(),
    acceptProposal: vi.fn(),
    rejectProposal: vi.fn(),
    editProposal: vi.fn(),
  },
}));
vi.mock("../src/runtime", () => ({
  useRuntimeBootstrap: () => ({
    status: "ready",
    runtime: harness.runtime,
    contextVersion: harness.version,
    contextPending: false,
    retry: vi.fn(),
  }),
  useParentCapture: () => undefined,
}));
vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createCourseweaveClient: () => harness.client,
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}
const pending = {
  id: "pending",
  revision: 1,
  type: "manifest_replace",
  status: "pending",
  origin: "teacher_suggested",
  summary: "Pending course change",
  payload: { manifest: {} },
  target: "courseweave.json",
  target_hash: null,
  created_at: "2026-09-09",
  result: null,
};
const history = {
  ...pending,
  id: "history",
  summary: "Deleted decision history",
  status: "accepted",
};
beforeEach(() => {
  harness.version = 0;
  Object.values(harness.client).forEach((fn) => fn.mockReset());
});
afterEach(cleanup);
it.each(["reset_state", "delete_state"] as const)(
  "%s atomically retires proposals, stale reads and old action ownership but keeps explicitly unsent edits",
  async (operation) => {
    const manifest = course();
    const before = state();
    const after = state({ revision: 2 });
    harness.client.getBootstrap.mockResolvedValue({ ...before, manifest });
    harness.client.getProposals.mockResolvedValue([pending, history]);
    harness.client.getContext.mockResolvedValue({
      context: { source_id: "source" },
      resolved: {
        module_id: "s01",
        phase_id: "read",
        surface_id: "lesson",
        reason: "explicit_phase",
      },
    });
    harness.client.patchState.mockResolvedValue(after);
    const lateAction = deferred<any>();
    harness.client.acceptProposal.mockReturnValue(lateAction.promise);
    const view = render(<LearnApp />);
    await screen.findByText("Suggested changes (2)");
    fireEvent.click(screen.getByText("Suggested changes (2)"));
    fireEvent.change(screen.getByLabelText("Edit summary"), {
      target: { value: "Keep this unsent edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await vi.waitFor(() =>
      expect(harness.client.acceptProposal).toHaveBeenCalledOnce(),
    );
    const lateRead = deferred<any>();
    harness.client.getBootstrap.mockReturnValueOnce(lateRead.promise);
    harness.version++;
    view.rerender(<LearnApp />);
    await vi.waitFor(() =>
      expect(harness.client.getBootstrap).toHaveBeenCalledTimes(2),
    );
    harness.client.getBootstrap.mockResolvedValue({ ...after, manifest });
    harness.client.getProposals.mockResolvedValue([]);
    fireEvent.click(screen.getByText("Learning memory & preferences"));
    fireEvent.click(
      screen.getByRole("button", {
        name:
          operation === "reset_state"
            ? "Reset learning memory"
            : "Delete saved learning data",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
    await screen.findByText("Saved learning data cleared.");
    await vi.waitFor(() =>
      expect(harness.client.getBootstrap).toHaveBeenCalledTimes(3),
    );
    expect(harness.client.patchState).toHaveBeenCalledWith(
      { expected_revision: 1, operation: { type: operation } },
      expect.any(AbortSignal),
    );
    expect(
      screen.queryByRole("heading", { name: "Pending course change" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Deleted decision history" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Accept" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Unsent edit for pending")).toHaveValue(
      "Keep this unsent edit",
    );
    const readCount = harness.client.getProposals.mock.calls.length;
    await act(async () => {
      lateRead.resolve({ ...state({ revision: 99 }), manifest });
      lateAction.resolve({ ...pending, status: "accepted" });
    });
    expect(harness.client.acceptProposal.mock.calls[0]![2].aborted).toBe(true);
    expect(harness.client.getProposals).toHaveBeenCalledTimes(readCount);
    expect(screen.queryByText("Suggested changes (2)")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reject" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Unsent edit for pending")).toHaveValue(
      "Keep this unsent edit",
    );
  },
);
