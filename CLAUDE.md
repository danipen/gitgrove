# GitGrove

A fast, beautiful desktop git client. Electron + React 19 + TypeScript, diffs by
`@pierre/diffs`. The whole point: **full power of git, silly-simple UI** — one window,
three tabs (Changes, History, Graph), no ceremony.

## Principles (the bar every change is held to)

- **Clean code — the most important principle.** Clean for humans *and* for LLMs. Names
  (files, classes, methods, vars) are precise and reveal intent. Methods are small and
  readable; files stay small — when something grows, split it into meaningful, cohesive
  pieces. No clever tricks, no dead code, no duplication. Optimize for the next reader.
- **Max UX.** Advanced git (interactive rebase, hunk-level staging, worktrees, conflict
  resolution) must feel effortless — never drop the user into a terminal, editor, or git
  jargon they didn't ask for.
- **Simple UI, powerful engine.** Complexity lives in the main process, never in the
  user's face. If a feature needs explaining, the design isn't done.
- **Elegant, fast, reliable, beautiful** — UI *and* code. Two themes, one calm layout.
  Reads never block writes; checkboxes never touch git. Destructive actions ask once.

Favor fewer, sharper features over more knobs. Ask: *does this keep the UI silly-simple
while letting an expert reach for real git power?*

## Architecture

Three isolated layers; the renderer **never** touches git or Node directly.

```
src/main/     Node + Electron. All git work, by shelling out to the raw `git` binary.
src/preload/  Typed, sandboxed bridge (contextIsolation on, nodeIntegration off).
src/renderer/ React 19 UI. Talks to main only through window.gitgrove.
src/shared/   Types + the IPC contract, imported by all three.
```

**The IPC contract is the spine** (`src/shared/ipc.ts`, types in `types.ts`). Adding a
capability touches, in order: `shared/types.ts` → `shared/ipc.ts` (channel + `GitGroveApi`
method) → `preload/index.ts` (forward the invoke) → `main/ipc.ts` (`ipcMain.handle`) →
renderer. Don't bypass it.

**Git layer (`src/main/git/`)** — no wrapper library; a single `execFile`/`spawn` entry
point with exact control over args and exit codes (the GitHub Desktop approach). Read it
before adding git calls — its conventions are load-bearing:
- `read.ts` (read side): `GIT_OPTIONAL_LOCKS=0` so reads never take the index lock; all
  path/text output is **NUL-delimited** (`-z`/`%x00`).
- `exec.ts` (write runner): mutating ops **serialized per repo** via a single shared
  write queue + lock retry ladder; never prompt (`GIT_TERMINAL_PROMPT` off). The
  operations live in `write.ts` (staging, commits, branches, stash, worktrees, …;
  signing inherited from the user's git config), `sync.ts` (fetch/pull/push/clone — off
  the queue: they never take the index lock) and `rebase.ts` (interactive rebase scripted
  via editor shims — **no terminal editor opens**).
