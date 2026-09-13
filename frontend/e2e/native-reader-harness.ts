import { Widget } from "../packages/lab/node_modules/@lumino/widgets";
import {
  CourseSurfaceFactory,
  type CourseSnapshot,
} from "../packages/lab/src/surfaces";
import { RetainedSessionWidget } from "../packages/lab/src/retained-widget";
const events = document.querySelector<HTMLPreElement>("#events")!;
const frames: Widget[] = [];
const log: any[] = [];
const shell = {
  currentWidget: null as Widget | null,
  add(widget: Widget) {
    frames.push(widget);
    widget.node.style.width = "800px";
    widget.node.style.height = "500px";
    Widget.attach(widget, document.body);
  },
  activateById(id: string) {
    this.currentWidget =
      frames.find((widget) => widget.id === id) ?? this.currentWidget;
    this.currentWidget?.activate();
  },
};
const factory = new CourseSurfaceFactory({
  shell,
  documents: {
    openOrReveal(path, kind) {
      const widget = new Widget();
      widget.id = "native-notebook";
      widget.node.textContent = `Native ${kind}: ${path}`;
      frames.push(widget);
      Widget.attach(widget, document.body);
      log.push({ native: path, factory: kind });
      return widget;
    },
  },
  commands: {
    async execute() {
      throw Error("Execution must not occur");
    },
  },
  serviceOrigin: location.origin,
  jupyterOrigin: location.origin,
  baseUrl: "/",
  onOpened(coordinate) {
    log.push({
      coordinate,
      metadata: factory.metadataFor(shell.currentWidget),
    });
    events.textContent = JSON.stringify(log);
  },
  openExternal(url) {
    log.push({ external: url });
    events.textContent = JSON.stringify(log);
  },
});
const teacher = {
  access: { mode: "disabled" as const, requires: [] },
  sharing: { allow: [] },
};
const course: CourseSnapshot = {
  schema_version: 2,
  id: "native",
  title: "Native reader course",
  policies: { max_shared_chars: 8192, allowed_share_kinds: [] },
  modules: [
    {
      id: "module",
      title: "Module",
      phases: [
        {
          id: "read",
          title: "Reading",
          progress: "required",
          teacher,
          surfaces: [
            {
              id: "lesson",
              type: "html",
              path: "lessons/one.html",
              purpose: "primary",
              label: "Lesson",
            },
          ],
        },
        {
          id: "check",
          title: "Self-check",
          progress: "required",
          teacher,
          surfaces: [
            {
              id: "check",
              type: "html",
              path: "lessons/one.html",
              fragment: "self-check",
              purpose: "primary",
              label: "Check",
            },
          ],
        },
        {
          id: "practice",
          title: "Notebook practice",
          progress: "optional",
          teacher,
          surfaces: [
            {
              id: "notebook",
              type: "notebook",
              path: "notebooks/lab.ipynb",
              purpose: "primary",
              label: "Practice",
            },
          ],
        },
        {
          id: "next",
          title: "Next lesson",
          progress: "required",
          teacher,
          surfaces: [
            {
              id: "next",
              type: "html",
              path: "lessons/next.html",
              purpose: "primary",
              label: "Next lesson",
            },
          ],
        },
        {
          id: "ambiguous-a",
          title: "First use of shared document",
          progress: "optional",
          teacher,
          surfaces: [
            {
              id: "shared-a",
              type: "markdown",
              path: "shared.md",
              purpose: "primary",
              label: "Shared",
            },
          ],
        },
        {
          id: "ambiguous-b",
          title: "Second use of shared document",
          progress: "optional",
          teacher,
          surfaces: [
            {
              id: "shared-b",
              type: "markdown",
              path: "shared.md",
              purpose: "primary",
              label: "Shared",
            },
          ],
        },
      ],
    },
  ],
};
factory.setCourse(course);
const guide = new RetainedSessionWidget();
const frame = document.createElement("iframe");
frame.title = "Retained guide";
frame.src = "/native-session";
guide.node.appendChild(frame);
Widget.attach(guide, document.body);
(window as any).nativeHarness = {
  factory,
  guide,
  frame,
  openRead: () =>
    factory.open({ moduleId: "module", phaseId: "read", surfaceId: "lesson" }),
};
void factory.open({ moduleId: "module", phaseId: "read", surfaceId: "lesson" });
