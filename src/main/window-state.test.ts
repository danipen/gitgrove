import { describe, expect, test } from 'bun:test'
import {
  cascadeBounds,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type Rect,
  sanitizeWindowState
} from './window-state'

// A 1920x1080 primary whose work area starts below a 40px menu/task bar.
const primary: Rect = { x: 0, y: 40, width: 1920, height: 1040 }
// A 2560x1440 external sitting to the right of the primary.
const external: Rect = { x: 1920, y: 0, width: 2560, height: 1440 }
// A small laptop panel, the only display after undocking.
const laptop: Rect = { x: 0, y: 38, width: 1440, height: 862 }

type Flags = Partial<{ isMaximized: boolean; isFullScreen: boolean }>
const saved = (bounds: Rect, flags: Flags = {}) => ({
  ...bounds,
  isMaximized: false,
  isFullScreen: false,
  ...flags
})

describe('sanitizeWindowState', () => {
  test('keeps bounds that fit the display they were saved on', () => {
    const bounds = { x: 100, y: 100, width: 1200, height: 800 }
    expect(sanitizeWindowState(saved(bounds), [primary])).toEqual({
      bounds,
      isMaximized: false,
      isFullScreen: false
    })
  })

  test('keeps a window placed on a secondary display', () => {
    const bounds = { x: 2200, y: 60, width: 1600, height: 1200 }
    expect(sanitizeWindowState(saved(bounds), [primary, external]).bounds).toEqual(bounds)
  })

  test('keeps a window straddling two displays while its title bar is visible', () => {
    const bounds = { x: 1400, y: 200, width: 1200, height: 700 }
    expect(sanitizeWindowState(saved(bounds), [primary, external]).bounds).toEqual(bounds)
  })

  test('recenters a window whose display was disconnected', () => {
    const bounds = { x: 2200, y: 60, width: 1600, height: 800 }
    const state = sanitizeWindowState(saved(bounds), [laptop])
    // Shrunk to the laptop work area and centered on it — fully visible.
    expect(state.bounds).toEqual({ x: 0, y: 69, width: 1440, height: 800 })
  })

  test('clamps a window sized for a big external onto a small panel', () => {
    const bounds = { x: 0, y: 38, width: 2560, height: 1440 }
    const state = sanitizeWindowState(saved(bounds), [laptop])
    expect(state.bounds?.width).toBe(laptop.width)
    expect(state.bounds?.height).toBe(laptop.height)
  })

  test('after a no-overlap disconnect, picks the nearest remaining display', () => {
    // Window lived on a vanished third display to the right of `external`.
    const bounds = { x: 4500, y: 100, width: 1200, height: 800 }
    const state = sanitizeWindowState(saved(bounds), [primary, external])
    // Re-centered on `external` (the nearer survivor), not the primary.
    expect(state.bounds).toEqual({ x: 2600, y: 320, width: 1200, height: 800 })
  })

  test('rescues a title bar hidden above the work area (under the menu bar)', () => {
    const bounds = { x: 100, y: 0, width: 1200, height: 800 }
    const state = sanitizeWindowState(saved(bounds), [primary])
    expect(state.bounds?.y).toBeGreaterThanOrEqual(primary.y)
  })

  test('rescues a window dragged almost entirely off-screen', () => {
    // Only 50px of the right edge remains on the primary — too thin to grab.
    const bounds = { x: -1150, y: 100, width: 1200, height: 800 }
    const state = sanitizeWindowState(saved(bounds), [primary])
    expect(state.bounds).toEqual({ x: 360, y: 160, width: 1200, height: 800 })
  })

  test('tolerates a window mostly below the screen — the title bar is enough', () => {
    const bounds = { x: 100, y: 900, width: 1200, height: 800 }
    expect(sanitizeWindowState(saved(bounds), [primary]).bounds).toEqual(bounds)
  })

  test('enforces the app minimum size on undersized saved bounds', () => {
    const bounds = { x: 100, y: 100, width: 200, height: 100 }
    const state = sanitizeWindowState(saved(bounds), [primary])
    expect(state.bounds?.width).toBe(MIN_WINDOW_WIDTH)
    expect(state.bounds?.height).toBe(MIN_WINDOW_HEIGHT)
  })

  test('rounds fractional coordinates from display-scale changes', () => {
    const state = sanitizeWindowState(saved({ x: 100.6, y: 100.2, width: 1200.5, height: 800.4 }), [
      primary
    ])
    expect(state.bounds).toEqual({ x: 101, y: 100, width: 1201, height: 800 })
  })

  test('preserves the maximized and full-screen flags', () => {
    const bounds = { x: 100, y: 100, width: 1200, height: 800 }
    const state = sanitizeWindowState(saved(bounds, { isMaximized: true, isFullScreen: true }), [
      primary
    ])
    expect(state.isMaximized).toBe(true)
    expect(state.isFullScreen).toBe(true)
  })

  test('keeps the maximized flag even when the bounds are unusable', () => {
    const state = sanitizeWindowState({ isMaximized: true }, [primary])
    expect(state).toEqual({ bounds: null, isMaximized: true, isFullScreen: false })
  })

  test.each([
    ['missing file', null],
    ['not an object', 'garbage'],
    ['empty object', {}],
    ['NaN coordinate', { x: Number.NaN, y: 0, width: 1200, height: 800 }],
    ['Infinity coordinate', { x: 0, y: Number.POSITIVE_INFINITY, width: 1200, height: 800 }],
    ['string fields', { x: '0', y: '0', width: '1200', height: '800' }],
    ['non-positive size', { x: 0, y: 40, width: 0, height: -5 }]
  ])('degrades to defaults on %s', (_label, raw) => {
    expect(sanitizeWindowState(raw, [primary])).toEqual({
      bounds: null,
      isMaximized: false,
      isFullScreen: false
    })
  })

  test('degrades to defaults when no displays are reported', () => {
    const state = sanitizeWindowState(saved({ x: 0, y: 0, width: 1200, height: 800 }), [])
    expect(state.bounds).toBeNull()
  })
})

