import { Widget } from "@lumino/widgets";

import { parseOpenSurfaceRequest } from "./protocol";
import { createCourseWeaveIframe } from "./runtime";

export type SurfaceType =
  | "html"
  | "markdown"
  | "video"
  | "notebook"
  | "source"
  | "terminal"
  | "external";

export interface CourseSurface {
  id: string;
  type: SurfaceType;
  path?: string;
  url?: string;
  cwd?: string;
  command?: string[];
  src?: string;
  fragment?: string | null;
  purpose?: "primary" | "supporting" | "reference";
  selector?: { type: string; values?: string[]; match?: string };
  start_seconds?: number | null;
  end_seconds?: number | null;
  label?: string;
}

export interface CourseSnapshot {
  schema_version: 2;
  id: string;
  title: string;
  entry_module_id?: string | null;
  policies: {
    max_shared_chars: number;
    allowed_share_kinds: Array<"selection" | "cell" | "output">;
  };
  modules: Array<{
    id: string;
    title: string;
    phases: Array<{
      id: string;
      title: string;
      progress: "required" | "optional" | "excluded";
      teacher: {
        access: {
          mode: "available" | "disabled" | "observer_only";
          requires: string[];
        };
        sharing: { allow: Array<"selection" | "cell" | "output"> };
      };
      surfaces: CourseSurface[];
    }>;
  }>;
}

export interface SurfaceCoordinate {
  moduleId: string;
  phaseId: string;
  surfaceId: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown, max = 1024): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value
  );
}

function validSurface(value: unknown): value is CourseSurface {
  if (!record(value) || !nonBlank(value.id, 80)) return false;
  if (
    ![
      "html",
      "markdown",
      "video",
      "notebook",
      "source",
      "terminal",
      "external",
    ].includes(String(value.type))
  )
    return false;
  if (
    ["html", "markdown", "notebook", "source"].includes(String(value.type)) &&
    !nonBlank(value.path)
  )
    return false;
  if (value.path !== undefined && !nonBlank(value.path)) return false;
  if (value.url !== undefined && !nonBlank(value.url, 4096)) return false;
  if (value.cwd !== undefined && !nonBlank(value.cwd)) return false;
  if (
    value.type === "terminal" &&
    (!nonBlank(value.cwd) ||
      !Array.isArray(value.command) ||
      value.command.length === 0 ||
      value.command.some(
        (item) => typeof item !== "string" || item.length === 0,
      ))
  )
    return false;
  if (value.type === "video" && !nonBlank(value.src, 4096)) return false;
  if (value.type === "external" && !nonBlank(value.url, 4096)) return false;
  if (
    value.fragment !== undefined &&
    value.fragment !== null &&
    (value.type !== "html" ||
      typeof value.fragment !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(value.fragment))
  )
    return false;
  return true;
}

export function parseCourseSnapshot(value: unknown): CourseSnapshot | null {
  if (
    !record(value) ||
    value.schema_version !== 2 ||
    !nonBlank(value.id, 80) ||
    !nonBlank(value.title, 240)
  )
    return null;
  if (
    !record(value.policies) ||
    !Number.isInteger(value.policies.max_shared_chars) ||
    (value.policies.max_shared_chars as number) < 1 ||
    (value.policies.max_shared_chars as number) > 131072
  )
    return null;
  if (
    !Array.isArray(value.policies.allowed_share_kinds) ||
    value.policies.allowed_share_kinds.some(
      (kind) => !["selection", "cell", "output"].includes(String(kind)),
    )
  )
    return null;
  if (!Array.isArray(value.modules)) return null;
  const moduleIds = new Set<string>();
  for (const module of value.modules) {
    if (
      !record(module) ||
      !nonBlank(module.id, 80) ||
      !nonBlank(module.title, 240) ||
      moduleIds.has(module.id) ||
      !Array.isArray(module.phases)
    )
      return null;
    moduleIds.add(module.id);
    const phaseIds = new Set<string>();
    for (const phase of module.phases) {
      if (
        !record(phase) ||
        !nonBlank(phase.id, 80) ||
        !nonBlank(phase.title, 240) ||
        phaseIds.has(phase.id) ||
        !record(phase.teacher) ||
        !Array.isArray(phase.surfaces)
      )
        return null;
      if (
        !["required", "optional", "excluded"].includes(
          String(phase.progress),
        ) ||
        !record(phase.teacher.access) ||
        !["available", "disabled", "observer_only"].includes(
          String(phase.teacher.access.mode),
        ) ||
        !Array.isArray(phase.teacher.access.requires) ||
        phase.teacher.access.requires.some((id) => !nonBlank(id, 80)) ||
        !record(phase.teacher.sharing) ||
        !Array.isArray(phase.teacher.sharing.allow) ||
        phase.teacher.sharing.allow.some(
          (kind) => !["selection", "cell", "output"].includes(String(kind)),
        )
      )
        return null;
      phaseIds.add(phase.id);
      const surfaceIds = new Set<string>();
      for (const surface of phase.surfaces) {
        if (!validSurface(surface) || surfaceIds.has(surface.id)) return null;
        surfaceIds.add(surface.id);
      }
    }
  }
  return value as unknown as CourseSnapshot;
}

function canonicalOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid Jupyter origin");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== value
  )
    throw new Error("invalid Jupyter origin");
  return parsed.origin;
}

function safeRelativePath(path: string): string {
  if (
    !nonBlank(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
  )
    throw new Error("unsafe course path");
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  )
    throw new Error("unsafe course path");
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export function localReaderUrl(
  path: string,
  jupyterOrigin: string,
  baseUrl: string,
  reader = true,
): string {
  return new URL(
    `${reader ? "courseweave/reader" : "files"}/${safeRelativePath(path)}`,
    canonicalJupyterBaseUrl(jupyterOrigin, baseUrl),
  ).href;
}

export function canonicalJupyterBaseUrl(
  jupyterOrigin: string,
  baseUrl: string,
): string {
  const origin = canonicalOrigin(jupyterOrigin);
  let base: URL;
  try {
    base = new URL(baseUrl, `${origin}/`);
  } catch {
    throw new Error("invalid Jupyter base URL");
  }
  if (
    base.origin !== origin ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("invalid Jupyter base URL");
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  const segments = basePath.split("/").slice(1, -1);
  if (
    basePath.includes("%") ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment === "files",
    )
  )
    throw new Error("invalid Jupyter base URL");
  return `${origin}${basePath}`;
}

function videoUrl(value: string | undefined): string {
  if (value === undefined || value.trim() !== value)
    throw new Error("invalid video URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid video URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.href !== value
  )
    throw new Error("invalid video URL");
  return parsed.href;
}

interface SurfaceShell {
  add(widget: Widget, area: "main", options?: Record<string, unknown>): void;
  activateById(id: string): void;
  currentWidget: Widget | null;
}

interface SurfaceDocumentManager {
  openOrReveal(path: string, factory: string): Widget | undefined;
}

interface SurfaceCommands {
  execute(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

interface SurfaceMainAreaWidget extends Widget {
  // MainAreaWidget's public extension point for notification/header widgets.
  readonly contentHeader: {
    addWidget(widget: Widget): void;
  };
}

export interface SurfaceMetadata {
  activePath: string | null;
  surfaceKind: SurfaceType | null;
  terminalSurfaceId: string | null;
  explicitModuleId: string | null;
  explicitPhaseId: string | null;
}

interface CourseSurfaceFactoryOptions {
  shell: SurfaceShell;
  documents: SurfaceDocumentManager;
  commands: SurfaceCommands;
  serviceOrigin: string;
  jupyterOrigin: string;
  baseUrl: string;
  beforeAuthorAttach?: (widget: Widget, iframe: HTMLIFrameElement) => void;
  writeClipboard?: (text: string) => Promise<void>;
  onOpened?(
    coordinate: SurfaceCoordinate,
    result: SurfaceOpenResult,
  ): void | Promise<void>;
  openExternal?(url: string): void;
}

export interface SurfaceOpenResult {
  htmlSource: string | null;
  jupyterBaseUrl: string;
  terminalSurfaceId: string | null;
}

function writeBrowserClipboard(text: string): Promise<void> {
  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard === undefined || typeof clipboard.writeText !== "function") {
    return Promise.reject(new Error("Clipboard API unavailable."));
  }
  return clipboard.writeText(text);
}

function terminalInstructions(
  surface: CourseSurface,
  writeClipboard: (text: string) => Promise<void>,
): Widget {
  if (
    surface.cwd === undefined ||
    surface.command === undefined ||
    surface.command.length === 0
  ) {
    throw new Error("Terminal instructions are missing.");
  }
  const payload = JSON.stringify(
    { cwd: surface.cwd, command: surface.command },
    null,
    2,
  );
  const panel = document.createElement("section");
  panel.setAttribute("data-courseweave-terminal-instructions", "");
  panel.setAttribute("aria-label", "CourseWeave terminal launch instructions");
  panel.style.padding = "8px 12px";
  panel.style.background = "var(--jp-layout-color1, #fff)";
  panel.style.borderBottom =
    "var(--jp-border-width, 1px) solid var(--jp-border-color2, #ddd)";
  panel.style.maxHeight = "40%";
  panel.style.overflow = "auto";

  const heading = document.createElement("strong");
  heading.textContent = surface.label ?? "Terminal launch instructions";
  panel.appendChild(heading);

  const explanation = document.createElement("p");
  explanation.textContent =
    "CourseWeave does not run this command. Review and copy the structured values when ready.";
  panel.appendChild(explanation);

  const command = document.createElement("pre");
  command.setAttribute("data-courseweave-terminal-command", "");
  command.textContent = payload;
  command.style.whiteSpace = "pre-wrap";
  command.style.userSelect = "text";
  panel.appendChild(command);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy launch instructions";
  panel.appendChild(copy);

  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.style.marginInlineStart = "8px";
  panel.appendChild(status);

  copy.addEventListener("click", () => {
    status.textContent = "Copying terminal launch instructions…";
    void Promise.resolve()
      .then(() => writeClipboard(payload))
      .then(() => {
        status.textContent = "Terminal launch instructions copied.";
      })
      .catch(() => {
        status.textContent =
          "Copy failed. Select the instructions and copy them manually.";
      });
  });
  return new Widget({ node: panel });
}

function mainAreaWidget(value: unknown): SurfaceMainAreaWidget {
  if (!(value instanceof Widget) && (!record(value) || !nonBlank(value.id))) {
    throw new Error("Native terminal unavailable.");
  }
  const candidate = value as SurfaceMainAreaWidget;
  if (
    !record(candidate.contentHeader) ||
    typeof candidate.contentHeader.addWidget !== "function" ||
    candidate.isDisposed
  ) {
    throw new Error("Native terminal unavailable.");
  }
  return candidate;
}

export function coordinateForCoursePath(
  course: CourseSnapshot,
  path: string,
): { moduleId: string; phaseId: string } | null {
  try {
    safeRelativePath(path);
  } catch {
    return null;
  }
  const matches = new Map<string, { moduleId: string; phaseId: string }>();
  for (const module of course.modules) {
    for (const phase of module.phases) {
      if (
        phase.surfaces.some(
          (surface) =>
            surface.path === path ||
            (surface.type === "video" && surface.src === path),
        )
      ) {
        matches.set(`${module.id}/${phase.id}`, {
          moduleId: module.id,
          phaseId: phase.id,
        });
      }
    }
  }
  return matches.size === 1 ? (matches.values().next().value ?? null) : null;
}

export const COURSEWEAVE_COMMANDS = {
  openGuide: "courseweave:open-guide",
  openDashboard: "courseweave:open-dashboard",
  openAuthor: "courseweave:open-author",
  shareSelection: "courseweave:share-selection",
  shareCell: "courseweave:share-cell",
  shareOutput: "courseweave:share-output",
} as const;

export const COURSEWEAVE_PALETTE_CATEGORY = "CourseWeave";

export function registerCoursePalette(palette: {
  addItem(options: { command: string; category: string }): unknown;
}): void {
  const registered = new Set<string>();
  for (const command of Object.values(COURSEWEAVE_COMMANDS)) {
    if (registered.has(command)) continue;
    registered.add(command);
    palette.addItem({ command, category: COURSEWEAVE_PALETTE_CATEGORY });
  }
}

export function registerCourseCommands(
  commands: {
    addCommand(
      id: string,
      options: { label: string; execute(): unknown },
    ): void;
  },
  actions: {
    openGuide(): unknown;
    openDashboard(): unknown;
    openAuthor(): unknown;
    requestShare(kind: "selection" | "cell" | "output"): unknown;
  },
): void {
  commands.addCommand(COURSEWEAVE_COMMANDS.openGuide, {
    label: "Open CourseWeave Guide",
    execute: actions.openGuide,
  });
  commands.addCommand(COURSEWEAVE_COMMANDS.openDashboard, {
    label: "Open CourseWeave Dashboard",
    execute: actions.openDashboard,
  });
  commands.addCommand(COURSEWEAVE_COMMANDS.openAuthor, {
    label: "Open CourseWeave Author",
    execute: actions.openAuthor,
  });
  commands.addCommand(COURSEWEAVE_COMMANDS.shareSelection, {
    label: "Share Selection with CourseWeave",
    execute: () => actions.requestShare("selection"),
  });
  commands.addCommand(COURSEWEAVE_COMMANDS.shareCell, {
    label: "Share Cell with CourseWeave",
    execute: () => actions.requestShare("cell"),
  });
  commands.addCommand(COURSEWEAVE_COMMANDS.shareOutput, {
    label: "Share Output with CourseWeave",
    execute: () => actions.requestShare("output"),
  });
}

class ReaderWidget extends Widget {
  private pendingFragment = false;
  iframe: HTMLIFrameElement;
  readonly notice: HTMLElement;

  constructor(private readonly bindLinks: (reader: ReaderWidget) => void) {
    const node = document.createElement("div");
    const notice = document.createElement("div");
    notice.setAttribute("role", "status");
    notice.style.padding = "8px";
    notice.hidden = true;
    node.appendChild(notice);
    super({ node });
    node.tabIndex = -1;
    this.notice = notice;
    this.iframe = this.createFrame();
    node.appendChild(this.iframe);
    node.style.display = "flex";
    node.style.flexDirection = "column";
    this.id = "courseweave-reader";
    this.title.label = "Course reader";
    this.title.closable = true;
  }

  private createFrame(): HTMLIFrameElement {
    const iframe = document.createElement("iframe");
    iframe.title = "CourseWeave reader";
    iframe.referrerPolicy = "no-referrer";
    iframe.setAttribute("sandbox", "");
    iframe.inert = true;
    iframe.setAttribute("aria-busy", "true");
    iframe.style.width = "100%";
    iframe.style.flex = "1";
    iframe.style.border = "0";
    iframe.addEventListener("load", () => {
      if (this.isDisposed || iframe !== this.iframe) return;
      // Visible anchors must not navigate independently before the parent has
      // bound them to an allowlisted activity and its assistant context.
      this.bindLinks(this);
      iframe.inert = false;
      iframe.removeAttribute("aria-busy");
      this.pendingFragment = true;
      this.scrollToFragment();
    });
    return iframe;
  }

  protected onActivateRequest(): void {
    // Jupyter's main-area focus tracker must recognize this custom reader.
    // Focusing its host also keeps scripts-disabled iframe content unchanged.
    this.node.focus({ preventScroll: true });
    // The iframe may have navigated while hidden behind a notebook. Native
    // fragment scrolling then has no visible layout; apply it on activation.
    this.scrollToFragment();
  }

  protected onAfterShow(): void {
    this.scrollToFragment();
  }

  private scrollToFragment(): void {
    if (!this.pendingFragment || !this.isVisible ||
        this.iframe.getAttribute("sandbox") !== "allow-same-origin") return;
    try {
      const fragment = new URL(this.iframe.src).hash.slice(1);
      const target = this.iframe.contentDocument
        ?.getElementById(decodeURIComponent(fragment));
      if (target) {
        target.scrollIntoView();
        this.pendingFragment = false;
      }
    } catch {
      // Cross-origin media and a document still loading have no local target.
    }
  }

  navigate(source: string, localHtml: boolean): void {
    // Jupyter rejects an opaque-origin or referrer-free navigation to its
    // authenticated /files handler. Local course HTML therefore keeps its
    // Jupyter origin and same-origin referrer while scripts/forms remain off;
    // cross-origin subresources receive no referrer. Remote media is opaque.
    // Each explicit navigation owns its load event. Replacing the iframe also
    // gives same-document fragment navigation a real load, so it cannot remain
    // inert indefinitely, and ignores late events from superseded documents.
    const previous = this.iframe;
    const iframe = this.createFrame();
    iframe.setAttribute("sandbox", localHtml ? "allow-same-origin" : "");
    iframe.referrerPolicy = localHtml ? "same-origin" : "no-referrer";
    this.pendingFragment = true;
    iframe.src = source;
    this.iframe = iframe;
    previous.replaceWith(iframe);
  }
}

class AuthorWidget extends Widget {
  readonly iframe: HTMLIFrameElement;

  constructor(serviceOrigin: string) {
    const node = document.createElement("div");
    const iframe = createCourseWeaveIframe(serviceOrigin, "author");
    node.appendChild(iframe);
    super({ node });
    this.iframe = iframe;
    this.id = "courseweave-author";
    this.title.label = iframe.title;
    this.title.closable = true;
  }
}

class DashboardWidget extends Widget {
  constructor(
    course: CourseSnapshot,
    private readonly open: (coordinate: SurfaceCoordinate) => Promise<unknown>,
  ) {
    super({ node: document.createElement("div") });
    this.id = "courseweave-dashboard";
    this.title.label = "Course dashboard";
    this.title.closable = true;
    this.updateCourse(course);
  }

  updateCourse(course: CourseSnapshot): void {
    this.node.replaceChildren();
    const heading = document.createElement("h1");
    heading.textContent = course.title;
    this.node.appendChild(heading);
    this.node.style.padding = "16px";
    this.node.style.overflow = "auto";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    for (const module of course.modules) {
      const section = document.createElement("section");
      const moduleHeading = document.createElement("h2");
      moduleHeading.textContent = module.title;
      section.appendChild(moduleHeading);
      this.node.appendChild(section);
      for (const phase of module.phases) {
        const activity = document.createElement("section");
        const activityHeading = document.createElement("h3");
        activityHeading.textContent =
          phase.title +
          (phase.progress === "required" ? "" : " · Optional / reference");
        activity.appendChild(activityHeading);
        section.appendChild(activity);
        for (const surface of phase.surfaces) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = surface.label ?? surface.id;
          button.addEventListener("click", () => {
            void this.open({
              moduleId: module.id,
              phaseId: phase.id,
              surfaceId: surface.id,
            }).catch(() => {
              status.textContent =
                "CourseWeave backend unavailable. Retry after restarting the service.";
            });
          });
          activity.appendChild(button);
        }
      }
    }
    this.node.appendChild(status);
  }
}

export class CourseSurfaceFactory {
  private course: CourseSnapshot | null = null;
  private reader: ReaderWidget | null = null;
  private dashboard: DashboardWidget | null = null;
  private author: AuthorWidget | null = null;
  private readonly terminals = new Map<string, Widget>();
  private readonly metadata = new WeakMap<object, SurfaceMetadata>();
  private readonly jupyterBaseUrl: string;
  private opening: Promise<void> = Promise.resolve();

  constructor(private readonly options: CourseSurfaceFactoryOptions) {
    this.jupyterBaseUrl = canonicalJupyterBaseUrl(
      options.jupyterOrigin,
      options.baseUrl,
    );
  }

  setCourse(course: CourseSnapshot): void {
    this.course = course;
    if (this.dashboard !== null && !this.dashboard.isDisposed)
      this.dashboard.updateCourse(course);
  }

  private lookup(coordinate: SurfaceCoordinate): CourseSurface {
    const surface = this.course?.modules
      .find((item) => item.id === coordinate.moduleId)
      ?.phases.find((item) => item.id === coordinate.phaseId)
      ?.surfaces.find((item) => item.id === coordinate.surfaceId);
    if (surface === undefined) throw new Error("Surface is not allowlisted.");
    return surface;
  }

  private activate(widget: Widget): void {
    this.options.shell.activateById(widget.id);
  }

  private nativeDocument(
    path: string | undefined,
    factory: string,
    surface: SurfaceType,
    coordinate: SurfaceCoordinate,
  ): Widget {
    if (path === undefined) throw new Error("Surface path is missing.");
    safeRelativePath(path);
    const widget = this.options.documents.openOrReveal(path, factory);
    if (widget === undefined) throw new Error("Native surface unavailable.");
    this.metadata.set(widget, {
      activePath: path,
      surfaceKind: surface,
      terminalSurfaceId: null,
      explicitModuleId: coordinate.moduleId,
      explicitPhaseId: coordinate.phaseId,
    });
    this.activate(widget);
    return widget;
  }

  private createTerminal(
    key: string,
    coordinate: SurfaceCoordinate,
    surface: CourseSurface,
  ): Promise<SurfaceMainAreaWidget> {
    const instructions = terminalInstructions(
      surface,
      this.options.writeClipboard ?? writeBrowserClipboard,
    );
    // Let Jupyter Server choose its constrained terminal-session name. The
    // course coordinate is tracked only in this factory and is never routed.
    const creation = this.options.commands
      .execute("terminal:create-new")
      .then((created) => {
        const widget = mainAreaWidget(created);
        widget.contentHeader.addWidget(instructions);
        this.terminals.set(key, widget);
        widget.disposed.connect(() => {
          instructions.dispose();
          if (this.terminals.get(key) === widget) this.terminals.delete(key);
        });
        return widget;
      })
      .catch((error: unknown) => {
        instructions.dispose();
        throw error;
      });
    return creation;
  }

  open(coordinate: SurfaceCoordinate): Promise<SurfaceOpenResult> {
    // Native terminal creation is asynchronous and activates its tab. Finish
    // each requested transition before the next so a late terminal cannot
    // take focus and assistant context back from a newly selected lesson.
    const opened = this.opening.then(async () => {
      const result = await this.openSurface(coordinate);
      await this.options.onOpened?.(coordinate, result);
      return result;
    });
    this.opening = opened.then(() => undefined, () => undefined);
    return opened;
  }

  private async openSurface(
    coordinate: SurfaceCoordinate,
  ): Promise<SurfaceOpenResult> {
    const surface = this.lookup(coordinate);
    if (surface.type === "markdown") {
      this.nativeDocument(
        surface.path,
        "Markdown Preview",
        "markdown",
        coordinate,
      );
      return {
        htmlSource: null,
        jupyterBaseUrl: this.jupyterBaseUrl,
        terminalSurfaceId: null,
      };
    }
    if (surface.type === "notebook") {
      this.nativeDocument(surface.path, "Notebook", "notebook", coordinate);
      return {
        htmlSource: null,
        jupyterBaseUrl: this.jupyterBaseUrl,
        terminalSurfaceId: null,
      };
    }
    if (surface.type === "source") {
      this.nativeDocument(surface.path, "Editor", "source", coordinate);
      return {
        htmlSource: null,
        jupyterBaseUrl: this.jupyterBaseUrl,
        terminalSurfaceId: null,
      };
    }
    if (surface.type === "terminal") {
      if (surface.cwd !== undefined && surface.cwd !== ".")
        safeRelativePath(surface.cwd);
      const key = `${coordinate.moduleId}/${coordinate.phaseId}/${surface.id}`;
      let widget = this.terminals.get(key);
      if (widget === undefined || widget.isDisposed) {
        widget = await this.createTerminal(key, coordinate, surface);
      }
      this.metadata.set(widget, {
        activePath: null,
        surfaceKind: "terminal",
        terminalSurfaceId: surface.id,
        explicitModuleId: coordinate.moduleId,
        explicitPhaseId: coordinate.phaseId,
      });
      this.activate(widget);
      return {
        htmlSource: null,
        jupyterBaseUrl: this.jupyterBaseUrl,
        terminalSurfaceId: surface.id,
      };
    }
    if (surface.type === "html" || surface.type === "video") {
      const source =
        surface.type === "html"
          ? localReaderUrl(
              surface.path ?? "",
              this.options.jupyterOrigin,
              this.options.baseUrl,
            ) +
            (surface.fragment ? `#${encodeURIComponent(surface.fragment)}` : "")
          : surface.src?.startsWith("https://")
            ? videoUrl(surface.src)
            : localReaderUrl(
                surface.src ?? "",
                this.options.jupyterOrigin,
                this.options.baseUrl,
                false,
              );
      if (this.reader === null || this.reader.isDisposed) {
        this.reader = new ReaderWidget((reader) => this.bindReaderLinks(reader));
        this.options.shell.add(this.reader, "main", { type: "CourseWeave" });
      }
      this.reader.navigate(
        source,
        surface.type === "html" || !surface.src?.startsWith("https://"),
      );
      this.metadata.set(this.reader, {
        activePath: surface.type === "html" ? (surface.path ?? null) : null,
        surfaceKind: surface.type,
        terminalSurfaceId: null,
        explicitModuleId: coordinate.moduleId,
        explicitPhaseId: coordinate.phaseId,
      });
      this.activate(this.reader);
      return {
        htmlSource: source,
        jupyterBaseUrl: this.jupyterBaseUrl,
        terminalSurfaceId: null,
      };
    }
    if (surface.type === "external") {
      (
        this.options.openExternal ??
        ((url: string) => {
          window.open(url, "_blank", "noopener,noreferrer");
        })
      )(videoUrl(surface.url));
      return {
        htmlSource: null,
        jupyterBaseUrl: this.jupyterBaseUrl,
        terminalSurfaceId: null,
      };
    }
    throw new Error("Surface type is not supported.");
  }

  private bindReaderLinks(reader: ReaderWidget): void {
    if (
      reader.isDisposed ||
      reader.iframe.getAttribute("sandbox") !== "allow-same-origin"
    )
      return;
    let doc: Document | null;
    try {
      doc = reader.iframe.contentDocument;
    } catch {
      return;
    }
    if (!doc) return;
    for (const anchor of Array.from(
      doc.querySelectorAll<HTMLAnchorElement>("a[href]"),
    )) {
      if (anchor.dataset.courseweaveBound === "true") continue;
      anchor.dataset.courseweaveBound = "true";
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        const href = anchor.getAttribute("href");
        if (href === null) return;
        let target: URL;
        try {
          target = new URL(href, reader.iframe.src);
        } catch {
          return;
        }
        reader.notice.replaceChildren();
        reader.notice.hidden = true;
        if (
          target.protocol === "https:" &&
          target.origin !== new URL(this.jupyterBaseUrl).origin &&
          !target.username &&
          !target.password
        ) {
          (
            this.options.openExternal ??
            ((url: string) => {
              window.open(url, "_blank", "noopener,noreferrer");
            })
          )(target.href);
          return;
        }
        const base = new URL(this.jupyterBaseUrl);
        const prefix = `${base.pathname}courseweave/reader/`;
        if (
          target.origin !== base.origin ||
          target.username ||
          target.password ||
          target.search ||
          !target.pathname.startsWith(prefix)
        ) {
          reader.notice.textContent =
            "This link is not an approved course surface.";
          reader.notice.hidden = false;
          return;
        }
        let path: string;
        try {
          path = target.pathname
            .slice(prefix.length)
            .split("/")
            .map(decodeURIComponent)
            .join("/");
          if (safeRelativePath(path) !== target.pathname.slice(prefix.length))
            throw Error();
        } catch {
          return;
        }
        const fragment = target.hash.slice(1);
        const matches = (this.course?.modules ?? []).flatMap((module) =>
          module.phases.flatMap((phase) =>
            phase.surfaces
              .filter(
                (surface) =>
                  surface.path === path &&
                  (surface.type !== "html" ||
                    (surface.fragment ?? "") === fragment),
              )
              .map((surface) => ({
                moduleId: module.id,
                phaseId: phase.id,
                surfaceId: surface.id,
                title: phase.title,
              })),
          ),
        );
        if (matches.length === 1) {
          void this.open(matches[0]!).catch(() => {
            reader.notice.textContent =
              "The activity could not be opened. Try again from course contents.";
            reader.notice.hidden = false;
          });
          return;
        }
        if (
          matches.length === 0 &&
          fragment &&
          target.pathname === new URL(reader.iframe.src).pathname &&
          /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(fragment)
        ) {
          doc!.getElementById(fragment)?.scrollIntoView();
          return;
        }
        reader.notice.hidden = false;
        reader.notice.textContent = matches.length
          ? "Choose the activity for this shared document:"
          : "This link is not listed in the course contents.";
        for (const match of matches) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = match.title;
          button.addEventListener("click", () => {
            void this.open(match)
              .then(() => {
                reader.notice.hidden = true;
              })
              .catch(() => {
                reader.notice.textContent = "The activity could not be opened.";
              });
          });
          reader.notice.appendChild(button);
        }
      });
    }
  }

  openDashboard(): Widget {
    if (this.course === null) throw new Error("Course unavailable.");
    if (this.dashboard === null || this.dashboard.isDisposed) {
      this.dashboard = new DashboardWidget(this.course, (coordinate) =>
        this.open(coordinate),
      );
      this.options.shell.add(this.dashboard, "main", { type: "CourseWeave" });
    }
    this.metadata.set(this.dashboard, {
      activePath: null,
      surfaceKind: null,
      terminalSurfaceId: null,
      explicitModuleId: null,
      explicitPhaseId: null,
    });
    this.activate(this.dashboard);
    return this.dashboard;
  }

  openAuthor(): Widget {
    if (this.author === null || this.author.isDisposed) {
      this.author = new AuthorWidget(this.options.serviceOrigin);
      this.options.beforeAuthorAttach?.(this.author, this.author.iframe);
      this.options.shell.add(this.author, "main", { type: "CourseWeave" });
    }
    this.activate(this.author);
    return this.author;
  }

  metadataFor(widget: object | null): SurfaceMetadata | null {
    return widget === null ? null : (this.metadata.get(widget) ?? null);
  }
}

