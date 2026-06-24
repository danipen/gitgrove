// Fully scripted interactive rebase. Our todo replaces git's and a tiny sh
// editor feeds prepared messages for reword/squash prompts, so no terminal
// editor ever opens — the renderer's visual todo editor is the only UI.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RebaseTodoItem } from '@shared/types'
import { runOnceWithRetry } from './exec'
import { withUndo } from './undo'

/**
 * The message-editor invocations git will make for a todo list, in order:
 * one per `reword`, and one at the end of each squash chain (fixups don't
 * prompt). `null` means "keep git's prepared message". Exported for tests.
 */
export function buildEditorQueue(items: RebaseTodoItem[]): (string | null)[] {
  const queue: (string | null)[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.action === 'reword') {
      queue.push(item.message?.trim() ? item.message : null)
    } else if (item.action === 'squash') {
      // Git prompts once per squash *step*. A chain of N squashes prompts N
      // times; we only override the last prompt (the chain's final message).
      const isChainEnd = items[i + 1]?.action !== 'squash'
      queue.push(isChainEnd && item.message?.trim() ? item.message : null)
    }
  }
  return queue
}

/** Render the todo file. Items arrive oldest-first, matching git's order. */
export function buildTodoFile(items: RebaseTodoItem[]): string {
  return `${items
    .filter((i) => i.action !== 'drop')
    .map((i) => `${i.action} ${i.hash}`)
    .join('\n')}\n`
}

/**
 * Run a fully scripted `git rebase -i`: our todo replaces git's, and a tiny
 * sh editor feeds prepared messages for reword/squash prompts (sh ships with
 * git on every platform, including Git for Windows). On conflict the rebase
 * stops normally and the app's conflict banner takes over (continue/abort).
 */
export async function rebaseInteractive(
  repoPath: string,
  base: string,
  items: RebaseTodoItem[]
): Promise<void> {
  if (items.length === 0 || items.every((i) => i.action === 'drop')) {
    throw new Error('Nothing to rebase: every commit would be dropped.')
  }
  if (items[0].action === 'squash' || items[0].action === 'fixup') {
    throw new Error('The first commit cannot be squashed — there is nothing above it.')
  }

  const dir = await mkdtemp(join(tmpdir(), 'gitgrove-rebase-'))
  try {
    await writeFile(join(dir, 'todo'), buildTodoFile(items), 'utf8')

    const queue = buildEditorQueue(items)
    await Promise.all(
      queue.map((msg, i) =>
        msg !== null ? writeFile(join(dir, `msg-${i + 1}.txt`), msg, 'utf8') : Promise.resolve()
      )
    )

    // Sequence editor: overwrite git's todo with ours. Message editor: pop the
    // next prepared message if one exists, else keep git's default. Both run
    // under git's sh, so forward slashes work everywhere.
    const posixDir = dir.replace(/\\/g, '/')
    await writeFile(
      join(dir, 'seq-editor.sh'),
      `#!/bin/sh\ncat "${posixDir}/todo" > "$1"\n`,
      'utf8'
    )
    await writeFile(
      join(dir, 'msg-editor.sh'),
      [
        '#!/bin/sh',
        `d="${posixDir}"`,
        'n=$(cat "$d/count" 2>/dev/null || echo 0)',
        'n=$((n+1))',
        'echo "$n" > "$d/count"',
        'if [ -f "$d/msg-$n.txt" ]; then cat "$d/msg-$n.txt" > "$1"; fi',
        'exit 0',
        ''
      ].join('\n'),
      'utf8'
    )

    // Wrapped so a completed interactive rebase can be undone in one step. A
    // rebase that stops on conflicts throws (run rejects), so withUndo records
    // nothing for it — its abort lives in the in-progress conflict banner.
    await withUndo(
      repoPath,
      {
        kind: 'rebase-interactive',
        label: ({ currentBranch }) => `Rewrote ${currentBranch ?? 'HEAD'} history`
      },
      () =>
        runOnceWithRetry(repoPath, ['-c', 'rebase.autoSquash=false', 'rebase', '-i', base], {
          env: {
            GIT_SEQUENCE_EDITOR: `sh "${posixDir}/seq-editor.sh"`,
            GIT_EDITOR: `sh "${posixDir}/msg-editor.sh"`
          }
        })
    )
  } finally {
    // A stopped (conflicted) rebase no longer needs the scripts — git only
    // reads the sequence/message editors while the command itself runs; on
    // `rebase --continue` we pass core.editor=true instead.
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
