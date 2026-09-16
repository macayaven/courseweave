import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SourcePanel, SourceExcerpt, type ResearchReport } from "../src/source-panel";

afterEach(cleanup);
const report: ResearchReport = { report_id: "research-one", status: "complete", started_at: "2026-09-15T12:00:00Z", finished_at: "2026-09-15T12:00:01Z",
  request: { network_enabled: true, policy: { mode: "public_web", allow: [], deny: [] }, queries: ["Python validation"], urls: [] },
  results: [{ url: "https://docs.example.org/python", title: "Python docs", snippet: "Discovery only", query: "Python validation", retrieved_at: "2026-09-15T12:00:01Z", publication_date: null, policy_decision: "allowed" },
    { url: "https://denied.example.org/", title: "Outside policy", snippet: "Not supporting evidence", query: "Python validation", retrieved_at: "2026-09-15T12:00:01Z", publication_date: null, policy_decision: "denied" }],
  fetches: [], source_ids: [], notices: [] };
const source = { source_id: "source-one", revision: 0, title: "Local reference", origin: "/local/reference.md", imported_at: "2026-09-15T12:00:00Z",
  publication_date: null, raw_sha256: "hash", text_sha256: "hash", extractor_version: "author-text-v1", extraction: "text", status: "candidate",
  intended_use: "author_reference", redistribution: "undecided", review_note: "", policy_decision: "local" };
function client() {
  return { getResearchStatus: vi.fn().mockResolvedValue({ network_enabled: false, brave_configured: true, active: false, busy: false, notice: "Author account usage applies." }),
    getResearchReports: vi.fn().mockResolvedValue({ reports: [], next_offset: null }), getResearchReport: vi.fn().mockResolvedValue(report),
    runResearch: vi.fn().mockResolvedValue(report), cancelResearch: vi.fn().mockResolvedValue({ status: "cancellation_requested" }),
    importReference: vi.fn().mockResolvedValue(source),
    getSourceText: vi.fn().mockResolvedValue({ source, text: "Exact extracted text", start: 0, end: 20, total_characters: 20, notice: "Offsets refer to retained text." }) };
}

