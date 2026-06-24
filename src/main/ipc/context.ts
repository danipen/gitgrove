// Shared dependencies threaded into every handler module. The app shell
// (index.ts) supplies the IpcContext; registerIpc derives `opProgressTo` from
// it and hands the combined HandlerDeps to each register*Handlers function.

import type { GitAvailability, ProgressOpKind, RepoOpenResult } from '@shared/types'
import type { BrowserWindow } from 'electron'

/** What the handlers need from the app shell. */
export interface IpcContext {
  getWindow(): BrowserWindow | null
  openRepoAtPath(path: string): Promise<RepoOpenResult>
  /** The repo requested on launch, returned once then forgotten (see cli.ts). */
  takeInitialRepoPath(): string | null
  trustRepo(path: string): Promise<RepoOpenResult>
  checkGit(force: boolean): Promise<GitAvailability>
}

/** Pushes phase + percent for one long-running op to the renderer. */
export type ProgressReporter = (phase: string, percent: number) => void

/**
 * Builds a progress forwarder for a long-running op: each call pushes phase +
 * percent to the renderer so the matching button can fill determinately while
 * git works.
 */
export type OpProgressFactory = (repoPath: string, kind: ProgressOpKind) => ProgressReporter

/** Everything a handler module receives: the app shell plus the progress factory. */
export interface HandlerDeps extends IpcContext {
  opProgressTo: OpProgressFactory
}
