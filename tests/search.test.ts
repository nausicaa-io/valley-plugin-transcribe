import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { createMockValleyApi } from './harness'
import { initRuntime } from '../src/runtime'
import { createTranscriptSearchCard } from '../src/TranscriptView'
import config from '../config.json'
import { highlightPieces, matchRanges, searchLines } from '../src/search'

afterEach(cleanup)

describe('vault transcript search', () => {
  const parent = { id: 'lecture', file: 'Research/Lecture.mp3', fileHash: 'hash', language: 'de', createdAt: '2026-09-10T10:00:00.000Z' }
  const segment = { transcriptionId: 'lecture', position: 8, segmentId: 'hash:8', start: 125.5, end: 134, text: 'Impulserhaltung im geschlossenen System' }

  function setup() {
    const mock = createMockValleyApi({ manifest: { ...config, id: 'transcribe' } as unknown as ValleyPluginManifest, files: { [parent.file]: 'media' } })
    mock.datasets.set('transcribe.transcriptions', [parent])
    mock.datasets.set('transcribe.transcript_segments', [segment])
    initRuntime(mock.api)
    return { mock, card: createTranscriptSearchCard(mock.api) }
  }

  it('declares every segment as searchable text with its parent media path and owning card', () => {
    const [source] = config.searchSources
    expect(source).toMatchObject({ id: 'transcript', source: 'dataset', dataset: 'transcribe.transcript_segments', fields: ['text'], default: true, pathField: 'file', cardKind: 'transcript-segment' })
    expect(source.joins).toEqual([{ dataset: 'transcribe.transcriptions', baseColumns: ['transcriptionId'], relatedColumns: ['id'], valueColumn: 'file', as: 'file', cardinality: 'one' }])
    expect(config.datasets.find((dataset) => `transcribe.${dataset.id}` === source.dataset)?.columns).toHaveProperty('text')
  })

  it('renders the matched words and timecode from the indexed segment', () => {
    const { card } = setup()
    render(card.render(segment, { title: 'Lecture.mp3', tags: [], path: parent.file, compact: true, onOpen: () => {} }))
    expect(screen.getByText(segment.text)).toBeInTheDocument()
    expect(screen.getByText('Lecture.mp3')).toBeInTheDocument()
    expect(screen.getByText('2:05')).toBeInTheDocument()
  })

  it('resolves the current segment and honors opening the media in a new tab', async () => {
    const { mock, card } = setup()
    await mock.api.data.dataset('transcribe.transcript_segments').update({ transcriptionId: 'lecture', position: 8 }, { start: 150 })
    expect(await card.open(segment, { path: 'Stale.mp3', newTab: true })).toBe(true)
    expect(mock.api.workspace.openFile).toHaveBeenCalledWith(parent.file, { type: 'media-time', seconds: 150 }, { newTab: true })
  })

  it('does not seek from stale records after the segment has been removed', async () => {
    const { mock, card } = setup()
    await mock.api.data.dataset('transcribe.transcript_segments').delete({ transcriptionId: 'lecture', position: 8 })
    expect(await card.open(segment, { path: parent.file })).toBe(false)
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
  })
})

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
