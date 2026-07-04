// The production AccountCipher: Electron safeStorage, which keys off the OS
// vault (macOS Keychain, Windows DPAPI, Linux kwallet/libsecret). Kept apart
// from store.ts so the store stays Electron-free and unit-testable.

import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { type AccountCipher, AccountsStore } from './store'

/**
 * The OS-vault cipher, shared with every store that keeps a secret at rest
 * (accounts here, the AI backend key in main/ai/store.ts).
 */
export function systemCipher(): AccountCipher {
  return {
    available() {
      // safeStorage is only meaningful after app ready; callers run later.
      if (!safeStorage.isEncryptionAvailable()) return false
      // On Linux without a keyring, Electron "encrypts" with a hardcoded key
      // ('basic_text') — that is plaintext with extra steps. Treat it as
      // unavailable so tokens stay session-only instead of leaking to disk.
      if (process.platform !== 'linux') return true
      return safeStorage.getSelectedStorageBackend() !== 'basic_text'
    },
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt(payload) {
      try {
        return safeStorage.decryptString(Buffer.from(payload, 'base64'))
      } catch {
        // Key changed (OS reinstall, file copied between machines): the
        // account shows as connected but can't answer — user reconnects.
        return null
      }
    }
  }
}

let shared: AccountsStore | null = null

/** The app-wide accounts store, lazily wired to userData + safeStorage. */
export function accountsStore(): AccountsStore {
  if (!shared) {
    shared = new AccountsStore(join(app.getPath('userData'), 'accounts.json'), systemCipher())
  }
  return shared
}
