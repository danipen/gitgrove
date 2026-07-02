// Release-line detection for the Graph layout. A "release line" is a long-lived
// maintenance branch ("11.x", "release/2.3", "support/2022.3") — the branches a
// backport flows through. The layout pins them directly under the mainline,
// newest version first, so they form a stable spine stack (main on row 0, then
// 11.x, 10.x, …) instead of packing wherever their tip date happens to land.
//
// Detection is by name shape alone: a release namespace prefix, or a whole name
// shaped like a version. False positives only affect row ordering (a branch
// sits higher than it deserves), so the patterns can afford to be generous —
// but bare numbers ("12345") stay excluded: they're usually ticket ids.

/** Release namespaces: the prefix marks the branch; version digits optional. */
const RELEASE_PREFIX = /^(?:releases?|rel|support|maint(?:enance)?|stable|lts)[/-](.+)$/i

/** Loose version shape for names under a release namespace: "11", "2.3", "6.x". */
const PREFIXED_VERSION = /^v?\d+(?:\.(?:\d+|x))*$/i

/** Standalone version shape: "v10", "11.x", "2022.3" — needs a v or a dot, so a
 *  bare "10" (more likely a ticket id than a release line) never matches. */
const BARE_VERSION = /^(?:v\d+(?:\.(?:\d+|x))*|\d+(?:\.(?:\d+|x))+)$/i

/**
 * The version components of a release-line branch name: "release/2.3" → [2, 3],
 * "11.x" → [11], "lts/gallium" → [] (a release line without a version). Null
 * when the name isn't a release line at all. Sort with compareReleaseVersions.
 */
export function releaseLineVersion(name: string): readonly number[] | null {
  const prefixed = name.match(RELEASE_PREFIX)
  if (prefixed) return PREFIXED_VERSION.test(prefixed[1]) ? versionNumbersIn(prefixed[1]) : []
  return BARE_VERSION.test(name) ? versionNumbersIn(name) : null
}

/**
 * Sort comparator: newest version first, versionless lines last. A missing
 * component ranks below a present one, so "11.0" sorts before the bare "11.x".
 */
export function compareReleaseVersions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const diff = (b[i] ?? -1) - (a[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

function versionNumbersIn(text: string): number[] {
  return (text.match(/\d+/g) ?? []).map(Number)
}
