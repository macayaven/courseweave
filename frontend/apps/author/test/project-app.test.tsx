import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import template from "../../../../examples/minimal-course/courseweave.json";
import { AuthorApp } from "../src/app";

const runtime = vi.hoisted(() => ({ status: "ready", retry: vi.fn(), runtime: {
  serviceOrigin: "https://author.test", capabilityToken: "fixture-capability", sourceId: "fixture-author",
} }));
vi.mock("../src/runtime", () => ({ useAuthorRuntime: () => runtime }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["success", "failure"])("prevents new unsaved edits during restore and releases the editor after %s", async outcome => {
  let finishRestore!: (response: Response) => void;
  const restoring = new Promise<Response>(resolve => { finishRestore = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const project = new Headers(init.headers).get("X-CourseWeave-Project");
    let body: unknown;
    if (path === "/api/author/projects") body = { enabled: true, projects: [{ project_id: "one" }, { project_id: "restored" }], unavailable: [] };
    else if (path === "/api/course") body = { ...template, title: project === "restored" ? "Restored course" : "First course" };
    else if (path === "/api/proposals") body = [];
    else if (path === "/api/author/sources") body = { sources: [] };
    else if (path === "/api/author/research") body = { network_enabled: false, brave_configured: false, active: false, busy: false };
    else if (path === "/api/author/research/reports" || path === "/api/author/reviews") body = { reports: [], next_offset: null };
    else if (path === "/api/author/content/files") body = { files: [], omitted: [] };
    else if (path === "/api/author/changes") body = { changes: [], total: 0 };
    else if (path === "/api/author/projects/restore/inspect") body = { archive_sha256: "a".repeat(64), original_project_id: "one", file_count: 1, total_bytes: 10, notice: "Restore inventory inspected." };
    else if (path === "/api/author/projects/restore") return restoring;
    else if (path === "/api/author/assistant/context") {
      const request = JSON.parse(String(init.body));
      body = { context_id: "context", conversation_retained: false, context: { role: request.role, selection: request.selection,
        content: '{"target":{}}', digest: "a".repeat(64), sources: [], omissions: [], budget: { max_input_chars: 24000, max_output_chars: 16000 } } };
    } else throw new Error(`Unexpected fixture route: ${path}`);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ETag: '"fixture"' } });
  }));
  render(<AuthorApp />);
  fireEvent.change(await screen.findByLabelText("Open project"), { target: { value: "one" } });
  await screen.findByLabelText("Course title");
  fireEvent.click(screen.getByText("Backup and recovery", { exact: true }));
  fireEvent.change(screen.getByLabelText("Author backup archive"), { target: { value: "/local/backup.tar" } });
  fireEvent.click(screen.getByRole("button", { name: "Inspect restore archive" }));
  await screen.findByText("Restore inventory inspected.");
  fireEvent.change(screen.getByLabelText("Restored project ID"), { target: { value: "restored" } });
  fireEvent.click(screen.getByRole("button", { name: "Restore as new project" }));
  await waitFor(() => expect(screen.getByLabelText("Course title")).toBeDisabled());
  expect(screen.getByRole("button", { name: "Add module" })).toBeDisabled();
  expect(screen.getByLabelText("Local reference file")).toBeDisabled();
  expect(screen.getByLabelText("Open project")).toBeDisabled();
  finishRestore(new Response(JSON.stringify(outcome === "success" ? { project_id: "restored" } : { detail: "Restore could not finish." }),
    { status: outcome === "success" ? 201 : 409, headers: { "Content-Type": "application/json" } }));
  await waitFor(() => expect(screen.getByLabelText("Course title")).toBeEnabled());
  expect(screen.getByLabelText("Course title")).toHaveValue(outcome === "success" ? "Restored course" : "First course");
});

it("replaces the editor and sources when projects change, including a return to the first project", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const project = new Headers(init.headers).get("X-CourseWeave-Project");
    let body: unknown;
    if (path === "/api/author/projects") body = { enabled: true, projects: [{ project_id: "one" }, { project_id: "two" }], unavailable: [] };
    else if (path === "/api/course") body = { ...template, title: project === "two" ? "Second course" : "First course" };
    else if (path === "/api/proposals") body = [];
    else if (path === "/api/author/sources") body = { sources: [] };
    else if (path === "/api/author/research") body = { network_enabled: false, brave_configured: false, active: false, busy: false, notice: "Fixture discovery unavailable" };
    else if (path === "/api/author/research/reports") body = { reports: [], next_offset: null };
    else if (path === "/api/author/reviews") body = { reports: [], next_offset: null };
    else if (path === "/api/author/content/files") body = { files: [], omitted: [] };
    else if (path === "/api/author/changes") body = { changes: [], total: 0 };
    else throw new Error(`Unexpected fixture route: ${path}`);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ETag: '"fixture"' } });
  }));
  render(<AuthorApp />);
  for (const [project, title] of [["one", "First course"], ["two", "Second course"], ["one", "First course"]]) {
    const selection = await screen.findByLabelText("Open project");
    await waitFor(() => expect(selection).toBeEnabled());
    fireEvent.change(selection, { target: { value: project } });
    await waitFor(() => {
      expect(screen.getAllByLabelText("Course title")).toHaveLength(1);
      expect(screen.getByLabelText("Course title")).toHaveValue(title);
    });
    expect(screen.getAllByRole("region", { name: "Sources" })).toHaveLength(1);
  }
});

it("lets file and review reads settle without repeatedly disabling each other's panels", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname; calls.push(path);
    let body: unknown;
    if (path === "/api/author/projects") body = { enabled: true, projects: [{ project_id: "one" }], unavailable: [] };
    else if (path === "/api/course") body = template;
    else if (path === "/api/proposals") body = [];
    else if (path === "/api/author/sources") body = { sources: [] };
    else if (path === "/api/author/research") body = { network_enabled: false, brave_configured: false, active: false, busy: false, notice: "Fixture discovery unavailable" };
    else if (path === "/api/author/research/reports") body = { reports: [], next_offset: null };
    else if (path === "/api/author/reviews") { await new Promise(resolve => setTimeout(resolve, 5)); body = { reports: [], next_offset: null }; }
    else if (path === "/api/author/content/files") { await new Promise(resolve => setTimeout(resolve, 20)); body = { files: [], omitted: [] }; }
    else if (path === "/api/author/changes") body = { changes: [], total: 0 };
    else if (path === "/api/author/assistant/context") {
      const request = JSON.parse(String(init.body));
      body = { context_id: "context", conversation_retained: false, context: { role: request.role, selection: request.selection,
        content: '{"target":{}}', digest: "a".repeat(64), sources: [], omissions: [], budget: { max_input_chars: 24000, max_output_chars: 16000 } } };
    } else throw new Error(`Unexpected fixture route: ${path}`);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ETag: '"fixture"' } });
  }));
  render(<AuthorApp />);
  fireEvent.change(await screen.findByLabelText("Open project"), { target: { value: "one" } });
  await screen.findByText(/Brave discovery: unavailable/, {}, { timeout: 1200 });
  fireEvent.change(screen.getByLabelText("Local reference file"), { target: { value: "/local/reference.md" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Import reference file" })).toBeEnabled());
  expect(calls.filter(path => path === "/api/author/reviews").length).toBeLessThan(8);
});
