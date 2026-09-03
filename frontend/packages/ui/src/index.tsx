import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import { useEffect, useState } from 'react';

export * from './courseweave-types';
export * from './author-types';
export * from './authenticated-client';
export * from './learner-phase-preview';
export * from './agui-stream';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`cw-button ${props.className ?? ''}`.trim()} />;
}

type NonEmptyLiteral<Label extends string> = Label extends '' ? never : Label;

export type IconButtonProps<Label extends string = string> = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  'aria-label': NonEmptyLiteral<Label>;
  children?: ReactNode;
};

export function IconButton<const Label extends string>({ 'aria-label': label, ...props }: IconButtonProps<Label>) {
  if (label.trim().length === 0) throw new Error('IconButton requires a non-empty aria-label.');
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
