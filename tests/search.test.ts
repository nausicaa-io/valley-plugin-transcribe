import { describe, expect, it } from 'vitest'
import { highlightPieces, matchRanges, searchLines } from '../src/search'

describe('matchRanges', () => {
  it('finds every occurrence, ignoring case', () => {
    expect(matchRanges('Der Zug fährt, der Zug hält', 'der')).toEqual([
      { start: 0, end: 3 },
      { start: 15, end: 18 }
    ])
  })

  it('returns offsets into the original text, not a lowercased copy', () => {
    // `ẞ`.toLowerCase() is two characters — a lowercased haystack would shift
    // every offset after it and highlight the wrong span.
    const text = 'STRAẞE und Gasse'
    const [range] = matchRanges(text, 'gasse')
    expect(text.slice(range.start, range.end)).toBe('Gasse')
  })

  it('treats the query as text, never as a pattern', () => {
    expect(matchRanges('a (b) c', '(b)')).toEqual([{ start: 2, end: 5 }])
    expect(matchRanges('literal dots. only', '.')).toEqual([{ start: 12, end: 13 }])
  })

  it('has nothing to say about a blank query', () => {
    expect(matchRanges('some text', '')).toEqual([])
    expect(matchRanges('some text', '   ')).toEqual([])
  })
})

describe('searchLines', () => {
  const lines = ['Guten Morgen', 'Heute geht es um Impuls', 'Impulserhaltung, genauer']

  it('keeps every line for a blank query, and costs no match work', () => {
    expect(searchLines(lines, '')).toEqual([
      { index: 0, ranges: [] },
      { index: 1, ranges: [] },
      { index: 2, ranges: [] }
    ])
  })

  it('filters to matching lines, keeping their original indices', () => {
    // The index is what follow mode and `data-index` key off — a filtered list
    // must not renumber, or the highlighted line stops being the spoken one.
    expect(searchLines(lines, 'impuls').map((hit) => hit.index)).toEqual([1, 2])
  })

  it('reports no hits rather than every line when nothing matches', () => {
    expect(searchLines(lines, 'Drehmoment')).toEqual([])
  })
})

describe('highlightPieces', () => {
  it('splits a line into plain and hit runs, losing no character', () => {
    const text = 'Impuls und Impulserhaltung'
    const pieces = highlightPieces(text, matchRanges(text, 'impuls'))
    expect(pieces.map((piece) => piece.text).join('')).toBe(text)
    expect(pieces.filter((piece) => piece.hit).map((piece) => piece.text)).toEqual(['Impuls', 'Impuls'])
  })

  it('is one plain run when there is nothing to highlight', () => {
    expect(highlightPieces('unchanged', [])).toEqual([{ text: 'unchanged', hit: false }])
  })
})
