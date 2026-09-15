import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewPanel, type ReviewReport } from "../src/review-panel";
import { useState } from "react";

afterEach(cleanup);
export const report: ReviewReport = {
  version: "author-review-v1", report_id: "review-one", project_id: "project", revision: 0,
  context_digest: "a".repeat(64), project_revision: 0, manifest_sha256: "b".repeat(64), prompt_version: "author-assistant-v2",
  context_budget: { max_input_chars: 24000, max_output_chars: 16000 },
  selection: { project_id: "project", course_id: "course", module_id: "module", phase_id: "phase", file_path: "lesson.md", cell_ids: [], manifest_unit: "course" },
  target_path: "lesson.md", target_sha256: "c".repeat(64), target_exists: true, target_fully_visible: true, target_characters: 100,
  role: "fact_checker", summary: "Review of a prediction claim.", status: "current", stale_reasons: [],
  saved_at: "2026-09-15T12:00:00Z", updated_at: "2026-09-15T12:00:00Z", omissions: ["Other files were omitted."],
  compatibility: { scope: "saved_course", student_profile: "0.2.0", manifest_sha256: "b".repeat(64), preliminary_checks_passed: true,
    issues: [{ code: "installed_execution_not_checked", location: "", severity: "not_performed", message: "Installed execution has not been checked." }], omitted_issues: 0, notice: "Preliminary checks." },
  sources: [{ source_id: "source-one", revision: 1, raw_sha256: "d".repeat(64), text_sha256: "e".repeat(64), extractor_version: "text-v1",
    title: "Reference", origin: "https://example.org/ref", imported_at: "2026-09-15T11:00:00Z", publication_date: null,
    retrieved_at: "2026-09-15T11:00:00Z", final_url: "https://example.org/ref", extraction: "text", policy_decision: "allowed", status: "approved", redistribution: "undecided" }],
  findings: [{ claim_id: "prediction", judgment: "supported", explanation: "Prediction precedes execution.", human_disposition: "unreviewed",
    disposition_reason: "", provenance: "located", objective_ids: [], evidence: [{ source_id: "source-one", revision: 1, raw_sha256: "d".repeat(64),
      text_sha256: "e".repeat(64), extractor_version: "text-v1", quote: "Predict before running.", start: 0, end: 23 }] }],
};
const objectives = [{ id: "sequence", text: "Distinguish prediction and observation." }];
function client() {
  return { getReviews: vi.fn().mockResolvedValue({ reports: [report], next_offset: null }), getReview: vi.fn().mockResolvedValue(report),
    updateReviewFinding: vi.fn().mockResolvedValue({ ...report, revision: 1, findings: [{ ...report.findings[0], human_disposition: "dismissed", disposition_reason: "Defined earlier." }] }),
    deleteReview: vi.fn().mockResolvedValue(undefined), exportReview: vi.fn().mockResolvedValue(new Blob(["{}"], { type: "application/json" })) };
}
function props() { return { disabled: false, onDirtyChange: vi.fn(), onChanged: vi.fn(), objectivesFor: () => objectives }; }

it("keeps sibling editing available while a saved-review read is pending", () => {
  const api = client();
  api.getReviews.mockImplementation(() => new Promise(() => undefined));
  function Workspace() {
    const [dirty, setDirty] = useState(false);
    return <><button type="button" disabled={dirty}>Import a reference in another panel</button>
      <ReviewPanel client={api} {...props()} onDirtyChange={setDirty} /></>;
  }
  render(<Workspace />);
  expect(screen.getByRole("button", { name: "Import a reference in another panel" })).toBeEnabled();
});

it("separates model judgment, quotation provenance and human decisions; dismissal needs a reason", async () => {
  const api = client(), options = props();
  render(<ReviewPanel client={api} {...options} />);
  await screen.findByText("Review of a prediction claim.");
  expect(screen.getByText("Model judgment: supported")).toBeInTheDocument();
  expect(screen.getByText("Quotation provenance: located")).toBeInTheDocument();
  expect(screen.getByLabelText("Your disposition")).toHaveValue("unreviewed");
  fireEvent.change(screen.getByLabelText("Your disposition"), { target: { value: "dismissed" } });
  expect(screen.getByRole("button", { name: "Save disposition" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "Defined earlier." } });
  fireEvent.click(screen.getByRole("button", { name: "Save disposition" }));
  await waitFor(() => expect(api.updateReviewFinding).toHaveBeenCalledWith("review-one", "prediction",
    { revision: 0, human_disposition: "dismissed", reason: "Defined earlier.", objective_ids: [] }, expect.any(AbortSignal)));
  await waitFor(() => expect(screen.getByText(/Report revision 1/)).toBeInTheDocument());
  expect(screen.getByText("Model judgment: supported")).toBeInTheDocument();
});

it("requires explicit human objective mapping and retains unsaved notes on a revision conflict", async () => {
  const api = client(); api.updateReviewFinding.mockRejectedValue(new Error("Review revision changed; reload."));
  render(<ReviewPanel client={api} {...props()} />);
  await screen.findByText("Review of a prediction claim.");
  fireEvent.change(screen.getByLabelText("Your disposition"), { target: { value: "accepted" } });
  fireEvent.click(screen.getByLabelText("Link objective sequence"));
  fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: "Keep my note." } });
  fireEvent.click(screen.getByRole("button", { name: "Save disposition" }));
  await screen.findByText("Review revision changed; reload.");
  expect(screen.getByLabelText("Decision reason")).toHaveValue("Keep my note.");
  expect(api.updateReviewFinding.mock.calls[0]?.[2].objective_ids).toEqual(["sequence"]);
  expect(api.getReview).toHaveBeenCalledTimes(1);
});

it("shows stale dependencies and blocks accepting them; export and deletion are explicit", async () => {
  const api = client(); api.getReview.mockResolvedValue({ ...report, status: "stale", stale_reasons: ["Selected target changed."] });
  render(<ReviewPanel client={api} {...props()} />);
  await screen.findByText("Selected target changed.");
  expect(screen.getByRole("option", { name: "Accepted" })).toBeDisabled();
  expect(api.exportReview).not.toHaveBeenCalled(); expect(api.deleteReview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete report" }));
  expect(api.deleteReview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete report" }));
  await waitFor(() => expect(api.deleteReview).toHaveBeenCalledWith("review-one", 0, expect.any(AbortSignal)));
});

it("retains a manually selected report during refresh and can reopen an explicitly requested report", async () => {
  const api = client(), options = props();
  const other = { ...report, report_id: "review-two", summary: "Another review." };
  api.getReviews.mockResolvedValue({ reports: [report, other], next_offset: null });
  api.getReview.mockImplementation(async id => id === other.report_id ? other : report);
  const view = render(<ReviewPanel client={api} {...options} openReportId="review-one" openEpoch={1} epoch={0} />);
  await screen.findByText("Review of a prediction claim.");
  fireEvent.change(screen.getByLabelText("Saved report"), { target: { value: "review-two" } });
  await screen.findByText("Another review.");
  view.rerender(<ReviewPanel client={api} {...options} openReportId="review-one" openEpoch={1} epoch={1} />);
  await waitFor(() => expect(api.getReview).toHaveBeenCalledTimes(3));
  expect(screen.getByText("Another review.")).toBeInTheDocument();
  view.rerender(<ReviewPanel client={api} {...options} openReportId="review-one" openEpoch={2} epoch={1} />);
  await screen.findByText("Review of a prediction claim.");
});