- `bin.ts` locates git (PATH, then GitHub Desktop's copy); `status.ts` snapshots.

**App shell (`src/main/`)** — `index.ts` (lifecycle + window), `ipc.ts` (registers the
handlers), `menu.ts`, `watcher.ts` (pushes `repo:changed`), `updater.ts`, `store.ts`.

**Renderer (`src/renderer/src/`)** — `App.tsx` (shared state + the cross-feature
orchestration spine that wires the tabs together); `components/` (one component — or
the hook that drives just that feature — per file) grouped by feature: `changes/`,
`history/`, `graph/` (the Graph tab's 2D branch explorer: pure layout in `layout.ts`,
crossing-aware row packing in `packing.ts`, canvas drawing in `render.ts`, interactions
in `GraphCanvas.tsx` — keep layout logic pure and tested), `toolbar/`, `app/` (shell screens + app-level dialogs) and `common/` (shared
widgets and primitives — same-folder imports stay relative, cross-folder go through `@/`);
`lib/` (the **shared tier**: pure logic + hooks reused by 2+ features — a hook used by
exactly one feature lives in that feature's folder, not here. `lib/staging.ts` is the
**heart of hunk-level staging**: checkboxes are pure renderer state, git touched only at
commit time; the change block is rendered to a unified patch and `git apply --cached`'d);
`styles/` (two themes, one layout — see **CSS** below).

## Commands

**Bun** for installs/tests/scripts; `git` must be on PATH.

```bash
bun run dev        # launch with hot reload
bun run dev:debug  # same, CDP on :9222 for Playwright attach
bun run typecheck  # tsc --noEmit
bun test           # bun:test (*.test.ts colocated with source)
bun run lint       # biome check . — exactly what CI runs (lint:fix to auto-fix)
bun run e2e        # Playwright Electron smoke test (builds first)
```

Before claiming done, run `lint`, `typecheck`, and `test` — green locally means green in
CI. (`bun` may not be on PATH in tool shells — prefix `export PATH="$HOME/.bun/bin:$PATH";`.)

**Validate visually with Playwright.** For anything complex or that needs to be seen —
UI, layout, diff rendering, themes, multi-step flows — drive the real app, don't just
trust types and tests. **Always use the `playwright-cli` skill for this** (it's
installed) — don't hand-roll Playwright calls. The flow: `bun run dev:debug`, then attach
over CDP and exercise/screenshot the change. (`scripts/verify-ui.mjs` shows the launch
pattern.) Beauty and UX are verified on screen, not in the diff.

## CSS

Styling is **global by design** — not CSS Modules. One layout, two themes, shared
primitives, and a single z-index ladder, so the cascade is a deliberate tool, not an
accident. `styles/global.css` is a **manifest** (`@import`s only); Vite inlines them at
build time, so it still ships as one stylesheet (zero runtime cost). Files are **tiered by
reuse** so "common vs specific" is answerable by *which file a rule lives in*:

- `base.css` — the design system: tokens, the two `[data-theme]` palettes, reset, shared
  keyframes (`spin`, `pop-in`), and the **z-index layering contract** (the one global
  stacking order — keep new overlays on that ladder).
- `layout.css` — the app skeleton (shell, sidebar frame, workspace column).
- `primitives.css` — **common**: widgets reused by 2+ features (popover, tooltip, menus,
  buttons, modal shell, toast, segmented, icon-btn, avatar, resizers, virtual list, …).
- `features/*.css` — **specific**: one file per feature folder (`toolbar`, `history`,
  `graph`, `diff`, `blame`, `changes`, `conflict`, `screens`, `banners`, `dialogs`,
  `image-diff`).

Rules for keeping it maintainable:

- **The reuse rule (load-bearing).** A class used by **2+ features → `primitives.css`**;
  used by **1 → that feature's file**. When a feature rule gains a second caller, *promote*
  it to primitives in the same change; when a primitive loses its second caller, push it
  down. This keeps `primitives.css` an honest inventory of what's shared — and stops two
  features quietly reinventing the same widget.
- **One class-prefix namespace per file**, so a class name tells you its file (`.blame-*`/
  `.fh-*` → `blame.css`, `.wfl__*` → `changes.css`). CSS comments already cite their
  component (`BlamePane.tsx`); when you touch a component, add the reverse `// styles:`
  pointer to its file so the link is one hop in both directions.
- **`@import` order is the cascade.** base → layout → primitives → features, and a feature
  that restyles another's element loads after it (`diff` before `blame`/`image-diff`;
  `changes` before `dialogs`). Reordering imports can silently change which rule wins.
- **Comments are load-bearing** here too (compositor/scroll-timeline tricks, sub-pixel
  rounding, tile-memory notes). Don't strip rationale when moving rules between files.
- **Verify visually.** CSS isn't typechecked; a split or refactor is only done once the app
  renders identically on screen (Playwright) with no console errors — see above.

## Conventions

- **Biome enforces style**: single quotes, no semicolons, 2-space indent, 100 cols, no
  trailing commas. Run `lint:fix`, don't hand-format.
- **Path aliases:** `@/` → `src/renderer/src/`, `@shared/` → `src/shared/`.
- **Comments explain *why*, richly** (lock semantics, NUL delimiting, PATH probing).
  Match that density on tricky code; don't strip existing rationale.
- **Every filterable list highlights its matches.** A type-to-filter list (repos,
  branches, the clone repo picker, the commit file list, …) must wrap the matched text in
  the list rows using the shared helper (`lib/highlight.tsx`: `highlightMatch` for a single
  whole-query substring, `highlightTerms` for whitespace-split term filters) — same `<mark
  class="hl">` UX everywhere. When a list filters across multiple fields, highlight *every*
  field it searches (e.g. the clone picker matches and highlights name **and** description).
  Never ship a filter that narrows the list without showing *why* each row matched.
- **Sidebar banners carry at most one button.** Banners (`.op-banner`,
  `.stash-reminder`) live in a narrow column: every extra button steals width from the
  message and wraps it into a skinny multi-line column. One compact button per banner;
  when more actions are needed, use a split button whose caret opens a popover (see
  `StashReminder`), with destructive options confirmed from there.
- **Tests** are colocated `*.test.ts`; git tests are integration tests driving the real
  `git` binary against a throwaway repo, not mocks. TypeScript is strict — no new `any`.
- **Every new behaviour or spec change ships with unit tests.** Tests must be
  **reliable, never flaky** — no timing races, no shared mutable state, no ordering
  assumptions. Design for testability *before* writing code: keep logic pure and
  separable (see `lib/staging.ts`), so it can be tested directly without driving the UI.
- **GitGrove is cross-platform — Windows, Linux, and macOS are all first-class.** CI runs
  the suite on all three, and Windows is where platform assumptions bite: code and tests
  written on macOS routinely pass locally but fail on the Windows runner. Guard against it
  *while writing*, not after CI goes red. Watch for: path separators (`path.join`/
  `path.sep`, never hardcoded `/`), line endings (`\r\n` vs `\n` — git's `core.autocrlf`
  can rewrite them), absolute-path and drive-letter shapes (`C:\…`), case-insensitive
  filesystems, temp-dir locations, and shelling out to platform-specific binaries or
  shell syntax. Tests especially must not bake in POSIX-only paths, separators, or
  newlines — normalize, or assert in a platform-agnostic way.
