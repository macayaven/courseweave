import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => {
  if (typeof globalThis.DragEvent === "undefined")
    Object.defineProperty(globalThis, "DragEvent", {
      value: class extends Event {},
    });
});
const harness = vi.hoisted(() => ({
  beforeReply: null as null | ((child: Window) => void),
  postContext: vi.fn(),
  getCourse: vi.fn(),
  launchMode: "learn",
}));
vi.mock("@jupyterlab/application", () => ({ ILabShell: "shell" }));
vi.mock("@jupyterlab/apputils", () => ({ ICommandPalette: "palette" }));
vi.mock("@jupyterlab/coreutils", () => ({
  PageConfig: {
    getBaseUrl: () => "/",
    getOption: (key: string) =>
      ({
        courseweaveServiceUrl: "http://localhost:3000",
        courseweaveRuntimeId: "synthetic",
        courseweaveLaunchMode: harness.launchMode,
      })[key] ?? "",
  },
}));
vi.mock("@jupyterlab/docmanager", () => ({
  IDocumentManager: "documents",
}));
vi.mock("@jupyterlab/fileeditor", () => ({ IEditorTracker: "editor" }));
vi.mock("@jupyterlab/notebook", () => ({ INotebookTracker: "notebook" }));
vi.mock("@jupyterlab/settingregistry", () => ({
  ISettingRegistry: "settings",
}));
vi.mock("@jupyterlab/terminal", () => ({ ITerminalTracker: "terminal" }));
vi.mock("../src/runtime", () => ({
  CourseWeaveRelayClient: class {
    getCourse = harness.getCourse;
    postContext = harness.postContext;
  },
  RuntimeBroker: class {
    constructor(options: any) {
      harness.beforeReply = options.beforeReply;
    }
    start() {}
    dispose() {}
  },
  createCourseWeaveIframe: () => {
    const iframe = document.createElement("iframe");
    iframe.title = "CourseWeave guide";
    return iframe;
  },
}));
import { DockPanel, Widget } from "@lumino/widgets";
import plugin from "../src/index";
class Signal {
  slots = new Set<() => void>();
  connect(fn: () => void) {
    this.slots.add(fn);
  }
  disconnect(fn: () => void) {
    this.slots.delete(fn);
  }
  emit() {
    this.slots.forEach((fn) => fn());
  }
}
afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  harness.launchMode = "learn";
});
it.each(["command", "runtime"] as const)(
  "retries the retained publisher through the offered %s recovery path and clears notice only on current confirmation",
  async (path) => {
    const widgets: Widget[] = [];
    const commands = new Map<string, any>();
    const documentWidget = { context: { path: "first.py" } };
    const signal = new Signal();
    const shell = {
      currentWidget: documentWidget,
      currentChanged: signal,
      add(widget: Widget) {
        widgets.push(widget);
        Widget.attach(widget, document.body);
      },
      activateById: vi.fn(),
    };
    harness.getCourse.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            schema_version: 2,
            id: "course",
            title: "Course",
            policies: { max_shared_chars: 8192, allowed_share_kinds: [] },
            modules: [],
          }),
        ),
    );
    let finish!: (value: Response) => void;
    harness.postContext
      .mockRejectedValueOnce(Error("offline"))
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const tracker = {
      currentWidget: null,
      currentChanged: new Signal(),
      activeCell: null,
      activeCellChanged: new Signal(),
    };
    await plugin.activate(
      {
        commands: {
          addCommand: (id: string, command: any) => commands.set(id, command),
        },
      } as any,
      shell as any,
      { addItem: vi.fn() } as any,
      {} as any,
      tracker as any,
      tracker as any,
      tracker as any,
      null,
    );
    const guide = widgets[0]!;
    const iframe = guide.node.querySelector("iframe")!;
    const originalWindow = iframe.contentWindow!;
    harness.beforeReply!(originalWindow);
    await vi.waitFor(() =>
      expect(
        guide.node.querySelector("[data-courseweave-recovery]"),
      ).not.toBeNull(),
    );
    documentWidget.context.path = "latest.py";
    signal.emit();
    guide.close();
    const messages = vi.spyOn(originalWindow, "postMessage");
    if (path === "command") commands.get("courseweave:open-guide").execute();
    else harness.beforeReply!(originalWindow);
    await vi.waitFor(() =>
      expect(harness.postContext).toHaveBeenCalledTimes(2),
    );
    expect(harness.postContext.mock.calls[1]![0]).toMatchObject({
      source_id: harness.postContext.mock.calls[0]![0].source_id,
      sequence: 0,
      active_path: "latest.py",
    });
    expect(
      guide.node.querySelector("[data-courseweave-recovery]"),
    ).not.toBeNull();
    expect(
      messages.mock.calls.some(
        ([message]) => message.type === "courseweave.context.changed.v1",
      ),
    ).toBe(false);
    finish(
      new Response(
        JSON.stringify({
          module_id: "module",
          phase_id: "latest",
          surface_id: null,
          reason: "active_path",
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        messages.mock.calls.some(
          ([message]) => message.type === "courseweave.context.changed.v1",
        ),
      ).toBe(true),
    );
    expect(guide.node.querySelector("[data-courseweave-recovery]")).toBeNull();
    expect(iframe.contentWindow).toBe(originalWindow);
    expect(guide.isDisposed).toBe(false);
    guide.dispose();
  },
);


it("opens Author after actual dock restoration instead of losing its newly added panel", async () => {
  harness.launchMode = "author";
  harness.getCourse.mockResolvedValue(new Response(JSON.stringify({schema_version:2,id:"course",title:"Course",policies:{max_shared_chars:8192,allowed_share_kinds:[]},modules:[]})));
  const dock = new DockPanel(); Widget.attach(dock, document.body);
  let finishRestoration!: () => void;
  const restored = new Promise<void>(resolve => { finishRestoration = resolve; });
  const commands = new Map<string, any>();
  const shell = { currentWidget:null, currentChanged:new Signal(), add(widget:Widget) { dock.addWidget(widget); }, activateById:vi.fn() };
  const tracker = {currentWidget:null,currentChanged:new Signal(),activeCell:null,activeCellChanged:new Signal()};
  await plugin.activate({restored,commands:{addCommand:(id:string,options:any)=>commands.set(id,options)}} as any,shell as any,{addItem:vi.fn()} as any,{} as any,tracker as any,tracker as any,tracker as any,null);
  // Jupyter startup must finish so its layout restoration can complete.
  expect(commands.has("courseweave:open-author")).toBe(true);
  commands.get("courseweave:open-author").execute();
  dock.restoreLayout({main:null});
  finishRestoration();
  await vi.waitFor(() => expect([...dock.widgets()].map(widget => widget.id)).toEqual(["courseweave-author"]));
  expect(dock.node.querySelector('iframe')).not.toBeNull();
  commands.get("courseweave:open-author").execute();
  await Promise.resolve();
  expect([...dock.widgets()]).toHaveLength(1);
  dock.dispose();
});