it("keeps networking off until a reviewed explicit action, then requires enabling the next run", async () => {
  const api = client();
  render(<SourcePanel client={api} disabled={false} onBusyChange={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText(/Brave discovery: configured/);
  fireEvent.change(screen.getByLabelText("Search queries"), { target: { value: "Python validation" } });
  fireEvent.change(screen.getByLabelText("Allowed origins and paths"), { target: { value: "https://docs.example.org/python" } });
  expect(api.runResearch).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Discover sources" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("Enable network for this research run"));
  fireEvent.click(screen.getByRole("button", { name: "Discover sources" }));
  await screen.findByText("Python docs");
  expect(api.runResearch).toHaveBeenCalledWith({ network_enabled: true,
    policy: { mode: "allow_only", allow: [{ origin: "https://docs.example.org", path_prefix: "/python" }], deny: [] }, queries: ["Python validation"], urls: [] }, expect.any(AbortSignal));
  expect(screen.getByLabelText("Enable network for this research run")).not.toBeChecked();
  expect(screen.getByLabelText("Select Outside policy")).toBeDisabled();
  fireEvent.click(screen.getByLabelText("Select Python docs"));
  fireEvent.click(screen.getByRole("button", { name: "Use selected URLs" }));
  expect(screen.getByLabelText("Public URLs")).toHaveValue("https://docs.example.org/python");
  expect(api.runResearch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByLabelText("Enable network for this research run"));
  fireEvent.click(screen.getByRole("button", { name: "Fetch entered URLs" }));
  await waitFor(() => expect(api.runResearch).toHaveBeenCalledTimes(2));
  expect(api.runResearch.mock.calls[1]?.[0].queries).toEqual([]);
});

it("keeps transient discovery and selected URLs across a sibling panel refresh", async () => {
  const api = client();
  api.getResearchReports.mockResolvedValue({ reports: [{ report_id: report.report_id, status: report.status,
    started_at: report.started_at, finished_at: report.finished_at }], next_offset: null });
  api.getResearchReport.mockResolvedValue({ ...report, results: [] });
  const props = { client: api, onBusyChange: vi.fn(), onChanged: vi.fn() };
  const view = render(<SourcePanel {...props} disabled={false} />);
  await screen.findByText(/Brave discovery: configured/);
  fireEvent.change(screen.getByLabelText("Search queries"), { target: { value: "Python validation" } });
  fireEvent.change(screen.getByLabelText("Research policy"), { target: { value: "public_web" } });
  fireEvent.click(screen.getByLabelText("Enable network for this research run"));
  fireEvent.click(screen.getByRole("button", { name: "Discover sources" }));
  await screen.findByText("Python docs");
  fireEvent.click(screen.getByLabelText("Select Python docs"));
  await act(async () => view.rerender(<SourcePanel {...props} disabled />));
  await act(async () => view.rerender(<SourcePanel {...props} disabled={false} />));
  expect(screen.getByLabelText("Select Python docs")).toBeChecked();
  expect(screen.getByLabelText("Select Python docs")).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Use selected URLs" }));
  expect(screen.getByLabelText("Public URLs")).toHaveValue("https://docs.example.org/python");
  expect(screen.getByLabelText("Enable network for this research run")).not.toBeChecked();
});

it("allows offline local references and explicit URLs when discovery is unavailable", async () => {
  const api = client();
  api.getResearchStatus.mockResolvedValue({ network_enabled: false, brave_configured: false, active: false, busy: false, notice: "Missing search key." });
  const onChanged = vi.fn();
  render(<SourcePanel client={api} disabled={false} onBusyChange={vi.fn()} onChanged={onChanged} />);
  await screen.findByText(/Brave discovery: unavailable/);
  fireEvent.change(screen.getByLabelText("Local reference file"), { target: { value: "/local/reference.md" } });
  fireEvent.click(screen.getByRole("button", { name: "Import reference file" }));
  await screen.findByText(/Local reference imported/);
  expect(api.importReference).toHaveBeenCalledWith("/local/reference.md", expect.any(AbortSignal));
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(api.runResearch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Public URLs"), { target: { value: "https://docs.example.org/python" } });
  fireEvent.change(screen.getByLabelText("Research policy"), { target: { value: "public_web" } });
  fireEvent.click(screen.getByLabelText("Enable network for this research run"));
  expect(screen.getByRole("button", { name: "Fetch entered URLs" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Discover sources" })).toBeDisabled();
});

it("cancels an active run and displays its actual saved outcome", async () => {
  const api = client();
  let finish!: (report: ResearchReport) => void;
  api.runResearch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const busy = vi.fn();
  render(<SourcePanel client={api} disabled={false} onBusyChange={busy} onChanged={vi.fn()} />);
  await screen.findByText(/Brave discovery: configured/);
  fireEvent.change(screen.getByLabelText("Public URLs"), { target: { value: "https://docs.example.org/python" } });
  fireEvent.change(screen.getByLabelText("Research policy"), { target: { value: "public_web" } });
  fireEvent.click(screen.getByLabelText("Enable network for this research run"));
  fireEvent.click(screen.getByRole("button", { name: "Fetch entered URLs" }));
  expect(busy).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel research" }));
  await waitFor(() => expect(api.cancelResearch).toHaveBeenCalledTimes(1));
  await act(async () => finish({ ...report, status: "cancelled", results: [], notices: ["Research was cancelled."] }));
  expect(screen.getByText("Research was cancelled.")).toBeInTheDocument();
  expect(busy).toHaveBeenLastCalledWith(false);
});

it("reopens a saved report without network research and displays bounded source text as text", async () => {
  const api = client();
  api.getResearchReports.mockResolvedValue({ reports: [{ report_id: report.report_id, status: report.status, started_at: report.started_at, finished_at: report.finished_at }], next_offset: null });
  render(<SourcePanel client={api} disabled={false} onBusyChange={vi.fn()} onChanged={vi.fn()} />);
  await screen.findByText("Python docs");
  expect(api.runResearch).not.toHaveBeenCalled();
  cleanup();
  render(<SourceExcerpt client={api} source={source} disabled={false} />);
  expect(api.getSourceText).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Read extracted text for Local reference" }));
  await screen.findByText("Exact extracted text");
  expect(api.getSourceText).toHaveBeenCalledWith("source-one", 0, 0, expect.any(AbortSignal));
  expect(screen.getByText(/Characters 0–20 of 20/)).toBeInTheDocument();
});