describe('cascadeBounds', () => {
  test('offsets down-right from the source window, keeping its size', () => {
    const source = { x: 100, y: 140, width: 1200, height: 800 }
    expect(cascadeBounds(source, primary)).toEqual({ x: 128, y: 168, width: 1200, height: 800 })
  })

  test('wraps back to the work area edge when the offset would overflow', () => {
    // Source sits flush against the bottom-right of the primary work area.
    const source = { x: 720, y: 280, width: 1200, height: 800 }
    const result = cascadeBounds(source, primary)
    // x wraps (748 + 1200 > 1920) and y wraps (308 + 800 > 1080).
    expect(result).toEqual({ x: primary.x, y: primary.y, width: 1200, height: 800 })
  })

  test('wraps each axis independently', () => {
    const source = { x: 720, y: 100, width: 1200, height: 800 }
    const result = cascadeBounds(source, primary)
    expect(result.x).toBe(primary.x) // horizontal overflow wraps…
    expect(result.y).toBe(128) // …vertical still cascades
  })

  test('clamps an oversized source to the work area', () => {
    const source = { x: 0, y: 38, width: 2560, height: 1440 }
    const result = cascadeBounds(source, laptop)
    expect(result.width).toBe(laptop.width)
    expect(result.height).toBe(laptop.height)
  })

  test('never returns a window below the app minimum size', () => {
    const source = { x: 10, y: 50, width: 200, height: 100 }
    const result = cascadeBounds(source, primary)
    expect(result.width).toBe(MIN_WINDOW_WIDTH)
    expect(result.height).toBe(MIN_WINDOW_HEIGHT)
  })

  test('respects a secondary display work area origin', () => {
    const source = { x: 2000, y: 60, width: 1600, height: 1200 }
    expect(cascadeBounds(source, external)).toEqual({
      x: 2028,
      y: 88,
      width: 1600,
      height: 1200
    })
  })
})
