import {
  findSurface,
  type CourseManifest,
  type CourseSurface,
} from "@courseweave/ui/courseweave-types";
import { useCallback, useEffect, useRef, useState } from "react";

import type { TrustedRuntimeConfiguration } from "./runtime";

export type ReaderNavigationOutcome = {
  type: "courseweave.reader.opened.v1";
  sourceId: string;
  moduleId: string;
  phaseId: string;
  surfaceId: string;
  jupyterBaseUrl?: string;
  htmlSource: string | null;
};

export type ReaderRoute = {
  surface: CourseSurface;
  htmlSource: string | null;
  parentOpened: boolean;
};
export type ReaderCoordinate = {
  moduleId: string;
  phaseId: string;
  surface: CourseSurface;
};
export type ReaderIntent = ReaderCoordinate & {
  sourceId: string;
  clickContextVersion: number;
  runtimeIdentity: string | null;
  status: "pending" | "context-confirmed";
};
export type StoredReaderOutcome = {
  outcome: ReaderNavigationOutcome;
  coordinate: ReaderCoordinate;
  status: "provisional" | "confirmed";
  contextVersion: number;
  runtimeIdentity: string | null;
};
export type ReaderRouteController = {
  route: ReaderRoute | null;
  requestNavigation(coordinate: ReaderCoordinate): void;
};

function isCanonicalHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.href === value
    );
  } catch {
    return false;
  }
}

function canonicalJupyterBaseUrl(
  value: unknown,
  expectedParentOrigin: string,
): URL | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== expectedParentOrigin ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.href !== value ||
      !parsed.pathname.endsWith("/") ||
      parsed.pathname.includes("%")
    )
      return null;
    const segments = parsed.pathname.split("/").slice(1, -1);
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment === "files",
      )
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

function isLocalHtmlSource(
  value: string,
  jupyterBaseUrl: unknown,
  expectedParentOrigin: string,
): boolean {
  const base = canonicalJupyterBaseUrl(jupyterBaseUrl, expectedParentOrigin);
  if (base === null) return false;
  try {
    const parsed = new URL(value);
    if (
      parsed.origin !== expectedParentOrigin ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.href !== value
    )
      return false;
    if (parsed.hash) {
      const fragment = decodeURIComponent(parsed.hash.slice(1));
      if (
        !/^[A-Za-z][A-Za-z0-9_.:-]{0,159}$/.test(fragment) ||
        `#${encodeURIComponent(fragment)}` !== parsed.hash
      )
        return false;
    }
    const prefix = [`${base.pathname}courseweave/reader/`,`${base.pathname}files/`].find(candidate=>parsed.pathname.startsWith(candidate));
    if (!prefix) return false;
    const segments = parsed.pathname.slice(prefix.length).split("/");
    return (
      segments.length > 0 &&
      segments.every((segment) => {
        if (segment.length === 0) return false;
        const decoded = decodeURIComponent(segment);
        return (
          decoded !== "." &&
          decoded !== ".." &&
          decoded !== "files" &&
          !decoded.includes("/") &&
          !decoded.includes("\\") &&
          !decoded.includes("%") &&
          encodeURIComponent(decoded) === segment
        );
      })
    );
  } catch {
    return false;
  }
}

function localSurfaceSource(
  path: string,
  base: string,
  fragment?: string | null,
  reader = true,
): string | null {
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        segment.includes("%"),
    ) ||
    path.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
  )
    return null;
  return (
    new URL(`${reader ? "courseweave/reader" : "files"}/${segments.map(encodeURIComponent).join("/")}`, base).href +
    (fragment ? `#${encodeURIComponent(fragment)}` : "")
  );
}

export function selectReaderRoute(
  course: CourseManifest,
  sourceId: string,
  outcome: ReaderNavigationOutcome,
  active?: ReaderCoordinate,
  expectedParentOrigin?: string,
): ReaderRoute | null {
  if (outcome.sourceId !== sourceId) return null;
  const surface = findSurface(
    course,
    outcome.moduleId,
    outcome.phaseId,
    outcome.surfaceId,
  );
  if (surface === null || !["html", "video"].includes(surface.type))
    return null;
  if (
    active !== undefined &&
    (active.moduleId !== outcome.moduleId ||
      active.phaseId !== outcome.phaseId ||
      active.surface.id !== surface.id ||
      active.surface.type !== surface.type)
  )
    return null;
  if (expectedParentOrigin !== undefined) {
    if (
      canonicalJupyterBaseUrl(outcome.jupyterBaseUrl, expectedParentOrigin) ===
      null
    )
      return null;
    if (
      surface.type === "html" &&
      (outcome.htmlSource === null ||
        !isLocalHtmlSource(
          outcome.htmlSource,
          outcome.jupyterBaseUrl,
          expectedParentOrigin,
        ) ||
        outcome.htmlSource !==
          localSurfaceSource(
            surface.path,
            outcome.jupyterBaseUrl!,
            surface.fragment,
          ))
    )
      return null;
    if (surface.type === "video") {
      const expected = isCanonicalHttpsUrl(surface.src)
        ? surface.src
        : localSurfaceSource(surface.src, outcome.jupyterBaseUrl!, undefined, false);
      if (expected === null || outcome.htmlSource !== expected) return null;
    }
  }
  return {
    surface,
    htmlSource: surface.type === "html" ? outcome.htmlSource : null,
    parentOpened: true,
  };
}

