// Browser-only Jupyter dependency ports; the plugin, broker, publisher and iframe are production code.
export const ILabShell = "shell";
export const ICommandPalette = "palette";
export const IDocumentManager = "documents";
export const IEditorTracker = "editor";
export const INotebookTracker = "notebook";
export const ISettingRegistry = "settings";
export const ITerminalTracker = "terminal";
export const PageConfig = {
  getBaseUrl: () => "/",
  getOption: (key: string) =>
    ({
      courseweaveServiceUrl: location.origin,
      courseweaveRuntimeId: "synthetic",
      courseweaveLaunchMode: "learn",
    })[key] ?? "",
};
export const URLExt = {
  join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
};
export const ServerConnection = {
  makeSettings: () => ({ baseUrl: "/" }),
  makeRequest: (url: string, init: RequestInit) => fetch(url, init),
};
