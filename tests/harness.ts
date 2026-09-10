import { createMockValleyApi as createBaseMock } from '@valley/plugin-testkit'
import type { TranscribeConnection } from '../src/serviceClient'
export * from '@valley/plugin-testkit'

export function createMockValleyApi(options: Parameters<typeof createBaseMock>[0] & { aiConnections?: TranscribeConnection[] } = {}) {
  const mock = createBaseMock(options)
  mock.api.backend.call = async <T>(method: string): Promise<T> => {
    if (method === 'listConnections') return { ok: true, data: { connections: options.aiConnections ?? [] } } as T
    if (method === 'status') return { ok: true, data: { available: false, binPath: null, ffmpeg: false } } as T
    if (method === 'cancel') return { ok: true, data: { cancelled: false } } as T
    throw new Error(`No backend fixture for ${method}`)
  }
  return mock
}
