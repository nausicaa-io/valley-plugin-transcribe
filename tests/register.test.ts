import { transcribeServices } from '../src/serviceClient'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import { readSettings } from '../src/store'
import { describe, expect, it, vi } from 'vitest'
import {
  FILE_TREE_CONTEXT_ITEM_V1,
  PLUGIN_SURFACE_V1,
  METADATA_PANEL_SEGMENT_V1,
  SEARCH_RESULT_CARD_V1
} from '@valley/plugin-sdk'
import { createMockValleyApi } from './harness'
import { register } from '../src/index'
import TRANSCRIBE_PLUGIN_CONFIG from '../config.json'

function setup(): ReturnType<typeof createMockValleyApi> {
  return createMockValleyApi({ manifest: { id: 'transcribe' } })
}

describe('register', () => {
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
    expect(api.interop.extensions.providers(SEARCH_RESULT_CARD_V1).map(({ extension }) => extension.cardKind)).toEqual(['transcript-segment'])
    dispose()
    expect(api.interop.extensions.providers(METADATA_PANEL_SEGMENT_V1)).toHaveLength(0)
    expect(api.interop.extensions.providers(FILE_TREE_CONTEXT_ITEM_V1)).toHaveLength(0)
    expect(api.interop.extensions.providers(SEARCH_RESULT_CARD_V1)).toHaveLength(0)
    expect(api.commands.list()).toHaveLength(0)
  })
})

describe('manifest', () => {
  it('declares what it contributes and the dataset path it repairs', () => {
    expect(TRANSCRIBE_PLUGIN_CONFIG.provides.map((claim) => claim.id)).toEqual([
      'search.resultCard',
      'metadataPanel.segment',
      'fileTree.contextItem',
      'workspace.surface'
    ])
    // Without this a rename orphans every transcript: the records name the media
    // file, and nothing else knows they do.
    expect(TRANSCRIBE_PLUGIN_CONFIG.pathRefs).toEqual([
      { source: 'dataset', dataset: 'transcribe.transcriptions', pathColumn: 'file' }
    ])
  })

  it('names an icon the host can actually resolve', () => {
    expect(TRANSCRIBE_PLUGIN_CONFIG.icon).toBe('text-align-left')
  })
})


describe('transcript surfaces', () => {
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
