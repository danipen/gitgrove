// Shared dependencies threaded into every handler module. The app shell
// (index.ts) supplies the IpcContext; registerIpc derives `opProgressTo` from
// it and hands the combined HandlerDeps to each register*Handlers function.
//
// GitGrove is multi-window, so "the window" is never a global: a handler that
// needs one resolves it from the invoking renderer (`windowFrom(e.sender)` —
// dialogs, window controls, per-op progress), while pushes that aren't tied to
// a renderer call either go to every window (`broadcast`, filtered by repo
// path on the renderer side) or to the window the user is working in
// (`focusedWindow` — credential prompts).

import type { GitAvailability, ProgressOpKind, RepoOpenResult } from '@shared/types'
import type { BrowserWindow, WebContents } from 'electron'

/** What the handlers need from the app shell. */
export interface IpcContext {
  /** The window hosting the renderer that invoked a handler, or null if gone. */
  windowFrom(sender: WebContents): BrowserWindow | null
  /** The window the user is working in (focused, or last focused). */
  focusedWindow(): BrowserWindow | null
  /** Send to every open window; renderers filter by repo path where relevant. */
  broadcast(channel: string, ...args: unknown[]): void
  /** Open a repo in `win` (associates it for the menu and the watcher). */
  openRepoAtPath(path: string, win: BrowserWindow | null): Promise<RepoOpenResult>
  /** Open a repo in a brand-new window (repo switcher's "Open in New Window"). */
  openRepoInNewWindow(path: string): void
  /** The repo `win` should open on boot, returned once then forgotten. */
  takeInitialRepoPath(win: BrowserWindow | null): string | null
  trustRepo(path: string, win: BrowserWindow | null): Promise<RepoOpenResult>
  checkGit(force: boolean): Promise<GitAvailability>
  /** Run an update check; results are pushed to every window as UpdateStatus. */
  checkForUpdates(manual: boolean): Promise<void>
}

/** Pushes phase + percent for one long-running op to the renderer. */
export type ProgressReporter = (phase: string, percent: number) => void

/**
 * Builds a progress forwarder for a long-running op: each call pushes phase +
 * percent to the renderer that started the op — never to other windows, whose
 * own busy state must not be disturbed — so the matching button can fill
 * determinately while git works.
 */
export type OpProgressFactory = (
  sender: WebContents,
  repoPath: string,
  kind: ProgressOpKind
) => ProgressReporter

/** Everything a handler module receives: the app shell plus the progress factory. */
export interface HandlerDeps extends IpcContext {
  opProgressTo: OpProgressFactory
}
