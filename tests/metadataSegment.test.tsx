import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from './harness'
import { initRuntime, React } from '../src/runtime'
import { MetadataSegment } from '../src/MetadataSegment'
import * as store from '../src/store'

describe('Transcribe Properties segment', () => {
  it('renders a degraded notice instead of throwing when the backend has failed', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe' } })
    mock.api.backend.call = vi.fn(() => { throw new Error('Plugin backend failed to start') }) as typeof mock.api.backend.call
    initRuntime(mock.api)
    const segments = vi.spyOn(store, 'segmentsForFile').mockRejectedValue(new Error('Plugin backend failed to start'))
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      render(<MetadataSegment relPath="Meadow.mp3" />)
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('Transcription service is unavailable')
      expect(alert.textContent).toContain('Plugin backend failed to start')
      expect(screen.getByRole('button', { name: 'Transcribe file…' })).toBeDisabled()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
      segments.mockRestore()
    }
  })
})
