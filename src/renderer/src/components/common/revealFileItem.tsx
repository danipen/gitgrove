// The "Reveal in Finder" / "Show in Explorer" item offered for a single file
// that lives in the working tree (Changes, the search palette). Lists of files
// from other commits, branches or stashes don't offer it: the version shown
// there needn't exist on disk, so revealing would point at the wrong file — or
// nothing. A deleted change has no file left to select, so it's disabled.

import type { ChangedFile } from '@shared/types'
import { Icon } from '@/lib/icons'
import { revealLabel } from '@/lib/repo-actions'
import type { ContextMenuItem } from './ContextMenu'

/** Context-menu item that selects `file` in the OS file manager. */
export function revealFileItem(file: ChangedFile, repoPath: string): ContextMenuItem {
  return {
    label: revealLabel,
    icon: <Icon.Folder size={15} />,
    disabled: file.status === 'deleted',
    onClick: () => window.gitgrove.revealFile(repoPath, file.path)
  }
}
