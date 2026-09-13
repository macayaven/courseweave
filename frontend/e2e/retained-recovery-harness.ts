import plugin from "../packages/lab/src/index";
import { Widget } from "../packages/lab/node_modules/@lumino/widgets";
class Signal {
  private slots = new Set<() => void>();
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
const commands = new Map<string, any>();
const documentWidget = { context: { path: "first.py" } };
const currentChanged = new Signal();
let guide: Widget;
const shell = {
  currentWidget: documentWidget,
  currentChanged,
  add(widget: Widget) {
    guide = widget;
    Widget.attach(widget, document.body);
  },
  activateById() {},
};
const tracker = {
  currentWidget: null,
  currentChanged: new Signal(),
  activeCell: null,
  activeCellChanged: new Signal(),
};
await plugin.activate(
  {
    commands: {
      addCommand: (id: string, options: any) => commands.set(id, options),
    },
  } as any,
  shell as any,
  { addItem() {} } as any,
  {} as any,
  tracker as any,
  tracker as any,
  tracker as any,
  null,
);
(window as any).recoveryHarness = {
  navigate(path: string) {
    documentWidget.context.path = path;
    currentChanged.emit();
  },
  close() {
    guide.close();
  },
  reopen() {
    commands.get("courseweave:open-guide").execute();
  },
  sameWindow() {
    return originalWindow === guide.node.querySelector("iframe")!.contentWindow;
  },
};
const originalWindow = guide!.node.querySelector("iframe")!.contentWindow;
