# Task 5 Slice 5.2 report — Draft domain, outline, and inspector

## Status

Implemented the Slice 5.2 local-only Author manifest editor. The browser now
owns an immutable, client-keyed full schema-v1 draft with no persistence action
in this slice. The change is committed as `feat: add Author manifest editor`.

## RED evidence

The specified initial RED command was run before any production module existed:

```text
pnpm --dir frontend --filter @courseweave/author test -- draft outline inspector
Failed Suites 3: draft.test.ts, outline.test.tsx, inspector.test.tsx
Failed to resolve import "../src/draft" ... Does the file exist?
Exit status 1
```

That demonstrates the three new suites were not accidentally passing against
existing Author shell behavior. Two later behavior-level RED checks were also
captured before their corresponding production changes:

- `shell.test.tsx`: unable to find `Select module Module` after a read-only
  course response (the app still rendered placeholders).
- `outline.test.tsx`: unable to find dialog `New module` after `Add module`
  (the former button immediately created a default module).

Each became green only after adding the respective editor hydration and
valid-start wizard behavior.

## Requirements to tests

| Slice requirement | Executable coverage |
| --- | --- |
| Pure module/phase/surface create, edit, delete, duplicate, move; exact order; no mutation | `frontend/apps/author/test/draft.test.ts`: first two reducer cases snapshot input and assert each array sequence. |
| Rich deep duplicate and fresh entity IDs while external content stays exact | `draft.test.ts`: rich fixture includes notebook match, local/remote video, terminal argv/cwd, external URL, all capabilities, and all completion variants. |
| Slug collisions, editable blank/duplicate IDs, stable selection/client keys | `draft.test.ts`: collision through `lesson-copy-4`, blank duplicate phase IDs, and selection/client-key preservation through reorder. |
| Entry repair | `draft.test.ts`: rename, entry delete, final delete, unrelated delete, and reorder. |
| Valid start and incomplete memory-only draft | `outline.test.tsx`: accessible valid-start wizard; `draft.test.ts`: incomplete IDs/titles remain unchanged and dirty. `shell.test.tsx` confirms no Save action. |
| Full Inspector schema surface and discriminator cleanup | `inspector.test.tsx`: course/policy fields, module metadata, all phase/mode options, capabilities, completions, every surface type, and stale-field removal from the form projection path. |
| Keyboard/action accessibility | `outline.test.tsx`: native list/buttons, Arrow navigation, labelled CRUD/move controls, post-move/delete focus, and polite live announcements. |
| Nine-kind inert preview | `inspector.test.tsx`: every phase kind renders a shared `LearnerPhasePreview` with an explicit inert status and no buttons. |
| Read-only shell integration | `shell.test.tsx`: a GET result hydrates the in-memory editor without a Save action. |

## Production files

- `frontend/packages/ui/src/author-types.ts`: named full Author policy and
  notebook-match types alongside the established learner view.
- `frontend/packages/ui/src/learner-phase-preview.tsx`: shared, callback-free
  nine-kind preview; exported from `frontend/packages/ui/src/index.tsx`.
- `frontend/apps/author/src/draft.ts`: draft client identity, projection
  boundary, defaults, slug allocation, dirty comparison, and pure reducer.
- `frontend/apps/author/src/outline.tsx`: ordered accessible outline and
  valid-start module wizard.
- `frontend/apps/author/src/inspector.tsx`: native, discriminated inspector
  controls with array-valued argv/glob/tag/cell-ID editing.
- `frontend/apps/author/src/app.tsx`: read-only course hydration and local
  editor composition.

## Verification

All commands ran from `/Volumes/mac-studio-ssd/education/courseweave/.worktrees/courseweave-v0-sdd`:

```text
pnpm --dir frontend install --frozen-lockfile                         PASS
pnpm --dir frontend --filter @courseweave/author test -- draft outline inspector
  6 files, 20 tests PASS
pnpm --dir frontend --filter @courseweave/ui run typecheck            PASS
pnpm --dir frontend --filter @courseweave/author run typecheck        PASS
pnpm --dir frontend --filter @courseweave/learn test
  12 files, 134 tests PASS
pnpm --dir frontend --filter @courseweave/learn run typecheck         PASS
pnpm --dir frontend --filter @courseweave/author exec vite build --outDir <mktemp>
  25 modules transformed; PASS
git diff --check                                                      PASS
```

The focused security scan found no persistence, dynamic-HTML, cookie, storage,
execution, navigation, or unsafe-evaluation sink. The only `fetch` match is
the pre-existing authenticated Author API boundary in `src/api.ts`; no draft,
outline, inspector, or preview code issues a request.

## Scope and residual risks

- No import/export, validation, runnable artifact checks, Save, recovery, or
  curriculum-teacher behavior was added; those are deliberately Slice 5.3+
  responsibilities.
- The production static Author bundle was built only into a temporary directory
  for this slice. Rebuilding and committing static assets is Slice 5.5 work.
- Local drafts are intentionally allowed to be incomplete and memory-only;
  structural validation will be introduced at the server boundary in Slice 5.3.

## Commit

`feat: add Author manifest editor`
