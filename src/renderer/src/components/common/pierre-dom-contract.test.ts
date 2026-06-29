import { describe, expect, test } from 'bun:test'
import type { DiffLineAnnotation } from '@pierre/diffs/ssr'
import { preloadDiffHTML } from '@pierre/diffs/ssr'

/**
 * Guard the @pierre/diffs DOM contract that our line-level staging styling rides on.
 *
 * Our staging UI doesn't render its own diff — it reaches *into* pierre's shadow tree
 * with CSS keyed to pierre's private data-attributes (DiffViewer's `LINE_CHECKBOX_CSS`,
 * `GUTTER_POLISH_CSS`, `STAGE_BAR_SPAN_CSS`, and `buildExcludedDiffCss` in lib/staging).
 * Those attributes are an undocumented, internal contract: a `@pierre/diffs` bump can
 * rename or restructure them and nothing throws — the checkboxes, the hatch, and the
 * gutter-aligned "Include in commit" bar just silently stop working.
 *
 * This test renders pierre the same way the app does (server-side, so it's fast and can't
 * flake — no browser) and asserts every attribute that styling depends on still exists, in
 * both split and unified. When it fails, the message names the broken selector, the exact
 * constant that uses it, what it's for, and how to re-pin it. Treat a failure as: "pierre
 * changed its DOM — update the matching CSS in DiffViewer/staging to the new shape."
 *
 * NOT covered here (no SSR markup to assert against — re-check by hand on a pierre bump,
 * driving the real app per CLAUDE.md):
 *   • `data-hovered` — pierre sets it on the hovered number cell at runtime; used by
 *     LINE_CHECKBOX_CSS (brighten the check) and buildExcludedDiffCss (gray excluded rows).
 *   • pierre's CSS custom-property indirection we consume/override: `--diffs-bg`,
 *     `--diffs-bg-buffer` (the hatch), and the `--diffs-bg-{addition,deletion}-emphasis`
 *     / `--diffs-fg-number-{addition,deletion}` `*-override` knobs (buildExcludedDiffCss).
 *     These live in pierre's internal stylesheet, which isn't a public export.
 *   • The layout facts STAGE_BAR_SPAN_CSS leans on: the gutter is `position:sticky;
 *     z-index:3` and `[data-content]` is not a stacking context (so a z-index on the
 *     annotation row lifts it above the gutter). Verified on screen, not in markup.
 */

// A small modified file: line 1 changes (so a changed addition *and* deletion exist),
// lines 2-3 stay (context). One annotation anchored on the added side — the shape the
// staging bar uses. `metadata: undefined` matches our `LAnnotation = undefined` usage.
const oldFile = { name: 'sample.ts', contents: 'one\ntwo\nthree\n' }
const newFile = { name: 'sample.ts', contents: 'ONE-changed\ntwo\nthree\n' }
const annotations: DiffLineAnnotation[] = [
  { side: 'additions', lineNumber: 1, metadata: undefined }
]

const render = (diffStyle: 'split' | 'unified') =>
  preloadDiffHTML({
    oldFile,
    newFile,
    options: { diffStyle, theme: 'pierre-light', themeType: 'light' },
    annotations
  })

type Mode = 'split' | 'unified'

interface Contract {
  /** Human name of the pierre attribute/selector we depend on. */
  selector: string
  /** True when the rendered markup still carries it. */
  present(html: string): boolean
  /** Which diff modes should contain it. */
  modes: Mode[]
  /** The constant + file that keys off it. */
  usedBy: string
  /** Why our styling needs it. */
  purpose: string
  /** What to do if pierre dropped/renamed it. */
  fix: string
}

// Attribute-boundary match: `data-foo` followed by `=`, `>` or whitespace, so `data-line`
// never matches `data-line-annotation`/`data-line-type`.
const attr = (name: string) => (html: string) => new RegExp(`${name}(=|>|\\s)`).test(html)
const has = (needle: string) => (html: string) => html.includes(needle)

