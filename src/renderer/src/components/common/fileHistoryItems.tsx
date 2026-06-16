// The "View History" / "Blame" pair offered for a single file in any file list
// (Changes and History). `baseRef` anchors what's shown: a commit hash from the
// History tab, or null for the working tree from the Changes tab. Shared so the
// wording and behaviour stay identical across the views without coupling them.

import type { ChangedFile } from '@shared/types'
import { Icon } from '@/lib/icons'
import type { ContextMenuItem } from './ContextMenu'

export type FileHistoryMode = 'diff' | 'blame'

/**
 * Context-menu items that open the File History overlay for `file`, in Diff or
 * Blame mode. Only meaningful for a single file — callers gate on selection
 * size and pass the path's anchor revision (`baseRef`).
 */
export function fileHistoryItems(
  file: ChangedFile,
  baseRef: string | null,
  onOpen: (path: string, mode: FileHistoryMode, baseRef: string | null) => void
): ContextMenuItem[] {
  return [
    {
      label: 'View History',
      icon: <Icon.History size={15} />,
      onClick: () => onOpen(file.path, 'diff', baseRef)
    },
    {
      label: 'Blame',
      icon: <Icon.Diff size={15} />,
      onClick: () => onOpen(file.path, 'blame', baseRef)
    }
  ]
}
