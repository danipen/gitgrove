// Reflow a hard-wrapped commit message body for display. Bodies are
// conventionally wrapped at 72/80 columns; showing them in a container that
// wraps at its own width double-wraps every paragraph into ragged lines.
// Shared by every commit-body presentation (History summary, Graph sidebar,
// graph hover card — see CommitBody in CommitSummary.tsx), so one commit
// reads identically everywhere.
// Heuristic: a newline after a long-enough line, followed
// by an ordinary continuation, was the wrap column — join them with a space.
// Everything that looks deliberate survives: blank lines (paragraphs),
// indented blocks, and bullet/numbered/quoted lines.

/** A line whose shape says "I was formatted on purpose — don't touch me". */
function isPreformatted(line: string): boolean {
  return /^(\s|[-*+>|]|\d+[.)]\s)/.test(line)
}

/** Minimum length before a line's trailing newline reads as a wrap column. */
const WRAP_THRESHOLD = 40

export function reflowMessage(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const prev = out[out.length - 1]
    if (
      prev !== undefined &&
      prev.length >= WRAP_THRESHOLD &&
      line.trim() !== '' &&
      !isPreformatted(prev) &&
      !isPreformatted(line)
    ) {
      out[out.length - 1] = `${prev} ${line}`
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}
