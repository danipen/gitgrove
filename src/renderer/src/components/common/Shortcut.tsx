// A keyboard shortcut drawn as one key cap per key (⌘ K, Ctrl Shift F), the
// way the platform's own menus and docs show them. Shared by the toolbar's
// search trigger and the command palette's hints.
// styles: styles/primitives.css (.kbd, .shortcut)

import { acceleratorKeys } from '@shared/commands'
import { platform } from '@/lib/platform'

/** `accelerator` in Electron syntax (`CmdOrCtrl+K`). */
export function Shortcut({ accelerator }: { accelerator: string }) {
  return (
    <span className="shortcut">
      {acceleratorKeys(accelerator, platform).map((key) => (
        <kbd key={key} className="kbd">
          {key}
        </kbd>
      ))}
    </span>
  )
}
