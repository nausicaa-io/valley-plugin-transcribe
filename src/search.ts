/**
 * Finding a phrase inside a transcript.
 *
 * Pure on purpose, like `follow.ts`: filtering and highlighting are a function
 * of (lines, query), so both are unit-testable without a DOM — see
 * `tests/search.test.ts`.
 *
 * Matching runs as a case-insensitive regex over the **original** text rather
 * than over a lowercased copy. A lowercased haystack is not always the same
 * length as its source (ẞ → ss, İ → i̇), and every offset the highlighter needs
 * would then point at the wrong character. The query is escaped, so a person
 * searching for `(` searches for a parenthesis, not for a broken group.
 */

export interface MatchRange {
  start: number
  end: number
}

export interface SearchHit {
  /** Index into the *unfiltered* segment list — follow mode indexes the same way. */
  index: number
  ranges: MatchRange[]
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g

export function escapeQuery(query: string): string {
  return query.replace(SPECIAL, '\\$&')
}

/** Every occurrence of `query` in `text`, in order. Empty when either is blank. */
export function matchRanges(text: string, query: string): MatchRange[] {
  const needle = query.trim()
  if (!needle) return []
  const pattern = new RegExp(escapeQuery(needle), 'gi')
  const ranges: MatchRange[] = []
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || match[0].length === 0) break
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

/**
 * The lines to show for `query`, each with the ranges to highlight.
 *
 * A blank query returns every line with no ranges — the search field is empty
 * far more often than not, and that case must not cost a regex per line.
 */
export function searchLines(texts: readonly string[], query: string): SearchHit[] {
  if (!query.trim()) return texts.map((_text, index) => ({ index, ranges: [] }))
  const hits: SearchHit[] = []
  texts.forEach((text, index) => {
    const ranges = matchRanges(text, query)
    if (ranges.length) hits.push({ index, ranges })
  })
  return hits
}

/** Split `text` into alternating plain/highlighted pieces for rendering. */
export function highlightPieces(
  text: string,
  ranges: readonly MatchRange[]
): { text: string; hit: boolean }[] {
  if (ranges.length === 0) return [{ text, hit: false }]
  const pieces: { text: string; hit: boolean }[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) pieces.push({ text: text.slice(cursor, range.start), hit: false })
    pieces.push({ text: text.slice(range.start, range.end), hit: true })
    cursor = range.end
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), hit: false })
  return pieces
}
