// Watches an open repository for changes (commits, checkouts, working-tree
// edits) and notifies the renderer with a debounced "repo changed" event so the
// UI can refresh status/history without a manual reload.

import { type FSWatcher, watch } from 'node:fs'
import { join, sep } from 'node:path'

type ChangeHandler = (repoPath: string) => void

export class RepoWatcher {
  private watchers = new Map<string, FSWatcher[]>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private onChange: ChangeHandler) {}

  watch(repoPath: string): void {
    if (this.watchers.has(repoPath)) return
    const handles: FSWatcher[] = []

    const emit = () => {
      const existing = this.timers.get(repoPath)
      if (existing) clearTimeout(existing)
      this.timers.set(
        repoPath,
        setTimeout(() => {
          this.timers.delete(repoPath)
          this.onChange(repoPath)
        }, 350)
      )
    }

    // Watch the working tree (recursive on macOS/Windows) but ignore the noisy
    // internals of .git except for the refs/HEAD/index that signal real state.
    try {
      handles.push(
        watch(repoPath, { recursive: true }, (_event, filename) => {
          if (!filename) return emit()
          const name = filename.toString()
          const inGit = name === '.git' || name.startsWith(`.git${sep}`) || name.startsWith('.git/')
          if (!inGit) return emit()
          if (/HEAD|index$|MERGE_HEAD|[\\/]refs[\\/]/.test(name)) emit()
        })
      )
    } catch {
      // Recursive watch can fail on some filesystems; fall back to watching .git only.
      try {
        handles.push(watch(join(repoPath, '.git'), () => emit()))
      } catch {
        // give up silently — the UI still has a manual refresh
      }
    }

    this.watchers.set(repoPath, handles)
  }

  /**
   * Reconcile the watched set with the repos currently open across all
   * windows: start watching newly opened ones, stop watching repos no window
   * shows anymore. Keeping orphaned watchers alive would burn fs events (and
   * on Linux, inotify watches) on repos nobody is looking at.
   */
  sync(openRepos: ReadonlySet<string>): void {
    for (const repoPath of openRepos) this.watch(repoPath)
    for (const repoPath of [...this.watchers.keys()]) {
      if (!openRepos.has(repoPath)) this.unwatch(repoPath)
    }
  }

  unwatch(repoPath: string): void {
    const handles = this.watchers.get(repoPath)
    if (!handles) return
    for (const h of handles) h.close()
    this.watchers.delete(repoPath)
    const timer = this.timers.get(repoPath)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(repoPath)
    }
  }

  unwatchAll(): void {
    for (const handles of this.watchers.values()) {
      for (const h of handles) h.close()
    }
    this.watchers.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
