import type { CourseSurface } from '@courseweave/ui/courseweave-types';

function unavailable() {
  return <p role="status">This course surface is unavailable.</p>;
}

function trustedHtmlSource(value: string | null | undefined, serviceOrigin: string): string | null {
  if (typeof value !== 'string') return null;
  try {
    const source = new URL(value);
    return (source.protocol === 'http:' || source.protocol === 'https:') && source.origin === new URL(serviceOrigin).origin && source.username.length === 0 && source.password.length === 0 && source.search.length === 0 && source.hash.length === 0 ? source.href : null;
  } catch {
    return null;
  }
}

function trustedVideoSource(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  try {
    const source = new URL(value);
    return source.protocol === 'https:' && source.username.length === 0 && source.password.length === 0 ? source.href : null;
  } catch {
    return null;
  }
}

export function SurfaceReader({ surface, htmlSource, serviceOrigin, parentOwnsReader = false }: { surface: CourseSurface | null; htmlSource?: string | null; serviceOrigin: string; parentOwnsReader?: boolean }) {
  if (parentOwnsReader && (surface?.type === 'html' || surface?.type === 'video')) {
    return <p role="status">Opened in the CourseWeave main-area reader.</p>;
  }
  if (surface?.type === 'html') {
    const source = trustedHtmlSource(htmlSource, serviceOrigin);
    return source === null ? unavailable() : <iframe className="cw-surface-reader__media" title={surface.label ?? surface.id} src={source} sandbox="allow-scripts" referrerPolicy="no-referrer" />;
  }
  if (surface?.type === 'video') {
    const source = trustedVideoSource(surface.url);
    return source === null ? unavailable() : <video className="cw-surface-reader__media" title={surface.label ?? surface.id} src={source} controls />;
  }
  return unavailable();
}