function sameCoordinate(
  left: ReaderCoordinate,
  right: ReaderCoordinate,
): boolean {
  return (
    left.moduleId === right.moduleId &&
    left.phaseId === right.phaseId &&
    left.surface.id === right.surface.id &&
    left.surface.type === right.surface.type
  );
}

export function createReaderIntent(
  sourceId: string,
  coordinate: ReaderCoordinate,
  clickContextVersion: number = 0,
  runtimeIdentity: string | null = null,
): ReaderIntent {
  return {
    sourceId,
    ...coordinate,
    clickContextVersion,
    runtimeIdentity,
    status: "pending",
  };
}

export function reconcileReaderIntent(
  pending: ReaderIntent,
  sourceId: string,
  active: ReaderCoordinate | null,
  contextVersion: number,
  runtimeIdentity: string | null = null,
): ReaderIntent | null {
  if (
    pending.sourceId !== sourceId ||
    pending.runtimeIdentity !== runtimeIdentity
  )
    return null;
  if (contextVersion > pending.clickContextVersion)
    return active !== null && sameCoordinate(pending, active)
      ? { ...pending, status: "context-confirmed" }
      : null;
  return pending;
}

export function acceptReaderOutcome(
  course: CourseManifest,
  pending: ReaderIntent | null,
  outcome: ReaderNavigationOutcome,
  active: ReaderCoordinate | null,
  contextVersion: number,
  runtimeIdentity: string | null = null,
  expectedParentOrigin?: string,
): StoredReaderOutcome | null {
  const current =
    pending === null
      ? null
      : reconcileReaderIntent(
          pending,
          pending.sourceId,
          active,
          contextVersion,
          runtimeIdentity,
        );
  const route =
    current === null
      ? null
      : selectReaderRoute(
          course,
          current.sourceId,
          outcome,
          undefined,
          expectedParentOrigin,
        );
  if (
    current === null ||
    route === null ||
    outcome.moduleId !== current.moduleId ||
    outcome.phaseId !== current.phaseId ||
    outcome.surfaceId !== current.surface.id ||
    route.surface.type !== current.surface.type
  )
    return null;
  return {
    outcome,
    coordinate: {
      moduleId: current.moduleId,
      phaseId: current.phaseId,
      surface: route.surface,
    },
    status:
      current.status === "context-confirmed" ? "confirmed" : "provisional",
    contextVersion,
    runtimeIdentity,
  };
}

export function reconcileReaderOutcome(
  stored: StoredReaderOutcome,
  sourceId: string,
  active: ReaderCoordinate | null,
  contextVersion: number,
  runtimeIdentity: string | null = null,
): StoredReaderOutcome | null {
  if (
    stored.outcome.sourceId !== sourceId ||
    stored.runtimeIdentity !== runtimeIdentity
  )
    return null;
  if (
    stored.status === "provisional" &&
    contextVersion > stored.contextVersion
  ) {
    return active !== null && sameCoordinate(stored.coordinate, active)
      ? { ...stored, status: "confirmed" }
      : null;
  }
  return stored.status === "confirmed" &&
    (active === null || !sameCoordinate(stored.coordinate, active))
    ? null
    : stored;
}

