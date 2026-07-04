// The app-wide AI store, wired to userData + the OS-vault cipher — the same
// safeStorage discipline as the accounts store (see accounts/cipher.ts).

import { join } from 'node:path'
import { app } from 'electron'
import { systemCipher } from '../accounts/cipher'
import { AiStore } from './store'

let shared: AiStore | null = null

/** The app-wide AI backend store, lazily wired to userData + safeStorage. */
export function aiStore(): AiStore {
  if (!shared) {
    shared = new AiStore(join(app.getPath('userData'), 'ai.json'), systemCipher())
  }
  return shared
}
