# AI in GitGrove — where it shines

Premise: **silly-simple UI, beast of an engine, bring-your-own AI backend.** No GitGrove
AI service, no bill. The user points GitGrove at any OpenAI-compatible endpoint
(OpenAI, Anthropic, Gemini, LiteLLM, Ollama, OpenRouter, a corporate proxy) and every
feature below lights up. No key configured → the features simply don't exist in the UI.
No nagging, no upsell.

The killer insight for a git client: **the "RAG" is already there — it's the repo.**
`git log`, `blame`, `fileHistory`, `patch-id`, `merge-tree` give exact, deterministic
context. No vector DB, no indexing service. The main-process git layer already exposes
everything needed; AI features are mostly *prompt assembly over existing reads*.

---

## Tier 1 — daily drivers (do these first)

### 1. Commit message generation ✨
**Where:** `CommitComposer` (Changes tab).
**UX:** one sparkle button (or auto ghost-text in the empty summary field, Tab to accept).
**Engine — why ours beats everyone else's:**
- Generate from **exactly the selected hunks**, not the whole working tree.
  `lib/staging.ts` already renders the checkbox state to unified patches — feed those.
  No other client gets this right.
- **Style matching:** include the last ~30 commit subjects from `getLog` so the message
  matches the repo's convention (conventional commits, ticket prefixes, mood) without a
  single setting.
- Amend mode: include the previous message (`lastCommitMessage`) as the base to refine.

### 2. Branch name from pending changes
**Where:** `CreateBranchDialog` — exactly the flow you described. The dialog already
handles dirty state via `PendingChangesChoice` (bring/leave changes).
**UX:** the name field is prefilled with a suggested slug (`fix/stash-panel-empty-state`)
as placeholder ghost text; typing replaces it, Enter accepts it.
**Engine:** working diff summary → slug, constrained by `validateRefName` and the repo's
observed naming style (scan existing branch names for `feat/`-vs-`feature/` conventions).

### 3. AI conflict resolution (the crown jewel)
**Where:** `ConflictPanel`. Also `MergeDialog` — `mergePreview` (dry-run `merge-tree`)
already knows the conflicted paths *before* merging, so the dialog can say
*"3 conflicts — AI can propose resolutions"* up front.
**UX:** one button per conflicted file: **"Resolve with AI"**. The proposal appears in
the existing three-way viewer as a fourth "proposed" side with a one-line rationale per
conflict region. Accept writes the file + `markResolved`. **Never auto-applies.**
**Engine — repo history as context, all from existing reads:**
- `conflictSides` → base / ours / theirs content
- `getLog ours..theirs -- <file>` → the commits (messages + diffs) that *created* each
  side — this is what a human reads to resolve, and no GUI client does it
- `getBlame` on the conflicted region → who touched it and why
- `getFileHistory` → recent evolution of the file
Same engine reused for cherry-pick, rebase, revert and stash-apply conflicts for free
(they all flow through the same `RepoState` + `ConflictPanel`).

### 4. "Explain this" — commits and diffs
**Where:** context menu / one icon in `DiffViewer`, `CommitSummary`, and the Graph
detail pane.
**UX:** hover-card or side-note: what changed, why it likely changed, what to watch out
for. Works on a commit, a file diff, or the whole working tree.
**Engine:** `commitDiff`/`workingDiff` + the commit message + touched files' recent
history. Streamed, cached per commit hash (immutable → cache forever).

---

## Tier 2 — power features that stay silly-simple