export function parseReaderNavigation(
  value: unknown,
  expectedParentOrigin: string,
  allowedVideoUrls: readonly string[] = [],
): ReaderNavigationOutcome | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const data = value as Record<string, unknown>;
  const expectedKeys = [
    "htmlSource",
    "jupyterBaseUrl",
    "moduleId",
    "phaseId",
    "sourceId",
    "surfaceId",
    "type",
  ];
  if (Object.keys(data).sort().join(",") !== expectedKeys.join(","))
    return null;
  if (
    data.type !== "courseweave.reader.opened.v1" ||
    (data.htmlSource !== null && typeof data.htmlSource !== "string")
  )
    return null;
  const fields = ["sourceId", "moduleId", "phaseId", "surfaceId"] as const;
  if (
    fields.some(
      (field) =>
        typeof data[field] !== "string" ||
        data[field].trim() !== data[field] ||
        data[field].length === 0,
    )
  )
    return null;
  if (
    canonicalJupyterBaseUrl(data.jupyterBaseUrl, expectedParentOrigin) === null
  )
    return null;
  if (
    data.htmlSource !== null &&
    !isLocalHtmlSource(
      data.htmlSource,
      data.jupyterBaseUrl,
      expectedParentOrigin,
    ) &&
    !(
      isCanonicalHttpsUrl(data.htmlSource) &&
      allowedVideoUrls.includes(data.htmlSource)
    )
  )
    return null;
  return data as ReaderNavigationOutcome;
}

function readerSurface(surface: CourseSurface | null): ReaderRoute | null {
  return surface !== null &&
    (surface.type === "html" || surface.type === "video")
    ? { surface, htmlSource: null, parentOpened: false }
    : null;
}

export function useReaderRoute(
  course: CourseManifest,
  runtime: TrustedRuntimeConfiguration,
  active: ReaderCoordinate | null,
  contextVersion: number,
): ReaderRouteController {
  const [stored, setStored] = useState<StoredReaderOutcome | null>(null);
  const pending = useRef<ReaderIntent | null>(null);
  const activeIdentity =
    active === null
      ? null
      : `${active.moduleId}/${active.phaseId}/${active.surface.id}/${active.surface.type}`;
  const runtimeIdentity = `${runtime.sourceId}/${runtime.serviceOrigin}/${runtime.expectedParentOrigin}`;
  const activeRef = useRef(active);
  const contextVersionRef = useRef(contextVersion);
  const runtimeRef = useRef(runtime);
  const runtimeIdentityRef = useRef(runtimeIdentity);
  activeRef.current = active;
  contextVersionRef.current = contextVersion;
  runtimeRef.current = runtime;
  runtimeIdentityRef.current = runtimeIdentity;

  const requestNavigation = useCallback((coordinate: ReaderCoordinate) => {
    pending.current = createReaderIntent(
      runtimeRef.current.sourceId,
      coordinate,
      contextVersionRef.current,
      runtimeIdentityRef.current,
    );
  }, []);

  useEffect(() => {
    pending.current = null;
    setStored(null);
  }, [runtimeIdentity]);

  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      const currentRuntime = runtimeRef.current;
      if (
        event.source !== window.parent ||
        event.origin !== currentRuntime.expectedParentOrigin
      )
        return;
      const allowedVideoUrls = course.modules.flatMap((module) =>
        module.phases.flatMap((phase) =>
          phase.surfaces.flatMap((surface) =>
            surface.type === "video" && typeof surface.src === "string"
              ? [surface.src]
              : [],
          ),
        ),
      );
      const next = parseReaderNavigation(
        event.data,
        currentRuntime.expectedParentOrigin,
        allowedVideoUrls,
      );
      const reconciled =
        pending.current === null
          ? null
          : reconcileReaderIntent(
              pending.current,
              currentRuntime.sourceId,
              activeRef.current,
              contextVersionRef.current,
              runtimeIdentityRef.current,
            );
      pending.current = reconciled;
      const accepted =
        next === null
          ? null
          : acceptReaderOutcome(
              course,
              reconciled,
              next,
              activeRef.current,
              contextVersionRef.current,
              runtimeIdentityRef.current,
              currentRuntime.expectedParentOrigin,
            );
      if (accepted !== null) {
        pending.current = null;
        setStored(accepted);
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [course]);

  useEffect(() => {
    pending.current =
      pending.current === null
        ? null
        : reconcileReaderIntent(
            pending.current,
            runtime.sourceId,
            active,
            contextVersion,
            runtimeIdentity,
          );
    setStored((current) =>
      current === null
        ? null
        : reconcileReaderOutcome(
            current,
            runtime.sourceId,
            active,
            contextVersion,
            runtimeIdentity,
          ),
    );
  }, [runtimeIdentity, activeIdentity, contextVersion]);

  const current =
    stored === null
      ? null
      : reconcileReaderOutcome(
          stored,
          runtime.sourceId,
          active,
          contextVersion,
          runtimeIdentity,
        );
  return {
    route:
      current === null
        ? readerSurface(active?.surface ?? null)
        : selectReaderRoute(
            course,
            runtime.sourceId,
            current.outcome,
            undefined,
            runtime.expectedParentOrigin,
          ),
    requestNavigation,
  };
}
