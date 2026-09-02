import { useEffect, useState, type Dispatch, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@courseweave/ui';
import { createModuleStart, type AuthorDocumentState, type DraftAction, type DraftModule, type DraftPhase, type DraftSelection, type DraftSurface } from './draft';

type OutlineProps = { state: AuthorDocumentState; dispatch: Dispatch<DraftAction> };

function ModuleStartWizard({ dispatch, close }: { dispatch: Dispatch<DraftAction>; close(): void }) {
  const [id, setId] = useState('module');
  const [title, setTitle] = useState('New module');
  const [description, setDescription] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    dispatch({ type: 'module.create', module: { ...createModuleStart(id), title, description } });
    close();
  };
  return <form role="dialog" aria-label="New module" onSubmit={submit}>
    <p>A new module starts with one phase and one surface.</p>
    <label>New module ID<input value={id} onChange={(event) => setId(event.currentTarget.value)} /></label>
    <label>New module title<input value={title} onChange={(event) => setTitle(event.currentTarget.value)} /></label>
    <label>New module description<textarea value={description} onChange={(event) => setDescription(event.currentTarget.value)} /></label>
    <Button type="submit">Create module</Button><Button type="button" onClick={close}>Cancel new module</Button>
  </form>;
}

function selected(selection: DraftSelection, key: string): boolean {
  return (selection.type === 'module' && selection.moduleKey === key)
    || (selection.type === 'phase' && selection.phaseKey === key)
    || (selection.type === 'surface' && selection.surfaceKey === key);
}
function focusByOffset(current: HTMLButtonElement, offset: number) {
  const kind = current.dataset.outlineKind;
  const buttons = Array.from(current.closest('[data-outline]')?.querySelectorAll<HTMLButtonElement>(`button[data-outline-key][data-outline-kind="${kind}"]`) ?? []);
  const next = buttons[buttons.indexOf(current) + offset]; next?.focus();
}
function SelectButton({ label, itemKey, itemKind, selection, dispatch }: { label: string; itemKey: string; itemKind: DraftSelection['type']; selection: DraftSelection; dispatch: Dispatch<DraftAction> }) {
  const choose = () => dispatch({ type: 'select', selection });
  const keys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); focusByOffset(event.currentTarget, 1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); focusByOffset(event.currentTarget, -1); }
  };
  return <button type="button" data-outline-key={itemKey} data-outline-kind={itemKind} aria-pressed={selected(selection, itemKey)} onClick={choose} onKeyDown={keys}>{label}</button>;
}
function SurfaceRow({ module, phase, surface, state, dispatch }: { module: DraftModule; phase: DraftPhase; surface: DraftSurface; state: AuthorDocumentState; dispatch: Dispatch<DraftAction> }) {
  const select = { type: 'surface' as const, moduleKey: module.clientKey, phaseKey: phase.clientKey, surfaceKey: surface.clientKey };
  return <li><SelectButton label={`Select surface ${surface.id || 'unnamed'}`} itemKey={surface.clientKey} itemKind="surface" selection={state.selection} dispatch={() => dispatch({ type: 'select', selection: select })} />
    {selected(state.selection, surface.clientKey) ? <span>
      <Button type="button" onClick={() => dispatch({ type: 'surface.create', moduleKey: module.clientKey, phaseKey: phase.clientKey })}>Add surface</Button>
      <Button type="button" onClick={() => dispatch({ type: 'surface.duplicate', moduleKey: module.clientKey, phaseKey: phase.clientKey, surfaceKey: surface.clientKey })}>Duplicate surface {surface.id || 'unnamed'}</Button>
      <Button type="button" onClick={() => dispatch({ type: 'surface.delete', moduleKey: module.clientKey, phaseKey: phase.clientKey, surfaceKey: surface.clientKey })}>Delete surface {surface.id || 'unnamed'}</Button>
      <Button type="button" onClick={() => dispatch({ type: 'surface.move', moduleKey: module.clientKey, phaseKey: phase.clientKey, surfaceKey: surface.clientKey, direction: 'up' })}>Move surface {surface.id || 'unnamed'} up</Button>
      <Button type="button" onClick={() => dispatch({ type: 'surface.move', moduleKey: module.clientKey, phaseKey: phase.clientKey, surfaceKey: surface.clientKey, direction: 'down' })}>Move surface {surface.id || 'unnamed'} down</Button>
    </span> : null}</li>;
}
function PhaseRow({ module, phase, state, dispatch }: { module: DraftModule; phase: DraftPhase; state: AuthorDocumentState; dispatch: Dispatch<DraftAction> }) {
  const select = { type: 'phase' as const, moduleKey: module.clientKey, phaseKey: phase.clientKey };
  return <li><SelectButton label={`Select phase ${phase.title || phase.id || 'unnamed'}`} itemKey={phase.clientKey} itemKind="phase" selection={state.selection} dispatch={() => dispatch({ type: 'select', selection: select })} />
    {selected(state.selection, phase.clientKey) ? <span>
      <Button type="button" onClick={() => dispatch({ type: 'surface.create', moduleKey: module.clientKey, phaseKey: phase.clientKey })}>Add surface</Button>
      <Button type="button" onClick={() => dispatch({ type: 'phase.create', moduleKey: module.clientKey })}>Add phase</Button>
      <Button type="button" onClick={() => dispatch({ type: 'phase.duplicate', moduleKey: module.clientKey, phaseKey: phase.clientKey })}>Duplicate phase {phase.title || phase.id || 'unnamed'}</Button>
      <Button type="button" onClick={() => dispatch({ type: 'phase.delete', moduleKey: module.clientKey, phaseKey: phase.clientKey })}>Delete phase {phase.title || phase.id || 'unnamed'}</Button>
      <Button type="button" onClick={() => dispatch({ type: 'phase.move', moduleKey: module.clientKey, phaseKey: phase.clientKey, direction: 'up' })}>Move phase {phase.title || phase.id || 'unnamed'} up</Button>
      <Button type="button" onClick={() => dispatch({ type: 'phase.move', moduleKey: module.clientKey, phaseKey: phase.clientKey, direction: 'down' })}>Move phase {phase.title || phase.id || 'unnamed'} down</Button>
    </span> : null}
    <ol>{phase.surfaces.map((surface) => <SurfaceRow key={surface.clientKey} module={module} phase={phase} surface={surface} state={state} dispatch={dispatch} />)}</ol>
  </li>;
}
function ModuleRow({ module, state, dispatch }: { module: DraftModule; state: AuthorDocumentState; dispatch: Dispatch<DraftAction> }) {
  const select = { type: 'module' as const, moduleKey: module.clientKey };
  return <li><SelectButton label={`Select module ${module.title || module.id || 'unnamed'}`} itemKey={module.clientKey} itemKind="module" selection={state.selection} dispatch={() => dispatch({ type: 'select', selection: select })} />
    {selected(state.selection, module.clientKey) ? <span>
      <Button type="button" onClick={() => dispatch({ type: 'phase.create', moduleKey: module.clientKey })}>Add phase</Button>
      <Button type="button" onClick={() => dispatch({ type: 'module.duplicate', moduleKey: module.clientKey })}>Duplicate module {module.title || module.id || 'unnamed'}</Button>
      <Button type="button" onClick={() => dispatch({ type: 'module.delete', moduleKey: module.clientKey })}>Delete module {module.title || module.id || 'unnamed'}</Button>
      <Button type="button" onClick={() => dispatch({ type: 'module.move', moduleKey: module.clientKey, direction: 'up' })}>Move module {module.title || module.id || 'unnamed'} up</Button>
      <Button type="button" onClick={() => dispatch({ type: 'module.move', moduleKey: module.clientKey, direction: 'down' })}>Move module {module.title || module.id || 'unnamed'} down</Button>
    </span> : null}
    <ol>{module.phases.map((phase) => <PhaseRow key={phase.clientKey} module={module} phase={phase} state={state} dispatch={dispatch} />)}</ol>
  </li>;
}
export function Outline({ state, dispatch }: OutlineProps) {
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (state.focusKey === undefined) return;
    document.querySelector<HTMLButtonElement>(`button[data-outline-key="${state.focusKey}"]`)?.focus();
  }, [state.focusKey]);
  return <section aria-label="Outline" data-outline>
    <h2>Outline</h2>
    <Button type="button" onClick={() => setCreating(true)}>Add module</Button>
    {creating ? <ModuleStartWizard dispatch={dispatch} close={() => setCreating(false)} /> : null}
    <ol>{state.draft.modules.map((module) => <ModuleRow key={module.clientKey} module={module} state={state} dispatch={dispatch} />)}</ol>
    <p role="status" aria-live="polite">{state.notice}</p>
  </section>;
}
