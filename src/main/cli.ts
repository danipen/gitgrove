// Startup repository argument.
//
// GitGrove can be told which repository to open the moment it launches —
// useful for shell aliases, "Open with GitGrove" integrations, and driving the
// app under automation. The path comes from either a `--repo <path>` /
// `--repo=<path>` command-line flag or the GITGROVE_OPEN_REPO environment
// variable (the flag wins when both are present).
//
// A *bare* positional path is intentionally ignored: Electron's own argv
// carries entries we don't control — the app directory ('.') in dev, switches
// like `--remote-debugging-port` — and treating any of those as a repo would
// open the wrong thing. An explicit flag keeps the intent unambiguous.

const REPO_FLAG = '--repo'
const NEW_WINDOW_FLAG = '--new-window'

/**
 * Resolve the repository to open on startup from the process argv and env, or
 * null when none was requested. Pure (argv/env passed in) so it can be tested
 * without launching Electron.
 */
export function resolveStartupRepo(argv: readonly string[], env: NodeJS.ProcessEnv): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === REPO_FLAG) {
      // `--repo <path>`: the next token is the path unless it's another flag.
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) return next
    } else if (arg.startsWith(`${REPO_FLAG}=`)) {
      // `--repo=<path>`: everything after the equals sign.
      const value = arg.slice(REPO_FLAG.length + 1)
      if (value) return value
    }
  }
  const fromEnv = env.GITGROVE_OPEN_REPO
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : null
}

/**
 * Whether the invocation asks for a fresh window (`--new-window`) — used by
 * launcher shortcuts (the Windows Jump List's "New Window" task, the Linux
 * desktop action) whose relaunch is routed into the running instance by the
 * single-instance lock.
 */
export function hasNewWindowFlag(argv: readonly string[]): boolean {
  return argv.includes(NEW_WINDOW_FLAG)
}
