import { Button, EmptyState } from '@courseweave/ui';
import type { CourseManifest } from '@courseweave/ui/courseweave-types';

export function postOpenSurface(serviceOrigin: string, ids: { moduleId: string; phaseId: string; surfaceId: string }, parentWindow: Pick<Window, 'postMessage'> = window.parent): void {
  if (parentWindow === window) return;
  parentWindow.postMessage({ type: 'courseweave.open-surface.v1', ...ids }, serviceOrigin);
}

export function Dashboard({ course, serviceOrigin }: { course: CourseManifest; serviceOrigin: string }) {
  if (course.modules.length === 0) return <EmptyState title="This course has no modules yet"><p>Ask your course author to add a module.</p></EmptyState>;
  return <section aria-label="Course dashboard">{course.modules.map((module) => <section key={module.id}><h2>{module.title}</h2>{module.phases.map((phase) => <section key={phase.id}><h3>{phase.title}</h3>{phase.surfaces.map((surface) => <Button key={surface.id} type="button" onClick={() => postOpenSurface(serviceOrigin, { moduleId: module.id, phaseId: phase.id, surfaceId: surface.id })}>Open {surface.label ?? surface.id}</Button>)}</section>)}</section>)}</section>;
}
