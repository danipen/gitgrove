// Pure builders for the web URLs GitGrove links out to on a git host — the
// commit/branch "view on the web" links and the "create pull request" compare
// page — plus parsing a browsable repo URL back into its owner/name. No runtime
// dependencies, so it's importable from every bundle and directly unit-testable.
//
// Every scheme here is GitHub's path shape today (the only provider GitGrove
// connects accounts for); keeping it in one module is the seam where other
// hosts' differing path shapes slot in later, rather than scattering
// `/commit/` vs `/-/commit/` guesses across the UI.

/** Drop any trailing slashes so a base like `…/repo/` joins cleanly. */
function trimTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '')
}

/**
 * Encode a branch ref for a single URL path segment. Branch names can contain
 * slashes (`feature/x`), `#`, spaces and other characters that must not be
 * taken as path/query syntax, so the whole ref is percent-encoded.
 */
function encodeRef(branch: string): string {
  return encodeURIComponent(branch)
}

/** `…/commit/<sha>` — the page for a single commit. */
export function commitUrl(webBase: string, sha: string): string {
  return `${trimTrailingSlash(webBase)}/commit/${sha}`
}

/** `…/tree/<branch>` — the repository browsed at a branch. */
export function branchUrl(webBase: string, branch: string): string {
  return `${trimTrailingSlash(webBase)}/tree/${encodeRef(branch)}`
}

/**
 * The "open a pull request" compare page, pre-expanded (`?expand=1`) so the PR
 * form shows directly instead of the bare diff. `baseBranch` is what the PR
 * merges into (typically the repo's default branch); `headBranch` is the branch
 * carrying the new commits.
 */
export function compareUrl(webBase: string, baseBranch: string, headBranch: string): string {
  return `${trimTrailingSlash(webBase)}/compare/${encodeRef(baseBranch)}...${encodeRef(headBranch)}?expand=1`
}

/**
 * Split a browsable repo URL (e.g. `https://github.com/owner/repo`) into its
 * owner and name, or null when it isn't a recognizable repo URL. Tolerates a
 * trailing `.git` and extra path segments (takes the first two). Used to drive
 * the host API: a repo's API path is keyed by owner/name.
 */
export function parseOwnerRepo(webUrl: string): { owner: string; repo: string } | null {
  let pathname: string
  try {
    pathname = new URL(webUrl).pathname
  } catch {
    return null
  }
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, '')
  return owner && repo ? { owner, repo } : null
}
