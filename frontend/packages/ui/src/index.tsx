import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import { useEffect, useState } from 'react';

export * from './courseweave-types';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`cw-button ${props.className ?? ''}`.trim()} />;
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  'aria-label': string;
  children?: ReactNode;
};

export function IconButton({ 'aria-label': label, ...props }: IconButtonProps) {
  return <button {...props} aria-label={label} className={`cw-icon-button ${props.className ?? ''}`.trim()} />;
}

export function Drawer({ open, children }: PropsWithChildren<{ open: boolean }>) {
  return open ? <aside aria-label="Details">{children}</aside> : null;
}

export function StatusBadge({ children, unavailable = false }: PropsWithChildren<{ unavailable?: boolean }>) {
  return <span className={`cw-status cw-status--${unavailable ? 'unavailable' : 'ready'}`}>{children}</span>;
}

export function EmptyState({ title, children }: PropsWithChildren<{ title: string }>) {
  return <section className="cw-empty-state" aria-live="polite"><h2>{title}</h2>{children}</section>;
}

export function VisuallyHidden({ children }: PropsWithChildren) {
  return <span className="cw-visually-hidden">{children}</span>;
}

export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}
