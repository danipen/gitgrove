// Creating and deleting tags.

import { run } from '../exec'

export async function createTag(
  repoPath: string,
  name: string,
  opts: { hash?: string; message?: string; push?: boolean } = {}
): Promise<void> {
  const args = opts.message?.trim() ? ['tag', '-a', name, '-m', opts.message.trim()] : ['tag', name]
  if (opts.hash) args.push(opts.hash)
  await run(repoPath, args)
  if (opts.push) {
    const remotes = (await run(repoPath, ['remote']).catch(() => '')).split('\n').filter(Boolean)
    if (remotes.length > 0) await run(repoPath, ['push', remotes[0].trim(), name])
  }
}

export async function deleteTag(repoPath: string, name: string): Promise<void> {
  await run(repoPath, ['tag', '-d', name])
}