export class SurfaceRequestBroker {
  private listening = false;

  constructor(
    private readonly options: {
      hostWindow: Window;
      childWindow: Window;
      serviceOrigin: string;
      sourceId: string;
      factory: Pick<CourseSurfaceFactory, "open">;
    },
  ) {}

  private readonly listener = (event: MessageEvent<unknown>): void => {
    if (
      !this.listening ||
      event.source !== this.options.childWindow ||
      event.origin !== this.options.serviceOrigin
    )
      return;
    const request = parseOpenSurfaceRequest(event.data);
    if (request === null) return;
    void this.options.factory
      .open(request)
      .then((result) => {
        if (!this.listening) return;
        this.options.childWindow.postMessage(
          {
            type: "courseweave.reader.opened.v1",
            sourceId: this.options.sourceId,
            moduleId: request.moduleId,
            phaseId: request.phaseId,
            surfaceId: request.surfaceId,
            jupyterBaseUrl: result.jupyterBaseUrl,
            htmlSource: result.htmlSource,
          },
          this.options.serviceOrigin,
        );
      })
      .catch(() => undefined);
  };

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.hostWindow.addEventListener("message", this.listener);
  }

  dispose(): void {
    if (!this.listening) return;
    this.listening = false;
    this.options.hostWindow.removeEventListener("message", this.listener);
  }
}
