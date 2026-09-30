import type { ValleyPluginApi } from '@valley/plugin-sdk'

export interface TranscriptSegment {
  id: string
  file: string
  fileHash: string
  start: number
  end: number
  text: string
  language: string
  model?: string
  transcriptionDurationMs?: number
  createdAt: string
}

export interface TranscribeProgress {
  jobId: string
  stage: 'start' | 'download' | 'upload' | 'request' | 'decode' | 'done' | 'error' | 'cancelled'
  percent?: number
  remainingMs?: number
  seconds?: number
  text?: string
  message?: string
}

export interface TranscribeConnection {
  id: string
  provider: string
  label: string
  providerName: string
  configured: boolean
}

export interface TranscribeInput {
  engine?: 'local' | 'openai'
  connectionId?: string
  model?: string
  language?: string
  jobId?: string
  durationMs?: number
}

type Result<T> = { ok: boolean; data?: T; error?: string }
function services(api: ValleyPluginApi) {
  return {
    file: (file: string, opts?: TranscribeInput) => api.backend.callOperation<Result<TranscriptSegment[]>>('file', { file, ...opts }),
    cancel: (jobId: string) => api.backend.callOperation<Result<{ cancelled: boolean }>>('cancel', { jobId }),
    status: (binPath?: string) => api.backend.call<Result<{ available: boolean; binPath: string | null; ffmpeg: boolean }>>('status', { binPath }),
    listConnections: () => api.backend.call<Result<{ connections: TranscribeConnection[] }>>('listConnections'),
    onProgress: (listener: (progress: TranscribeProgress) => void) => api.backend.on('progress', (event) => listener(event as TranscribeProgress))
  }
}
const clients = new WeakMap<ValleyPluginApi, ReturnType<typeof services>>()
export function transcribeServices(api: ValleyPluginApi): ReturnType<typeof services> {
  let client = clients.get(api)
  if (!client) { client = services(api); clients.set(api, client) }
  return client
}
