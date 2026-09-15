import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import template from "../../../../examples/minimal-course/courseweave.json";
import { AuthorApp } from "../src/app";

const runtime = vi.hoisted(() => ({ status: "ready", retry: vi.fn(), runtime: {
  serviceOrigin: "https://author.test", capabilityToken: "fixture-capability", sourceId: "fixture-author",
} }));
vi.mock("../src/runtime", () => ({ useAuthorRuntime: () => runtime }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("replaces the editor and sources when projects change, including a return to the first project", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const project = new Headers(init.headers).get("X-CourseWeave-Project");
    let body: unknown;
    if (path === "/api/author/projects") body = { enabled: true, projects: [{ project_id: "one" }, { project_id: "two" }], unavailable: [] };
    else if (path === "/api/course") body = { ...template, title: project === "two" ? "Second course" : "First course" };
    else if (path === "/api/proposals") body = [];
    else if (path === "/api/author/sources") body = { sources: [] };
    else throw new Error(`Unexpected fixture route: ${path}`);
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ETag: '"fixture"' } });
  }));
  render(<AuthorApp />);
  for (const [project, title] of [["one", "First course"], ["two", "Second course"], ["one", "First course"]]) {
    fireEvent.change(await screen.findByLabelText("Open project"), { target: { value: project } });
    await waitFor(() => {
      expect(screen.getAllByLabelText("Course title")).toHaveLength(1);
      expect(screen.getByLabelText("Course title")).toHaveValue(title);
    });
    expect(screen.getAllByRole("region", { name: "Sources" })).toHaveLength(1);
  }
});
