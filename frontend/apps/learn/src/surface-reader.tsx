import type { CourseSurface } from '@courseweave/ui/courseweave-types';

function unavailable() {
  return <p role="status">This course surface is unavailable.</p>;
}

export function SurfaceReader({ surface, parentOwnsReader = false }: { surface: CourseSurface | null; htmlSource?: string | null; serviceOrigin: string; parentOwnsReader?: boolean }) {
  if (parentOwnsReader && (surface?.type === 'html' || surface?.type === 'video')) {
    return <p role="status">Opened {surface.label ?? surface.id} in the CourseWeave main-area reader.</p>;
  }
  return unavailable();
}
