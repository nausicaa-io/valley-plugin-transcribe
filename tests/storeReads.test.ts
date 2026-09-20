import { describe, expect, it, vi } from 'vitest'
import type { DatasetRecord } from '@valley/plugin-sdk'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { createMockValleyApi } from './harness'
import config from '../config.json'
import { initRuntime } from '../src/runtime'
import { loadSegments, replaceFileSegments, segmentsForFile } from '../src/store'

const parent = { id: 'recording', file: 'Meadow.mp3', fileHash: 'meadow-hash', language: 'en', createdAt: '2026-01-01T00:00:00.000Z' }
const segment = (position: number): DatasetRecord => ({ transcriptionId: 'recording', position, segmentId: `segment-${position}`, start: position, end: position + 1, text: `Birdsong ${position}` })

function setup() {
  const mock = createMockValleyApi({ manifest: { ...config, id: 'transcribe' } as unknown as ValleyPluginManifest })
  mock.datasets.set('transcribe.transcriptions', [parent])
  mock.datasets.set('transcribe.transcript_segments', [segment(0)])
  initRuntime(mock.api)
  return mock
}

describe('transcript read coalescing', () => {
  it.each([999, 1000, 1001, 2000])('replaces %i segments in one bounded transaction without retaining the previous tail', async count => {
    const mock = setup()
    const previous = await loadSegments(mock.api)
    const next = Array.from({ length: count }, (_, position) => ({
      ...previous[0], id: `new-${position}`, start: position, end: position + 1, text: `Wetland ${position}`
    }))
    const transaction = mock.api.data.transaction.bind(mock.api.data)
    const calls = vi.spyOn(mock.api.data, 'transaction').mockImplementation(async (operations, options) => {
      if (operations.length > 1000) throw new Error('Invalid transaction size')
      return transaction(operations, options)
    })
    expect(await replaceFileSegments('Meadow.mp3', next, mock.api)).toEqual({ ok: true, previous })
    expect(calls).toHaveBeenCalledOnce()
    expect(calls.mock.calls[0][0]).toHaveLength(3)
    expect(calls.mock.calls[0][0][2].values).toHaveLength(count)
    expect(await segmentsForFile('Meadow.mp3', mock.api)).toEqual(next)
    expect(await replaceFileSegments('Meadow.mp3', next.slice(0, 2), mock.api)).toEqual({ ok: true, previous: next })
    expect(await segmentsForFile('Meadow.mp3', mock.api)).toEqual(next.slice(0, 2))
  })

  it('shares a held read and one fresh scan across a burst of record and parent changes', async () => {
    const mock = setup()
    mock.datasets.set('transcribe.transcript_segments', Array.from({ length: 1001 }, (_, position) => segment(position)))
    const dataset = mock.api.data.dataset.bind(mock.api.data)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const scans = new Map<string, number>()
    vi.spyOn(mock.api.data, 'dataset').mockImplementation(<T extends DatasetRecord>(id: string) => {
      const handle = dataset<T>(id)
      return { ...handle, query: async (query) => {
        const count = (scans.get(id) ?? 0) + 1
        scans.set(id, count)
        const page = await handle.query(query)
        if (id === 'transcribe.transcript_segments' && count === 1) await held
        return page
      } }
    })
    const reading = loadSegments()
    const fileReading = segmentsForFile('Meadow.mp3')
    for (let position = 1001; position <= 1010; position += 1) {
      await mock.api.data.dataset('transcribe.transcript_segments').insert(segment(position))
      expect(loadSegments()).toBe(reading)
    }
    await mock.api.data.dataset('transcribe.transcriptions').update({ id: 'recording' }, { language: 'de' })
    expect(scans.get('transcribe.transcript_segments')).toBe(1)
    release()
    const [all, own] = await Promise.all([reading, fileReading])
    expect(all).toHaveLength(1011)
    expect(own).toEqual(all)
    expect(all.every((entry) => entry.language === 'de')).toBe(true)
    expect(all.at(-1)?.text).toBe('Birdsong 1010')
    expect(scans).toEqual(new Map([['transcribe.transcriptions', 2], ['transcribe.transcript_segments', 4]]))
  })

  it('clears a rejected shared read so an explicit retry can return saved records', async () => {
    const mock = setup()
    const dataset = mock.api.data.dataset.bind(mock.api.data)
    const failure = new Error('Transcript read failed')
    let failed = false
    vi.spyOn(mock.api.data, 'dataset').mockImplementation(<T extends DatasetRecord>(id: string) => {
      const handle = dataset<T>(id)
      return { ...handle, query: async (query) => {
        if (id === 'transcribe.transcript_segments' && !failed) { failed = true; throw failure }
        return handle.query(query)
      } }
    })
    const reading = loadSegments()
    expect(loadSegments()).toBe(reading)
    await expect(reading).rejects.toBe(failure)
    await expect(loadSegments()).resolves.toMatchObject([{ id: 'segment-0', file: 'Meadow.mp3', text: 'Birdsong 0' }])
  })

  it('does not reuse completed reads after a later dataset mutation', async () => {
    const mock = setup()
    expect(await loadSegments()).toHaveLength(1)
    await mock.api.data.dataset('transcribe.transcript_segments').delete({ transcriptionId: 'recording', position: 0 })
    await expect(loadSegments()).resolves.toEqual([])
  })

  it('keeps a previous session’s pending read out of the next session', async () => {
    const previous = setup()
    previous.datasets.set('transcribe.transcript_segments', Array.from({ length: 1001 }, (_, position) => segment(position)))
    const dataset = previous.api.data.dataset.bind(previous.api.data)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(previous.api.data, 'dataset').mockImplementation(<T extends DatasetRecord>(id: string) => {
      const handle = dataset<T>(id)
      return { ...handle, query: async (query) => {
        const page = await handle.query(query)
        if (id === 'transcribe.transcript_segments') await held
        return page
      } }
    })
    const reading = loadSegments()
    const current = setup()
    current.datasets.set('transcribe.transcriptions', [{ ...parent, file: 'Wetland.mp3' }])
    const next = loadSegments()
    expect(next).not.toBe(reading)
    await expect(next).resolves.toMatchObject([{ file: 'Wetland.mp3' }])
    release()
    const original = await reading
    expect(original).toHaveLength(1001)
    expect(original.every((segment) => segment.file === 'Meadow.mp3')).toBe(true)
  })
})
