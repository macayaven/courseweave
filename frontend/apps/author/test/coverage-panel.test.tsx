import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CoveragePanel } from "../src/coverage-panel";

afterEach(cleanup);
it("shows authored objective links and missing guidance without inventing progress or mastery", async () => {
  const client = { getCoverage: vi.fn().mockResolvedValue({ course_id: "course", manifest_sha256: "hash", total_activities: 2, next_offset: null,
    unassigned_reviews: ["course-wide"], notice: "Coverage does not certify mastery or change progress.", activities: [
      { module_id: "module", module_title: "Module", phase_id: "read", title: "Read and predict", progress: "required", overview: "Compare results.",
        completion_prompts: [{ id: "prediction", prompt: "Record a prediction." }], declared_sources: [{ id: "reference", label: "Reference", url: "https://example.org/" }],
        objectives: [{ id: "sequence", text: "Distinguish prediction and observation.", hints: [{ id: "first", text: "Which happens before execution?" }],
          checks: [{ id: "order", prompt: "Which comes first?" }], reviewed_support: [], guidance: ["No accepted evidence link."] }],
        review_ids: [], review_gaps: [], guidance: [] },
      { module_id: "module", module_title: "Module", phase_id: "protocol", title: "Unaided protocol", progress: "optional", overview: "",
        completion_prompts: [], declared_sources: [], objectives: [], review_ids: [], review_gaps: [], guidance: ["No authored objective metadata."] },
    ] }) };
  const onOpenReview = vi.fn();
  render(<CoveragePanel client={client} disabled={false} onOpenReview={onOpenReview} />);
  expect(client.getCoverage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Inspect coverage" }));
  await screen.findByText("Distinguish prediction and observation.");
  expect(screen.getByText("Record a prediction.")).toBeInTheDocument();
  expect(screen.getByText("No authored objective metadata.")).toBeInTheDocument();
  expect(screen.getByText("optional")).toBeInTheDocument();
  expect(screen.getByText("Coverage does not certify mastery or change progress.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open unassigned review course-wide" }));
  await waitFor(() => expect(onOpenReview).toHaveBeenCalledWith("course-wide"));
});
