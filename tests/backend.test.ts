import de from '../locales/de.json'
import { describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { PluginAccountConnection } from '@valley/plugin-sdk/pluginNetwork'
import { register } from '../src/backend'
import models from '../src/backend/models.json'

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
const result = { language: 'german', segments: [{ start: 0.25, end: 2, text: ' Guten Tag. ' }] }
function setup(accounts: PluginAccountConnection[] = []) {
  const handlers = new Map<string, (payload: unknown) => unknown>()
  const emit = vi.fn()
  const run = vi.fn(async () => ({ exitCode: 0, outputs: [{ handle: 'output', name: 'audio.json', size: 100 }] }))
  const download = vi.fn(async () => ({ handle: 'weights', name: 'small.pt', size: 100, sha256: models.small.sha256 }))
  const cached = vi.fn(async () => null)
  const fetch = vi.fn(async () => ({ status: 200, headers: {}, bodyBase64: encoded(result) }))
  const authorize = vi.fn(async () => 'opaque-key')
  const release = vi.fn(async () => {})
  const api = {
    i18n: { t: (key: string) => key },
    rpc: { handle: (name: string, handler: (payload: unknown) => unknown) => { handlers.set(name, handler); return () => { handlers.delete(name) } }, emit },
    native: { resolve: vi.fn(async ({ name }: { name: string }) => ({ handle: name, path: `/fixture/${name}` })), run, cancel: vi.fn(async () => true), onOutput: vi.fn(() => () => {}) },
    files: { openVault: vi.fn(async () => ({ handle: 'media', name: 'audio.mp3', size: 10, sha1: 'file-hash' })), cached, read: vi.fn(async () => ({ base64: encoded(result), done: true })), release },
    network: { download, fetch, cancel: vi.fn(async () => true), onProgress: vi.fn(() => () => {}) },
    accounts: { list: async () => accounts, authorize }, settings: { get: () => ({}) }
  }
  const dispose = register(api as unknown as PluginBackendApi)
  return { ...api, call: async (method: string, payload: unknown) => await handlers.get(method)!(payload), dispose }
}

describe('Transcribe package backend', () => {
  it('downloads verified weights and invokes the granted native tool using file handles', async () => {
    const mock = setup()
    expect(await mock.call('file', { file: 'Media/audio.mp3', model: 'small', language: 'de', jobId: 'local-job' })).toMatchObject({ ok: true, data: [{ id: 'file-hash:0', start: 0.25, end: 2, text: 'Guten Tag.', language: 'de', model: 'small' }] })
    expect(mock.network.download).toHaveBeenCalledWith(expect.objectContaining({ sha256: models.small.sha256, url: models.small.url }))
    expect(mock.native.run).toHaveBeenCalledWith(expect.objectContaining({ executable: 'whisper', tools: ['ffmpeg'], args: [{ input: 'media' }, '--model', { input: 'weights' }, '--output_format', 'json', '--output_dir', { outputDirectory: true }, '--fp16', 'False', '--verbose', 'False', '--language', 'de'] }))
    expect(mock.files.release).toHaveBeenCalledWith(['media', 'output'])
    expect(mock.rpc.emit).toHaveBeenLastCalledWith('progress', { jobId: 'local-job', stage: 'done', percent: 100 })
    await mock.call('file', { file: 'Media/second.mp3', model: 'small', jobId: 'second-job' })
    expect(mock.network.download).toHaveBeenCalledTimes(1)
    mock.dispose()
  })

  it('uses the selected account endpoint and opaque multipart authorization for OpenAI', async () => {
    const mock = setup([{ id: 'field', provider: 'openai', baseUrl: 'https://proxy.example.test/v1', capabilities: ['ai.transcribe'], credentialState: 'ok' }])
    const response = await mock.call('file', { file: 'Media/audio.mp3', engine: 'openai', connectionId: 'field', language: 'de', jobId: 'cloud-job' })
    expect(response).toMatchObject({ ok: true, data: [{ model: 'whisper-1', start: 0.25, end: 2, text: 'Guten Tag.' }] })
    expect(mock.accounts.authorize).toHaveBeenCalledWith('field', 'ai.transcribe', { host: 'proxy.example.test', port: 443, security: 'tls' })
    expect(mock.network.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://proxy.example.test/v1/audio/transcriptions', credential: { handle: 'opaque-key', placement: 'header', name: 'Authorization', prefix: 'Bearer ' }, multipart: { fields: { model: 'whisper-1', response_format: 'verbose_json', 'timestamp_granularities[]': 'segment', language: 'de' }, files: [{ name: 'file', handle: 'media' }] } }))
    expect(mock.native.run).not.toHaveBeenCalled()
    expect(JSON.stringify(response)).not.toContain('opaque-key')
    mock.dispose()
  })

  it('fails a missing cloud connection without running the local engine', async () => {
    const mock = setup()
    expect(await mock.call('file', { file: 'Media/audio.mp3', engine: 'openai', connectionId: 'missing' })).toMatchObject({ ok: false, error: expect.stringContaining('Choose a configured OpenAI') })
    expect(mock.native.run).not.toHaveBeenCalled()
    expect(mock.network.fetch).not.toHaveBeenCalled()
    expect(mock.files.release).toHaveBeenCalledWith(['media'])
    mock.dispose()
  })

  it('preserves cloud errors and cancels requests without invoking Whisper', async () => {
    const accounts: PluginAccountConnection[] = [{ id: 'cloud', provider: 'openai', capabilities: ['ai.transcribe'], credentialState: 'ok' }]
    const mock = setup(accounts)
    mock.network.fetch.mockResolvedValueOnce({ status: 400, headers: {}, bodyBase64: encoded({ error: { message: 'Unsupported media format.' } }) })
    expect(await mock.call('file', { file: 'Media/error.mp3', engine: 'openai', jobId: 'error' })).toMatchObject({ ok: false, error: 'Unsupported media format.' })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let rejectFetch!: (reason: Error) => void
    mock.network.fetch.mockImplementationOnce(async () => { entered(); return new Promise((_resolve, reject) => { rejectFetch = reject }) })
    mock.network.cancel.mockImplementationOnce(async () => { rejectFetch(new Error('Cancelled')); return true })
    const running = mock.call('file', { file: 'Media/cancel.mp3', engine: 'openai', jobId: 'cancel' })
    await started
    expect(await mock.call('cancel', { jobId: 'cancel' })).toEqual({ ok: true, data: { cancelled: true } })
    expect(await running).toMatchObject({ ok: false, error: 'Transcription cancelled.' })
    expect(mock.network.cancel).toHaveBeenCalledWith('transcription:cancel')
    expect(mock.native.run).not.toHaveBeenCalled()
    mock.dispose()
  })

  it('validates model and engine before opening a file', async () => {
    const mock = setup()
    for (const input of [{ model: 'unlisted' }, { engine: 'unknown' }]) expect(await mock.call('file', { file: 'Media/audio.mp3', ...input })).toMatchObject({ ok: false })
    expect(mock.files.openVault).not.toHaveBeenCalled()
    mock.dispose()
  })
})

  it('uses the package locale for backend errors and follows language changes', async () => {
    const mock = setup([])
    mock.i18n.t = (key: string) => (de as Record<string, string>)[key] ?? key
    expect(await mock.call('file', { file: '' })).toMatchObject({ ok: false, error: de['backend.file'] })
    mock.i18n.t = (key: string) => key
    expect((await mock.call('file', { file: '' }) as { error: string }).error).not.toBe(de['backend.file'])
    mock.dispose()
  })
