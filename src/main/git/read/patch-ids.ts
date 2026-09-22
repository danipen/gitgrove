// Patch-id equivalence for the Graph: two commits with the same patch-id carry
// the same change — a cherry-picked backport (the twins), or a branch that
// landed as one squash commit (squash-landings.ts, via getRangePatchIds).
// Batch API: the renderer sends the window's commit hashes and gets
// hash → patch-id back.
//
// Unlike the rest of the read side this can't go through runGit's execFile:
// the patches themselves can be huge, so `git diff-tree --stdin --root -p` is
// STREAMED straight into `git patch-id --stable` and never buffered here —
// only the tiny "<patch-id> <commit>" lines come back. Merges produce no diff
// in stdin mode, empty commits produce no patch, and unknown hashes are
// ignored by diff-tree — all three simply drop out of the result. Reads stay
// lock-free via GIT_OPTIONAL_LOCKS=0 (core.ts sets it on process.env, which
// spawn inherits).

import { spawn } from 'node:child_process'
import { locateGit } from '../bin'

export function getPatchIds(repoPath: string, hashes: string[]): Promise<Record<string, string>> {
  return streamPatchIds(repoPath, hashes)
}

/**
 * Patch-id of each branch's WHOLE change, `base..tip` as one diff — what a
 * squash merge carries — keyed by tip. diff-tree's stdin form reads
 * "<commit> <parent>…" lines, so naming the base as the tip's only parent
 * diffs exactly that range, headed by the tip hash patch-id reports. Both
 * must be full hashes: abbreviated ones on a stdin line are silently skipped.
 */
export function getRangePatchIds(
  repoPath: string,
  ranges: readonly { tip: string; base: string }[]
): Promise<Record<string, string>> {
  return streamPatchIds(
    repoPath,
    ranges.map((range) => `${range.tip} ${range.base}`)
  )
}

/** Feed diff-tree's stdin lines through `patch-id --stable`: commit → id. */
async function streamPatchIds(
  repoPath: string,
  stdinLines: readonly string[]
): Promise<Record<string, string>> {
  if (stdinLines.length === 0) return {}
  const bin = await locateGit()
  return new Promise((resolve, reject) => {
    const options = { cwd: repoPath, windowsHide: true }
    const diff = spawn(bin, ['diff-tree', '--stdin', '--root', '-p'], options)
    const ids = spawn(bin, ['patch-id', '--stable'], options)
    diff.stdout.pipe(ids.stdin)

    let out = ''
    let errText = ''
    ids.stdout.setEncoding('utf8')
    ids.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    for (const stderr of [diff.stderr, ids.stderr]) {
      stderr.setEncoding('utf8')
      stderr.on('data', (chunk: string) => {
        errText += chunk
      })
    }

    const fail = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)))
    diff.on('error', fail)
    ids.on('error', fail)
    // A process dying mid-stream breaks the pipe; EPIPE on these streams must
    // become a rejected promise (via the exit codes), never a crash.
    diff.stdin.on('error', () => {})
    diff.stdout.on('error', () => {})
    ids.stdin.on('error', () => {})

    // Settle only once both processes finished, whatever order they close in;
    // a signal kill reports code null — treat it as failure.
    let diffCode: number | null = null
    let idsCode: number | null = null
    const settle = () => {
      if (diffCode === null || idsCode === null) return
      if (diffCode !== 0 || idsCode !== 0) {
        reject(new Error(errText.trim() || 'git patch-id failed'))
        return
      }
      const record: Record<string, string> = {}
      for (const line of out.split('\n')) {
        const [patchId, commit] = line.trim().split(/\s+/)
        if (patchId && commit) record[commit] = patchId
      }
      resolve(record)
    }
    diff.on('close', (code) => {
      diffCode = code ?? 1
      settle()
    })
    ids.on('close', (code) => {
      idsCode = code ?? 1
      settle()
    })

    diff.stdin.write(`${stdinLines.join('\n')}\n`)
    diff.stdin.end()
  })
}
