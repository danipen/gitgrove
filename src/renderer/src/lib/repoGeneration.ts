// A monotonic counter bumped on every repo switch. Async loaders capture the
// active generation before they await; when they resolve they check it still
// matches, so a slow load started for the previous repo never writes its result
// into the state that now belongs to the newly-opened one.
//
// More robust than a plain path check, which has a blind spot: switching
// A → B → A while A's first load is still in flight passes a path check (the
// path matches again) yet is still a stale load. The counter moves on *every*
// switch, so a superseded load is always detectable.

export interface RepoGeneration {
  /** The active generation — captured by a loader before it awaits. */
  current(): number
  /** Switch repos: bump and return the new active generation. */
  next(): number
  /** True iff `captured` is still the active generation (no switch since). */
  isCurrent(captured: number): boolean
}

export function createRepoGeneration(): RepoGeneration {
  let active = 0
  return {
    current: () => active,
    next: () => ++active,
    isCurrent: (captured) => captured === active
  }
}
