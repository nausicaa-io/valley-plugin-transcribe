import { describe, expect, it, vi } from 'vitest'
import type { DatasetRecord } from '@valley/plugin-sdk'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { createMockValleyApi } from './harness'
import config from '../config.json'
import { initRuntime } from '../src/runtime'
import { loadSegments, segmentsForFile } from '../src/store'

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
    await expect(reading).resolves.toMatchObject([{ file: 'Meadow.mp3' }])
  })
})
