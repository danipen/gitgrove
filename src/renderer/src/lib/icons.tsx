// Minimal inline SVG icon set (stroke-based, 1.6px) so the app ships with no
// icon-font dependency. Each icon inherits `currentColor`.

import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  )
}

export const Icon = {
  Plus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  Minus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 12h14" />
    </Svg>
  ),
  Undo: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Svg>
  ),
  Upload: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 17V4" />
      <path d="m6 10 6-6 6 6" />
      <path d="M4 20h16" />
    </Svg>
  ),
  Tag: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3.5 12.6 11 20a2 2 0 0 0 2.8 0l6.2-6.2a2 2 0 0 0 0-2.8L12.6 3.5A2 2 0 0 0 11.2 3H5a2 2 0 0 0-2 2v6.2c0 .5.2 1 .5 1.4Z" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Stash: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 7.5 12 3l9 4.5-9 4.5z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </Svg>
  ),
  Merge: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="6" cy="5" r="2.4" />
      <circle cx="6" cy="19" r="2.4" />
      <circle cx="18" cy="12" r="2.4" />
      <path d="M6 7.4v9.2" />
      <path d="M6 8c0 4 6 4 9.6 4" />
    </Svg>
  ),
  /** "Take the left side" — ours in a conflict (ours renders left in diffs). */
  SideLeft: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="5.5" y="7.5" width="5.5" height="9" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  ),
  /** "Take the right side" — theirs in a conflict (theirs renders right in diffs). */
  SideRight: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="13" y="7.5" width="5.5" height="9" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  ),
  CherryPick: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6" />
    </Svg>
  ),
  Pencil: (p: IconProps) => (
    <Svg {...p}>
      <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 3 21.5l1-4.5Z" />
    </Svg>
  ),
  Reset: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </Svg>
  ),
  Worktree: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 11h18" />
    </Svg>
  ),
  Module: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3 4 7.5v9L12 21l8-4.5v-9z" />
      <path d="M4 7.5 12 12l8-4.5" />
      <path d="M12 12v9" />
    </Svg>
  ),
  ListTodo: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="m3 5.6 1.2 1.2L6.4 4.5" />
      <path d="m3 11.6 1.2 1.2 2.2-2.3" />
      <path d="m3 17.6 1.2 1.2 2.2-2.3" />
    </Svg>
  ),
  Grip: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="9" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Branch: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="8" r="2.4" />
      <path d="M6 8.4v7.2" />
      <path d="M18 10.4c0 4-4 3.6-6 5.2" />
    </Svg>
  ),
  Repo: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 18.5z" />
      <path d="M5 16.5A1.5 1.5 0 0 1 6.5 15H19" />
    </Svg>
  ),
  Chevron: (p: IconProps) => (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  ),
  Refresh: (p: IconProps) => (
    <Svg {...p}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 4v5h-5" />
    </Svg>
  ),
  Search: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  ),
  Check: (p: IconProps) => (
    <Svg {...p}>
      <path d="m5 12 5 5L20 6" />
    </Svg>
  ),
  Close: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6 18 18M18 6 6 18" />
    </Svg>
  ),
  Copy: (p: IconProps) => (
    <Svg {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
    </Svg>
  ),
  Folder: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Svg>
  ),
  Diff: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v6M9 6h6" />
      <path d="M9 18h6" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </Svg>
  ),
  Split: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="1.6" />
      <path d="M12 4v16" />
    </Svg>
  ),
  Unified: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="1.6" />
      <path d="M7 9h10M7 13h10" />
    </Svg>
  ),
  Wrap: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 6h16M4 12h12a3 3 0 0 1 0 6h-3m0 0 2-2m-2 2 2 2M4 18h4" />
    </Svg>
  ),
  History: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 4v4h4" />
      <path d="M12 8v4l3 2" />
    </Svg>
  ),
  Changes: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6M15 12h6" />
    </Svg>
  ),
  Tree: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="9" width="7" height="5" rx="1" />
      <rect x="14" y="16" width="7" height="5" rx="1" />
      <path d="M6.5 8v8.5a1 1 0 0 0 1 1H14M6.5 11.5H14" />
    </Svg>
  ),
  Sparkle: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3l1.8 4.7L18.5 9.5 13.8 11.3 12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
    </Svg>
  ),
  Sun: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Svg>
  ),
  Moon: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20 13a8 8 0 1 1-9-9 6 6 0 0 0 9 9z" />
    </Svg>
  ),
  Monitor: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="12" rx="1.6" />
      <path d="M8 20h8M12 16v4" />
    </Svg>
  ),
  Download: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 21h14" />
    </Svg>
  ),
  Terminal: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </Svg>
  ),
  Alert: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3 2.7 19.5a1 1 0 0 0 .87 1.5h16.86a1 1 0 0 0 .87-1.5z" />
      <path d="M12 9.5v4.5" />
      <path d="M12 17.5h.01" />
    </Svg>
  ),
  // GitHub's octocat mark needs a fill, so it opts out of the stroke-only Svg
  // wrapper and paints with currentColor like the rest of the set.
  Github: ({ size = 16, ...p }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...p}>
      <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.9c-2.78.62-3.37-1.21-3.37-1.21-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.85.09-.66.35-1.12.63-1.37-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.91l-.01 2.83c0 .27.18.6.69.49A10.04 10.04 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
    </svg>
  ),
  External: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" />
    </Svg>
  ),
  Trash: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7" />
      <path d="M10 11v5M14 11v5" />
    </Svg>
  ),
  Lock: (p: IconProps) => (
    <Svg {...p}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  ),
  /** A solid frame over a dashed ghost frame — onion skinning, as animation
   *  tools draw it: the previous frame showing through the current one. */
  Onion: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9.5 3.5h9.5a2 2 0 0 1 2 2v9.5" strokeDasharray="2.4 2.7" />
      <rect x="3" y="7" width="14" height="14" rx="2" />
    </Svg>
  ),
  /** A venn pair with the intersection marked — the pixel-differences mode.
   *  (A filled lens fuses into a blob at 15px; the dot stays legible.) */
  Compare: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="9" cy="12" r="6.5" />
      <circle cx="15" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  ),
  /** A wipe divider with reveal arrows — the swipe mode. */
  Swipe: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3v18" />
      <path d="m8 9-3 3 3 3" />
      <path d="m16 9 3 3-3 3" />
    </Svg>
  ),
  ZoomIn: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
      <path d="M8 11h6M11 8v6" />
    </Svg>
  ),
  ZoomOut: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
      <path d="M8 11h6" />
    </Svg>
  ),
  /** Arrows tucking into corners — zoom to fit. */
  Fit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 3H5a2 2 0 0 0-2 2v4" />
      <path d="M15 3h4a2 2 0 0 1 2 2v4" />
      <path d="M9 21H5a2 2 0 0 1-2-2v-4" />
      <path d="M15 21h4a2 2 0 0 0 2-2v-4" />
    </Svg>
  ),
  /** "1:1" — show the image at its actual pixel size. */
  ActualSize: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 10v5M7 11l1-1" />
      <path d="M16 10v5M15 11l1-1" />
      <circle cx="12" cy="10.6" r="0.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="13.8" r="0.4" fill="currentColor" stroke="none" />
    </Svg>
  ),
  /** Angle brackets — view an SVG's underlying code diff. */
  Code: (p: IconProps) => (
    <Svg {...p}>
      <path d="m8 7-5 5 5 5" />
      <path d="m16 7 5 5-5 5" />
    </Svg>
  ),
  /** Picture frame — the image (visual) view of an SVG diff. */
  Image: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m3 17 5-4 4 3 4-4 5 5" />
    </Svg>
  ),
  EyeOff: (p: IconProps) => (
    <Svg {...p}>
      <path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61" />
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="m2 2 20 20" />
    </Svg>
  ),
  /** Filled with a rounded outline: thin strokes alias into mush at pill
   *  sizes, solid bodies anti-alias cleanly. Nudged right of geometric
   *  center — optical centering inside a circle. */
  Play: (p: IconProps) => (
    <Svg {...p}>
      <path d="M9 5.5v13l10-6.5z" fill="currentColor" strokeLinejoin="round" />
    </Svg>
  ),
  /** Filled bars for the same anti-aliasing reason as Play. */
  Pause: (p: IconProps) => (
    <Svg {...p}>
      <rect x="7.6" y="5.5" width="3.4" height="13" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.4" y="5.5" width="3.4" height="13" rx="1.2" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Prev: (p: IconProps) => (
    <Svg {...p}>
      <path d="m14.5 6-6 6 6 6" />
    </Svg>
  ),
  Next: (p: IconProps) => (
    <Svg {...p}>
      <path d="m9.5 6 6 6-6 6" />
    </Svg>
  ),
  /** A crosshair — align differently-sized revisions by their centers. */
  AnchorCenter: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
    </Svg>
  ),
  /** A corner with a nested box — align revisions by their top-left corners. */
  AnchorCorner: (p: IconProps) => (
    <Svg {...p}>
      <path d="M20.5 3.5h-17v17" />
      <rect x="7" y="7" width="8.5" height="8.5" rx="1" />
    </Svg>
  )
}
