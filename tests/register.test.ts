import { readFileSync } from 'node:fs'
import { transcribeServices } from '../src/serviceClient'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { replaceFileSegments, readSettings, segmentsForFile } from '../src/store'
import type { TranscriptSegment } from '../src/serviceClient'
import { describe, expect, it, vi } from 'vitest'
import {
  FILE_TREE_CONTEXT_ITEM_V1,
  PLUGIN_SURFACE_V1,
  METADATA_PANEL_SEGMENT_V1,
  SEARCH_RESULT_ACTION_V1
} from '@valley/plugin-sdk'
import { createMockValleyApi } from './harness'
import { register } from '../src/index'
import TRANSCRIBE_PLUGIN_CONFIG from '../config.json'
import Ajv from 'ajv'
import { segmentResult, segmentsResult } from '../src/commandResults'
import { inspectTranscriptProperties } from '../src/surfaces'

function setup(): ReturnType<typeof createMockValleyApi> {
  return createMockValleyApi({ manifest: { id: 'transcribe' } })
}

describe('register', () => {
  it('keeps an accepted command and its undo on the original API after a rebind', async () => {
    const manifest = { id: 'transcribe', datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets'] }
    const previous = createMockValleyApi({ manifest })
    let finish!: (value: { ok: boolean; data: TranscriptSegment[] }) => void
    transcribeServices(previous.api).file = async file => {
      const result = await new Promise<{ ok: boolean; data: TranscriptSegment[] }>(resolve => { finish = resolve })
      if (result.ok) await replaceFileSegments(file, result.data, previous.api)
      return result
    }
    const offPrevious = register(previous.api)
    const running = previous.api.commands.execute('transcribe:file', { file: 'Meadow.mp3' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const current = createMockValleyApi({ manifest })
    const offCurrent = register(current.api)
    const segment: TranscriptSegment = { id: 'meadow:0', file: 'Meadow.mp3', fileHash: 'meadow', start: 0, end: 2, text: 'Birdsong', language: 'en', createdAt: '2026-01-01T00:00:00.000Z' }
    finish({ ok: true, data: [segment] })
    const result = await running
    expect(result).toMatchObject({ ok: true, value: [segment] })
    expect(new Ajv({ strict: false }).validate(segmentsResult, result.ok && result.value)).toBe(true)
    expect(await segmentsForFile('Meadow.mp3', previous.api)).toEqual([segment])
    expect(await segmentsForFile('Meadow.mp3', current.api)).toEqual([])
    expect(previous.busUndo).toHaveLength(1)
    await previous.busUndo[0].undo()
    expect(await segmentsForFile('Meadow.mp3', previous.api)).toEqual([])
    await previous.busUndo[0].redo?.()
    expect(await segmentsForFile('Meadow.mp3', previous.api)).toEqual([segment])
    expect(await segmentsForFile('Meadow.mp3', current.api)).toEqual([])
    await Promise.all([offPrevious(), offCurrent()])
  })

  it('contributes a metadata-panel segment for audio and video', () => {
    const { api } = setup()
    register(api)
    const segments = api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).map((provider) => provider.extension)
    expect(segments).toHaveLength(2)
    segments.sort((a, b) => Number(!!b.fileKinds) - Number(!!a.fileKinds))
    expect(segments[0]).toMatchObject({
      id: 'transcribe.transcript',
      labelKey: 'manifest.name',
      icon: 'text-align-left',
      fileKinds: ['audio', 'video']
    })
    // Video is not incidental — Whisper reads it through ffmpeg exactly like
    // audio, and a long wildlife recording is the case this feature exists for.
    expect(segments[0].fileKinds).toContain('video')
    // The English label ships beside the key so an untranslated locale reads as
    // a word rather than as `plugin.transcribe.name`.
    expect(segments[0].label).toBe('Transcribe')
  })

  it('scopes the segment to files, never to plugin tabs', () => {
    const { api } = setup()
    register(api)
    const [segment] = api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1).map((provider) => provider.extension)
    // `pluginTabs` would put this panel on the plugin's own fileless tabs, which
    // have no media to transcribe.
    expect(segment.pluginTabs).toBeUndefined()
  })

  it('registers the file, page, settings and footer views', () => {
    const { api } = setup()
    register(api)
    const keys = (api.registerView as unknown as { mock: { calls: [string][] } }).mock.calls.map(
      (call) => call[0]
    )
    expect(keys.sort()).toEqual([
      'transcribe.file',
      'transcribe.footer',
      'transcribe.page',
      'transcribe.settings'
    ])
  })

  it('watches the progress channel for the whole life of the plugin', () => {
    const { api } = setup()
    // Not per panel: the note-panel segment unmounts on every segment switch,
    // and a run whose progress nothing was listening to loses its footer chip
    // and its finished notification.
    const off = vi.fn()
    const onProgress = vi.fn(() => off)
    transcribeServices(api).onProgress = onProgress
    const dispose = register(api)
    expect(onProgress).toHaveBeenCalledTimes(1)
    dispose()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it('offers the file-tree entry on media files only', () => {
    const { api } = setup()
    register(api)
    const [item] = api.interop.extensions.providers(FILE_TREE_CONTEXT_ITEM_V1).map((provider) => provider.extension)
    expect(item.fileKinds).toEqual(['audio', 'video'])
    // `captions` is not in the host's glyph table; naming it silently rendered a
    // generic box on both the menu row and the panel chip.
    expect(item.icon).toBe('text-align-left')
  })

  it('takes everything back down on dispose', () => {
    const { api } = setup()
    const dispose = register(api)
    expect(api.interop.extensions.providers(SEARCH_RESULT_ACTION_V1).map(({ extension }) => extension.cardKind)).toEqual(['transcript-segment'])
    dispose()
    expect(api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)).toHaveLength(0)
    expect(api.interop.extensions.providers(FILE_TREE_CONTEXT_ITEM_V1)).toHaveLength(0)
    expect(api.interop.extensions.providers(SEARCH_RESULT_ACTION_V1)).toHaveLength(0)
    expect(api.commands.list()).toHaveLength(0)
  })
})

describe('manifest', () => {
  it('declares what it contributes and the dataset path it repairs', () => {
    expect(TRANSCRIBE_PLUGIN_CONFIG.provides.map((claim) => claim.id)).toEqual([
      'search.resultAction',
      'metadataPanel.segment',
      'fileTree.contextItem',
      'workspace.surface',
      'workspace.bookmark'
    ])
    // Without this a rename orphans every transcript: the records name the media
    // file, and nothing else knows they do.
    expect(TRANSCRIBE_PLUGIN_CONFIG.pathRefs).toEqual([
      { source: 'dataset', dataset: 'transcribe.transcriptions', pathColumn: 'file' }
    ])
  })

  it('names an icon the host can actually resolve', () => {
    expect(readFileSync(TRANSCRIBE_PLUGIN_CONFIG.icon, 'utf8')).toContain('<svg')
  })
})


describe('transcript surfaces', () => {
  it('returns typed transcript and property results with false and empty values', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe', datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets'] }, files: { 'Track.mp3': 'media' } })
    const registered = vi.spyOn(mock.api.commands, 'register')
    const dispose = register(mock.api)
    const validator = new Ajv({ strict: false })
    const segment: TranscriptSegment = { id: 'track:0', file: 'Track.mp3', fileHash: 'track', start: 0, end: 2, text: '', language: '', createdAt: '2026-01-01T00:00:00.000Z' }
    await replaceFileSegments(segment.file, [segment], mock.api)
    const invoke = async (id: string, input?: unknown) => {
      const result = await mock.api.commands.execute(`transcribe:${id}`, input)
      expect(result.ok, id).toBe(true)
      if (!result.ok) throw new Error(`Command failed: ${id}`)
      const entry = registered.mock.calls.find(([command]) => command.id === id)![0]
      const spec = entry as typeof entry & { outputSchema: Record<string, unknown> }
      expect(validator.validate(spec.outputSchema, result.value), JSON.stringify(validator.errors)).toBe(true)
      return result.value
    }
    try {
      expect(await invoke('list', { query: '' })).toEqual([segment])
      expect(await invoke('get', { file: segment.file })).toEqual([segment])
      await invoke('jobs')
      expect(await invoke('open-segment', { id: segment.id })).toEqual(segment)
      expect(validator.validate(segmentResult, segment)).toBe(true)
      expect(mock.api.workspace.openFile).toHaveBeenCalledWith(segment.file, { type: 'media-time', seconds: 0 })
      const baseline = JSON.stringify(await inspectTranscriptProperties(segment.file))
      await invoke('properties-edit', { subject: { pluginId: 'transcribe', surface: 'main_workspace', view: { file: segment.file } }, values: { follow: false, query: '', language: '' } })
      expect(await inspectTranscriptProperties(segment.file)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'follow', value: false }), expect.objectContaining({ id: 'query', value: '' })]))
      await mock.busUndo.at(-1)!.undo()
      expect(JSON.stringify(await inspectTranscriptProperties(segment.file))).toBe(baseline)
    } finally { await dispose() }
  })
  it('restores view drafts without changing global engine setup or stealing background focus', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe', datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets'] }, files: { 'Track.mp3': 'media' } })
    const dispose = register(mock.api)
    const provider = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1).find((entry) => entry.extension.surface === 'right_sidebar')!.extension
    await provider.restore({ v: 1, file: 'Track.mp3', query: 'phrase', tab: 'setup', engine: 'openai' }, undefined, { background: true })
    expect(provider.getSnapshot().view).toMatchObject({ file: 'Track.mp3', query: 'phrase', tab: 'setup' })
    expect(readSettings().engine).toBe('local')
    expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
    await expect(provider.restore({ v: 1, file: 'Missing.mp3' })).rejects.toThrow('no longer exists')
    expect(provider.getSnapshot().view.file).toBe('Track.mp3')
    dispose()
  })

  it('declares open-segment as a window-state effect and refuses missing targets as not applied', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe', datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets'] }, files: { 'Track.mp3': 'media' } })
    const registered = vi.spyOn(mock.api.commands, 'register')
    const dispose = register(mock.api)
    try {
      expect(mock.api.commands.describe('transcribe:open-segment')).toMatchObject({ sideEffect: 'execute', previewSupported: true })
      const command = registered.mock.calls.find(([spec]) => spec.id === 'open-segment')![0] as unknown as { run: (input: { id: string }) => Promise<unknown> }
      await expect(command.run({ id: 'missing:0' })).rejects.toMatchObject({ code: 'SEGMENT_NOT_FOUND', outcome: 'not-applied' })
      await replaceFileSegments('Gone.mp3', [{ id: 'gone:0', file: 'Gone.mp3', fileHash: 'gone', start: 1, end: 2, text: 'x', language: 'en', createdAt: '2026-01-01T00:00:00.000Z' }], mock.api)
      await expect(command.run({ id: 'gone:0' })).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', outcome: 'not-applied' })
      expect(mock.api.workspace.openFile).not.toHaveBeenCalled()
    } finally { await dispose() }
  })

  it('refuses properties edits without a transcript subject before any effect', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe', datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets'] } })
    const registered = vi.spyOn(mock.api.commands, 'register')
    const set = vi.spyOn(mock.api.settings, 'set')
    const dispose = register(mock.api)
    try {
      const spec = registered.mock.calls.find(([command]) => command.id === 'properties-edit')![0] as unknown as { input: { schema: Record<string, unknown>; parse: (raw: unknown) => unknown } }
      const validate = new Ajv({ strict: false }).compile(spec.input.schema)
      for (const subject of [{}, { view: null }, { view: 'Track.mp3' }, { view: { file: '' }, item: {} }, { view: { file: '' }, item: { state: null } }]) {
        const input = { subject, values: { engine: 'openai' } }
        expect(validate(input), JSON.stringify(subject)).toBe(false)
        expect(() => spec.input.parse(input)).toThrow(expect.objectContaining({ message: 'Expected a transcript subject.', code: 'INVALID_SUBJECT', outcome: 'not-applied' }))
        expect(await mock.api.commands.execute('transcribe:properties-edit', input)).toEqual({ ok: false, error: { kind: 'invalid-input', message: 'Expected a transcript subject.' } })
      }
      expect(validate({ subject: { view: { v: 1, file: '' } }, values: { follow: false } })).toBe(true)
      expect(set).not.toHaveBeenCalled()
      expect(readSettings().engine).toBe('local')
    } finally { await dispose() }
  })

  it('rejects unavailable connection edits and failed settings writes', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe', datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets'] } })
    const dispose = register(mock.api)
    const subject = { pluginId: 'transcribe', surface: 'main_workspace', view: { v: 1, file: '' } }
    expect(await mock.api.commands.execute('transcribe:properties-edit', { subject, values: { openAiConnectionId: 'missing' } })).toMatchObject({ ok: false })
    const set = vi.spyOn(mock.api.settings, 'set').mockResolvedValueOnce({ ok: false, error: 'Disk unavailable' })
    expect(await mock.api.commands.execute('transcribe:properties-edit', { subject, values: { engine: 'openai' } })).toMatchObject({ ok: false })
    expect(set).toHaveBeenCalledWith('engine', 'openai')
    expect(readSettings().engine).toBe('local')
    dispose()
  })
})
