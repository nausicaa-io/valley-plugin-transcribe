import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptSegment } from '../src/serviceClient'
import { PLUGIN_SURFACE_V1 } from '@valley/plugin-sdk'
import { createMockValleyApi } from './harness'
import { initRuntime, React } from '../src/runtime'
import { registerTranscriptSurfaces, selectTranscript, useTranscriptField, useTranscriptSurface } from '../src/surfaces'
import * as store from '../src/store'

function Subject({ path }: { path: string }): React.ReactElement | null {
  useTranscriptSurface(path, 'right_sidebar')
  return null
}

describe('transcript selection ownership', () => {
  it('releases mounted and provider subscriptions after the owning session is revoked', () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe' } })
    initRuntime(mock.api)
    const dispose = registerTranscriptSurfaces(mock.api)
    function Field(): null {
      useTranscriptField('Meadow.mp3', 'query', '')
      return null
    }
    const mounted = render(<Field />)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
    const unsubscribe = surface.subscribe(vi.fn())
    const state = mock.api.runtime.getOrCreate('transcribe.surfaces', () => ({ listeners: new Set() }))
    expect(state.listeners.size).toBe(2)
    dispose()
    const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => {
      throw new Error('Plugin session is no longer active')
    })
    try {
      unsubscribe()
      mounted.unmount()
      expect(state.listeners.size).toBe(0)
      expect(runtime).not.toHaveBeenCalled()
    } finally {
      runtime.mockRestore()
      mounted.unmount()
    }
  })

  it.each(['resolve', 'reject'] as const)('cancels an in-flight surface refresh on disposal (%s)', async (outcome) => {
    let refresh!: () => void
    let resolve!: (segments: TranscriptSegment[]) => void
    let reject!: (error: Error) => void
    const onChanged = vi.spyOn(store, 'onChanged').mockImplementation((listener) => { refresh = listener; return () => {} })
    const loadSegments = vi.spyOn(store, 'loadSegments').mockReturnValue(new Promise((accept, fail) => { resolve = accept; reject = fail }))
    const mock = createMockValleyApi({ manifest: { id: 'transcribe' } })
    initRuntime(mock.api)
    const dispose = registerTranscriptSurfaces(mock.api)
    selectTranscript({ id: 'segment-a', file: 'A.mp3', fileHash: 'hash-a', start: 0, end: 4, text: 'Transcript A', language: 'en', createdAt: '2026-08-31T00:00:00.000Z' }, 'main_workspace')
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
    const listener = vi.fn()
    const unsubscribe = surface.subscribe(listener)
    refresh()
    expect(loadSegments).toHaveBeenCalledTimes(1)
    dispose()
    unsubscribe()
    refresh()
    expect(loadSegments).toHaveBeenCalledTimes(1)
    const runtime = vi.spyOn(mock.api.runtime, 'getOrCreate').mockImplementation(() => {
      throw new Error('Plugin session is no longer active')
    })
    try {
      if (outcome === 'resolve') resolve([])
      else reject(new Error('Plugin session is no longer active'))
      await new Promise((done) => setTimeout(done, 0))
      expect(listener).not.toHaveBeenCalled()
      expect(runtime).not.toHaveBeenCalled()
    } finally {
      runtime.mockRestore()
      onChanged.mockRestore()
      loadSegments.mockRestore()
    }
  })

  it('notifies an empty surface without loading every transcript when records change', () => {
    let refresh!: () => void
    const onChanged = vi.spyOn(store, 'onChanged').mockImplementation((listener) => { refresh = listener; return () => {} })
    const loadSegments = vi.spyOn(store, 'loadSegments')
    const mock = createMockValleyApi({ manifest: { id: 'transcribe' } })
    initRuntime(mock.api)
    const dispose = registerTranscriptSurfaces(mock.api)
    const surface = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)[0].extension
    const listener = vi.fn()
    const unsubscribe = surface.subscribe(listener)
    try {
      refresh()
      expect(listener).toHaveBeenCalledOnce()
      expect(loadSegments).not.toHaveBeenCalled()
    } finally {
      dispose()
      unsubscribe()
      onChanged.mockRestore()
      loadSegments.mockRestore()
    }
  })

  it('clears the old sidebar segment when media changes while preserving the all-transcripts selection', () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe' } })
    initRuntime(mock.api)
    const off = registerTranscriptSurfaces(mock.api)
    const segment: TranscriptSegment = { id: 'segment-a', file: 'A.mp3', fileHash: 'hash-a', start: 0, end: 4, text: 'Transcript A', language: 'en', createdAt: '2026-08-31T00:00:00.000Z' }
    const view = render(<Subject path="A.mp3" />)
    selectTranscript(segment, 'right_sidebar')
    selectTranscript(segment, 'main_workspace')
    const providers = mock.api.interop.extensions.providers(PLUGIN_SURFACE_V1)
    const sidebar = providers.find((entry) => entry.extension.surface === 'right_sidebar')!.extension
    const main = providers.find((entry) => entry.extension.surface === 'main_workspace')!.extension
    expect(sidebar.getSnapshot().item?.id).toBe(segment.id)
    view.rerender(<Subject path="B.mp3" />)
    expect(sidebar.getSnapshot().view.file).toBe('B.mp3')
    expect(sidebar.getSnapshot().item).toBeUndefined()
    expect(main.getSnapshot().item?.id).toBe(segment.id)
    off()
  })
})
