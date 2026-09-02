import { findSurface, type CourseManifest, type CourseSurface } from '@courseweave/ui/courseweave-types';
import { useEffect, useState } from 'react';

import type { RuntimeConfiguration } from './api';

export type ReaderNavigationOutcome = {
  type: 'courseweave.reader.opened.v1';
  sourceId: string;
  moduleId: string;
  phaseId: string;
  surfaceId: string;
  htmlSource: string | null;
};

export type ReaderRoute = { surface: CourseSurface; htmlSource: string | null };

export function selectReaderRoute(course: CourseManifest, sourceId: string, outcome: ReaderNavigationOutcome): ReaderRoute | null {
  if (outcome.sourceId !== sourceId) return null;
  const surface = findSurface(course, outcome.moduleId, outcome.phaseId, outcome.surfaceId);
  if (surface === null || !['html', 'video'].includes(surface.type)) return null;
  return { surface, htmlSource: surface.type === 'html' ? outcome.htmlSource : null };
}

function parseReaderNavigation(value: unknown): ReaderNavigationOutcome | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const expectedKeys = ['htmlSource', 'moduleId', 'phaseId', 'sourceId', 'surfaceId', 'type'];
  if (Object.keys(data).sort().join(',') !== expectedKeys.join(',')) return null;
  if (data.type !== 'courseweave.reader.opened.v1' || (data.htmlSource !== null && typeof data.htmlSource !== 'string')) return null;
  const fields = ['sourceId', 'moduleId', 'phaseId', 'surfaceId'] as const;
  if (fields.some((field) => typeof data[field] !== 'string' || data[field].trim() !== data[field] || data[field].length === 0)) return null;
  return data as ReaderNavigationOutcome;
}

function readerSurface(surface: CourseSurface | null): ReaderRoute | null {
  return surface !== null && (surface.type === 'html' || surface.type === 'video') ? { surface, htmlSource: null } : null;
}

export function useReaderRoute(course: CourseManifest, runtime: RuntimeConfiguration, activeSurface: CourseSurface | null): ReaderRoute | null {
  const [outcome, setOutcome] = useState<ReaderNavigationOutcome | null>(null);
  const activeIdentity = activeSurface === null ? null : `${activeSurface.id}/${activeSurface.type}`;

  useEffect(() => {
    setOutcome(null);
  }, [runtime.sourceId, activeIdentity]);

  useEffect(() => {
    const listener = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== runtime.serviceOrigin) return;
      const next = parseReaderNavigation(event.data);
      if (next !== null && selectReaderRoute(course, runtime.sourceId, next) !== null) setOutcome(next);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [course, runtime]);

  return outcome === null ? readerSurface(activeSurface) : selectReaderRoute(course, runtime.sourceId, outcome);
}