const CONTRACTS: Contract[] = [
  {
    selector: '[data-code] (per-side wrapper)',
    present: attr('data-code'),
    modes: ['split', 'unified'],
    usedBy: 'DiffViewer STAGE_BAR_SPAN_CSS — `[data-code]{container-type:inline-size}`',
    purpose:
      'Each diff side is the query container the staging bar sizes itself against with ' +
      '`100cqi`, letting it span from the gutter to the visible edge.',
    fix: "Re-point STAGE_BAR_SPAN_CSS at pierre's new side wrapper, and re-confirm the `100cqi` width in .stage-bar (changes.css) still resolves against it."
  },
  {
    selector: '[data-additions] (split additions side)',
    present: attr('data-additions'),
    modes: ['split'],
    usedBy: 'DiffViewer STAGE_BAR_SPAN_CSS (lifts/spans the bar on its own side only)',
    purpose: 'Scopes the gutter-spanning bar + z-index lift to the side that carries it.',
    fix: 'Update the side selectors in STAGE_BAR_SPAN_CSS to the new additions-side attribute.'
  },
  {
    selector: '[data-deletions] (split deletions/mirror side)',
    present: attr('data-deletions'),
    modes: ['split'],
    usedBy: 'DiffViewer GUTTER_POLISH_CSS — clears the empty mirror annotation row',
    purpose:
      'On a split deletion the bar gets a blank mirror row on the other side; we clear it ' +
      'to hatch so only the real bar shows.',
    fix: 'Update the `[data-deletions] …` selectors in GUTTER_POLISH_CSS to the new mirror-side attribute.'
  },
  {
    selector: '[data-unified] (unified single column)',
    present: attr('data-unified'),
    modes: ['unified'],
    usedBy: 'DiffViewer STAGE_BAR_SPAN_CSS (lifts/spans the bar in unified)',
    purpose: 'Unified has one column; the span/lift is scoped to it.',
    fix: 'Update the `[data-unified]` branch of STAGE_BAR_SPAN_CSS to the new unified-column attribute.'
  },
  {
    selector: '[data-content] (content column wrapper)',
    present: attr('data-content'),
    modes: ['split', 'unified'],
    usedBy: 'DiffViewer GUTTER_POLISH_CSS (paints the hatch on the content wrapper)',
    purpose:
      'The hatch is painted on the content column wrapper and revealed through transparent ' +
      'filler cells; the bar also relies on `[data-content]` not being a stacking context.',
    fix: 'Re-point the wrapper selector in GUTTER_POLISH_CSS; re-verify the hatch and the bar lift on screen.'
  },
  {
    selector: '[data-line-annotation] (content cell that hosts the bar)',
    present: has('data-line-annotation'),
    modes: ['split', 'unified'],
    usedBy: 'DiffViewer STAGE_BAR_SPAN_CSS (z-index lift) + GUTTER_POLISH_CSS (clears mirror)',
    purpose:
      'Pierre slots our `.stage-bar` into this cell; the lift makes it paint above the gutter.',
    fix: 'Re-point the `[data-line-annotation]` selectors; confirm `renderAnnotation` still lands here.'
  },
  {
    selector: '[data-content-buffer] (hatched content filler)',
    present: has('data-content-buffer'),
    modes: ['split', 'unified'],
    usedBy: 'DiffViewer GUTTER_POLISH_CSS — made transparent to reveal the wrapper hatch',
    purpose: 'The filler cells on the empty side must be see-through for the continuous hatch.',
    fix: 'Re-point the `[data-content-buffer]` selector in GUTTER_POLISH_CSS.'
  },
  {
    selector: '[data-column-number] (gutter line-number cell)',
    present: has('data-column-number'),
    modes: ['split', 'unified'],
    usedBy: 'DiffViewer LINE_CHECKBOX_CSS + lib/staging buildExcludedDiffCss',
    purpose:
      'The number cell is reused as the per-line ✓ checkbox (its ::after) and reserves the check column.',
    fix: 'Update the number-cell selector in LINE_CHECKBOX_CSS and buildExcludedDiffCss.'
  },
  {
    selector: 'data-line-type="change-addition" / "change-deletion"',
    present: (html) =>
      has('data-line-type="change-addition"')(html) &&
      has('data-line-type="change-deletion"')(html),
    modes: ['split'],
    usedBy: 'DiffViewer LINE_CHECKBOX_CSS (CHANGED_NUM) + lib/staging buildExcludedDiffCss',
    purpose: 'Only *changed* lines get a clickable check; the type also picks the add/del accent.',
    fix: 'Update the `data-line-type` values in CHANGED_NUM (LINE_CHECKBOX_CSS) and buildExcludedDiffCss.'
  },
  {
    selector: 'numeric line targeting — data-line="N" and data-column-number="N"',
    present: (html) => /data-line="\d+"/.test(html) && /data-column-number="\d+"/.test(html),
    modes: ['split', 'unified'],
    usedBy: 'lib/staging buildExcludedDiffCss',
    purpose:
      'Excluded lines are grayed by addressing a specific line *number* on both the row and its gutter cell.',
    fix: 'Update how buildExcludedDiffCss builds its per-line selectors to match pierre’s new line-number attributes.'
  }
]

describe('@pierre/diffs DOM contract (line-level staging)', () => {
  test('every attribute our staging CSS depends on is still rendered', async () => {
    const html: Record<Mode, string> = {
      split: await render('split'),
      unified: await render('unified')
    }

    for (const c of CONTRACTS) {
      for (const mode of c.modes) {
        const ok = c.present(html[mode])
        if (!ok) {
          throw new Error(
            `@pierre/diffs DOM contract broken in ${mode} view: ${c.selector}\n` +
              `  Used by: ${c.usedBy}\n` +
              `  Purpose: ${c.purpose}\n` +
              `  Likely cause: a @pierre/diffs bump renamed/restructured this attribute.\n` +
              `  Fix: ${c.fix}\n` +
              '  (See pierre-dom-contract.test.ts header for contracts this test cannot cover.)'
          )
        }
        expect(ok).toBe(true)
      }
    }
  })
})
