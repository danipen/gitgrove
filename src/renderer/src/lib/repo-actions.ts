// Shared labels for the repository (and working-tree file) context-menu
// actions. Kept platform-aware so the menu reads natively ("Reveal in Finder" on macOS, "Show in Explorer" on
// Windows) and names the remote host the user actually has.

import { isMac, platform } from './platform'

/** Label for the "open the repo folder in the OS file manager" action. */
export const revealLabel = isMac
  ? 'Reveal in Finder'
  : platform === 'win32'
    ? 'Show in Explorer'
    : 'Open Folder'

/** True when a remote web URL points at github.com (drives the icon choice). */
export function isGithubUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes('github')
  } catch {
    return false
  }
}

/** Host-aware label for opening a repo's remote in the browser. */
export function remoteLabel(url: string): string {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return 'Open Remote'
  }
  if (host.includes('github')) return 'View on GitHub'
  if (host.includes('gitlab')) return 'View on GitLab'
  if (host.includes('bitbucket')) return 'View on Bitbucket'
  if (host.includes('dev.azure') || host.includes('visualstudio')) return 'View on Azure DevOps'
  return 'Open Remote'
}
