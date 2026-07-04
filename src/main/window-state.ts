// Pure logic for restoring the main window's geometry across launches.
//
// The saved state comes from disk, and the monitor layout may have changed
// since it was written — an external display unplugged, resolution lowered,
// the dock moved. Everything here therefore treats the stored values as
// untrusted input and reconciles them against the displays that exist *now*.
// The contract: the restored window is always visible and grabbable — enough
// of its title bar sits on a real screen to read and drag — no matter what
// happened to the monitors in between.
//
// Kept free of Electron imports so it can be unit-tested directly (bun:test
// has no Electron runtime); the file/event glue lives in window-state-store.ts.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  /**
   * Bounds to create the window with. Null means no usable saved state — the
   * caller falls back to the default size, centered by the OS.
   */
  bounds: Rect | null
  isMaximized: boolean
  isFullScreen: boolean
}

// Single source of truth for the main window's size limits and first-run
// size; index.ts feeds these straight into the BrowserWindow options.
export const MIN_WINDOW_WIDTH = 940
export const MIN_WINDOW_HEIGHT = 560
export const DEFAULT_WINDOW_WIDTH = 1440
export const DEFAULT_WINDOW_HEIGHT = 900

// How much of the window's *top strip* must land on a screen for the window
// to count as recoverable: enough width to see and drag the title bar, and
// enough height to cover the draggable region. The rest of the window may
// hang off-screen — users do that on purpose — but the handle must be real.
const GRAB_WIDTH = 120
const GRAB_HEIGHT = 40

function isUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Parse the persisted JSON's geometry, rejecting anything malformed. */
function parseSavedRect(record: Record<string, unknown>): Rect | null {
  const { x, y, width, height } = record
  if (!isUsableNumber(x) || !isUsableNumber(y)) return null
  if (!isUsableNumber(width) || !isUsableNumber(height)) return null
  if (width <= 0 || height <= 0) return null
  // Window managers deal in integer device-independent pixels; saved floats
  // (seen after macOS display-scale changes) are rounded, not rejected.
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return Math.max(0, w) * Math.max(0, h)
}

function centerDistance(a: Rect, b: Rect): number {
  const dx = a.x + a.width / 2 - (b.x + b.width / 2)
  const dy = a.y + a.height / 2 - (b.y + b.height / 2)
  return Math.hypot(dx, dy)
}

/**
 * The work area the window "belongs" to: the one it overlaps most, or — when
 * its display was disconnected and it overlaps nothing — the nearest one, so
 * a window from a vanished right-hand monitor reappears on the screen that
 * sat beside it rather than jumping to the primary.
 */
function pickHomeWorkArea(bounds: Rect, workAreas: Rect[]): Rect {
  let best = workAreas[0]
  let bestArea = 0
  for (const workArea of workAreas) {
    const area = intersectionArea(bounds, workArea)
    if (area > bestArea) {
      best = workArea
      bestArea = area
    }
  }
  if (bestArea > 0) return best
  let bestDistance = Number.POSITIVE_INFINITY
  for (const workArea of workAreas) {
    const distance = centerDistance(bounds, workArea)
    if (distance < bestDistance) {
      best = workArea
      bestDistance = distance
    }
  }
  return best
}

/**
 * True when the window's top strip — the part the user drags — is usably
 * on-screen on at least one display. Checked against work areas, not full
 * display bounds, so a title bar hidden under the macOS menu bar or a
 * Windows taskbar still counts as lost.
 */
function isGrabbable(bounds: Rect, workAreas: Rect[]): boolean {
  return workAreas.some((workArea) => {
    const overlapX =
      Math.min(bounds.x + bounds.width, workArea.x + workArea.width) -
      Math.max(bounds.x, workArea.x)
    if (overlapX < GRAB_WIDTH) return false
    return bounds.y >= workArea.y && bounds.y + GRAB_HEIGHT <= workArea.y + workArea.height
  })
}

/** Center a window of the given size in a work area, keeping the top-left
 *  corner on-screen even when the window is larger than the area. */
function centerIn(workArea: Rect, width: number, height: number): Rect {
  return {
    x: workArea.x + Math.max(0, Math.round((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, Math.round((workArea.height - height) / 2)),
    width,
    height
  }
}

// How far a new window is offset from the one it cascades from — enough to
// read both title bars, small enough to keep the windows visually related.
const CASCADE_OFFSET = 28

/**
 * Bounds for a window opened *next to* an existing one (File ▸ New Window,
 * "Open in New Window"): same size, offset down-right so both stay readable.
 * When the offset would push an edge past the work area, that axis snaps back
 * to the work area's origin — the classic cascade wrap — so any number of new
 * windows stays fully on-screen. Size is clamped to the work area first, so
 * the wrap test is against the size the window will actually get.
 */
export function cascadeBounds(source: Rect, workArea: Rect): Rect {
  const width = Math.min(Math.max(source.width, MIN_WINDOW_WIDTH), workArea.width)
  const height = Math.min(Math.max(source.height, MIN_WINDOW_HEIGHT), workArea.height)
  let x = source.x + CASCADE_OFFSET
  let y = source.y + CASCADE_OFFSET
  if (x + width > workArea.x + workArea.width) x = workArea.x
  if (y + height > workArea.y + workArea.height) y = workArea.y
  return { x, y, width, height }
}

/**
 * Reconcile a previously saved window state (raw JSON, untrusted) with the
 * current display work areas. Guarantees of the result:
 *
 * - size is clamped between the app minimum and the home display's work area,
 *   so a window sized for a 4K external never overflows the laptop panel;
 * - the title bar is grabbable on some display, else the window is re-centered
 *   on the display nearest to where it used to live;
 * - malformed or missing input degrades to `bounds: null` (caller defaults).
 */
export function sanitizeWindowState(raw: unknown, workAreas: Rect[]): WindowState {
  const record = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const isMaximized = record.isMaximized === true
  const isFullScreen = record.isFullScreen === true

  const saved = parseSavedRect(record)
  if (!saved || workAreas.length === 0) return { bounds: null, isMaximized, isFullScreen }

  const home = pickHomeWorkArea(saved, workAreas)
  const bounds: Rect = {
    x: saved.x,
    y: saved.y,
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(saved.width, home.width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.min(saved.height, home.height))
  }

  if (isGrabbable(bounds, workAreas)) return { bounds, isMaximized, isFullScreen }
  return { bounds: centerIn(home, bounds.width, bounds.height), isMaximized, isFullScreen }
}
