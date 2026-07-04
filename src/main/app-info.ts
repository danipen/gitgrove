import type { AppInfo } from '@shared/types'
import { app } from 'electron'

export const REPO_URL = 'https://github.com/danipen/gitgrove'

/**
 * Windows AppUserModelID — must equal electron-builder's `appId`, which the
 * installer stamps onto the Start-menu/desktop shortcuts. Setting the same ID
 * on the process makes the taskbar group our windows under those shortcuts,
 * which is also what attaches the Jump List (app-shortcuts.ts) to them.
 */
export const APP_USER_MODEL_ID = 'software.gitgrove.app'

export function appInfo(): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    dev: !app.isPackaged,
    repoUrl: REPO_URL
  }
}