### 5. Interactive rebase copilot
**Where:** `InteractiveRebaseDialog`.
**UX:** one button: **"Clean up"** → proposes a todo list (squash the three "fix typo"
commits into their parent, reword vague messages, reorder safely). Shown in the existing
drag-and-drop editor for review; user tweaks, then runs.
**Engine:** commit list + diffs; `patch-id` data already detects duplicate changes.
Rewording reuses the message generator (#1) per commit.

### 6. PR title + description on push
**Where:** the push flow / `SyncButton` (PR state already surfaced via
`pullRequestsForBranches`).
**UX:** after pushing a branch with no PR: *"Create PR"* with title/body prefilled from
the branch's commits. Edit, confirm, done.
**Engine:** `getUnpushedCommits` / `rangeDiff` against the base branch; GitHub account
integration already exists for the API call.

### 7. Ask your repo (semantic history search)
**Where:** the History tab search box — same box, no new UI. A natural-language query
("when did the retry logic change and why?") just works.
**Engine:** agentic, not embeddings: the model translates the question into `read.ts`
queries (`log -S`, `-G`, `--follow`, blame), runs them, and answers **with commit
citations** that link into the History view. Zero indexing, zero storage, works on any
repo instantly.

### 8. Blame "why?"
**Where:** `BlamePane` line context menu.
**UX:** "Why is this line like this?" → short answer built from the blame chain.
**Engine:** the reblame walk already exists; feed the chain of commits + messages +
diffs for that line. This turns blame from *who* into *why*.

### 9. Error → plain English + one fix
**Where:** `ErrorDialog` and op-failure banners.
**UX:** git's stderr ("non-fast-forward", "refusing to merge unrelated histories")
becomes one human sentence plus **one** suggested action button (pull --rebase, force
push with lease…). Destructive suggestions still confirm once, per house rules.
**Engine:** stderr + repo state snapshot. Small, cheap, huge perceived quality.

### 10. Pre-push review
**Where:** a quiet action on unpushed commits ("Review before push").
**UX:** flags leftover debug prints, secrets/keys, accidental large or generated files,
obvious bugs — as dismissible notes, never a gate.
**Engine:** `getUnpushedCommits` + `rangeDiff`. Secrets check can be regex-first
(free, offline) with AI only for the fuzzy cases.

### 11. Auto-named stashes
**Where:** `stashSave` (Stash mode in `CommitComposer`, auto-stash on switch).
**UX:** invisible. Stashes are just… named ("wip: half-migrated GraphToolbar filters")
instead of "WIP on main". `StashPanel` becomes readable for free.

### 12. Release notes from the Graph
**Where:** Graph tab — release lines and tags are already first-class (`releases.ts`,
backport twin detection).
**UX:** right-click a release line / tag range → "Draft release notes" → grouped,
human-readable changelog in a copyable panel.
**Engine:** `rangeFiles` + commits between tags; backport links annotate what was
already shipped in maintenance lines.

### 13. .gitignore suggestions
**Where:** the untracked section of `WorkingFileList`.
**UX:** when build junk floods untracked files: one banner (one button, per house
rules) — "Ignore build artifacts?" → proposed patterns via existing `ignorePatterns`.

---

## Architecture (mirrors the git layer's philosophy)

```
src/main/ai/
  provider.ts   one entry point, like exec.ts is for git — streaming chat completion
  adapters/     openai-compatible (covers LiteLLM/Ollama/Gemini-compat/OpenRouter), anthropic
  context/      prompt assembly from read.ts outputs (pure, unit-testable, size-capped)
  features/     one file per feature: commit-message.ts, conflict.ts, branch-name.ts …
```

- **Keys in main only**, encrypted with `safeStorage` — exactly like OAuth tokens today.
  The renderer never sees the key or talks to the provider.
- **IPC:** follow the spine. `aiCapabilities`, `aiGenerate(feature, args)` +
  `onAiToken` streaming push, modeled on `onOpProgress`. Cancellable.
- **Settings:** a fourth pane in `SettingsDialog` — *AI* next to Accounts / Identity /
  Appearance. Three fields: base URL, API key, model. A "Test" button. That's the whole
  config. Optional per-repo "never send this repo's code" toggle for private work.
- **Context building is pure functions** over `read.ts` output with hard size caps
  (same discipline as `MAX_PATCH_BYTES`) → unit-testable without any network, per the
  testing rules.
- **Perf:** all context reads use the existing lock-free read side; AI calls never touch
  the write queue; suggestions stream so perceived latency ≈ 0; immutable inputs
  (commit hashes) cache forever.

## UX laws for every AI feature

1. **AI proposes, the user disposes.** No AI output ever reaches git without an accept.
2. **One affordance per surface** — a single ✨ button or ghost text, never a panel of knobs.
3. **Always visible, never nagging.** The ✨ affordance shows even with no backend
   connected — clicking it opens a small teaser (one pitch, one "Set up AI…" button that
   deep-links to Settings → AI). People can't want what they can't see; but AI never
   interrupts, only answers a click.
4. **Degrade silently.** Endpoint down → a calm toast on demand; git never waits on AI.
5. **Streaming always** — ghost text and proposals render token-by-token.

## Suggested build order

1. Settings pane + `src/main/ai/` provider layer (unlocks everything)
2. Commit messages (#1) — highest daily value, simplest context
3. Branch names (#2) + stash names (#11) — same machinery, nearly free
4. Explain this (#4) + error explainer (#9) — read-only, low risk
5. Conflict resolution (#3) — the differentiator; ship when it's *great*
6. Rebase copilot (#5), PR descriptions (#6), ask-your-repo (#7), the rest
