import de from '../locales/de.json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { PluginAccountConnection } from '@valley/plugin-sdk/pluginNetwork'
import type { PluginDownloadRequest, PluginNetworkProgress } from '@valley/plugin-sdk/pluginNetwork'
import { register } from '../src/backend'
import models from '../src/backend/models.json'

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
const result = { language: 'german', segments: [{ start: 0.25, end: 2, text: ' Guten Tag. ' }] }
function setup(accounts: PluginAccountConnection[] = []) {
  const handlers = new Map<string, (payload: unknown) => unknown>()
  const operations = new Map<string, (payload: unknown, context: PluginBackendOperationContext) => unknown>()
  const emit = vi.fn()
  const run = vi.fn(async () => ({ exitCode: 0, outputs: [{ handle: 'output', name: 'audio.json', size: 100 }] }))
  const download = vi.fn(async (_request: PluginDownloadRequest) => ({ handle: 'weights', name: 'small.pt', size: 100, sha256: models.small.sha256 }))
  const cached = vi.fn(async () => null)
  const fetch = vi.fn(async () => ({ status: 200, headers: {}, bodyBase64: encoded(result) }))
  const authorize = vi.fn(async () => 'opaque-key')
  const release = vi.fn<(handles: string[]) => Promise<void>>(async () => {})
  const api = {
    i18n: { t: (key: string) => key },
    rpc: {
      handle: (name: string, handler: (payload: unknown) => unknown) => { handlers.set(name, handler); return () => { handlers.delete(name) } },
      handleOperation: (name: string, handler: (payload: unknown, context: PluginBackendOperationContext) => unknown) => { operations.set(name, handler); return () => { operations.delete(name) } },
      emit
    },
    native: { resolve: vi.fn(async ({ name }: { name: string }) => ({ handle: name, path: `/fixture/${name}` })), run, cancel: vi.fn(async () => true), onOutput: vi.fn((_listener: Parameters<PluginBackendApi['native']['onOutput']>[0]) => () => {}) },
    files: { openVault: vi.fn(async () => ({ handle: 'media', name: 'audio.mp3', size: 10, sha1: 'file-hash' })), cached, read: vi.fn(async () => ({ base64: encoded(result), done: true })), release },
    network: { download, fetch, cancel: vi.fn(async (_requestId: string) => true), onProgress: vi.fn((_listener: (progress: PluginNetworkProgress) => void) => () => {}) },
    accounts: { list: async () => accounts, authorize }, settings: { get: () => ({}) }
  }
  const dispose = register(api as unknown as PluginBackendApi)
  const scope = (owner = api, controller = new AbortController()): PluginBackendOperationContext => ({ id: `operation:${Math.random()}`, api: owner as unknown as PluginBackendOperationContext['api'], cancellation: controller.signal })
  return { ...api, handlers, operations, scope, call: async (method: string, payload: unknown, context = scope()) => await (operations.has(method) ? operations.get(method)!(payload, context) : handlers.get(method)!(payload)), dispose }
}

afterEach(() => vi.useRealTimers())

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Transcribe package backend', () => {
  it('coalesces native progress per job while retaining each latest value and immediate completion', async () => {
    vi.useFakeTimers()
    const mock = setup()
    const native = held<Awaited<ReturnType<typeof mock.native.run>>>()
    mock.native.run.mockImplementation(() => native.promise)
    const first = mock.call('file', { file: 'first.mp3', jobId: 'first' })
    const second = mock.call('file', { file: 'second.mp3', jobId: 'second' })
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.native.run).toHaveBeenCalledTimes(2)
    const output = mock.native.onOutput.mock.calls[0][0]
    const progress = (jobId: string, percent: number) => output({ jobId, stream: 'stderr', base64: Buffer.from(`${percent}%| 50/100 [00:01<00:02, 50frames/s]`).toString('base64') })
    mock.rpc.emit.mockClear()
    for (let i = 1; i <= 999; i++) progress('first', i % 100)
    progress('second', 44)
    await vi.advanceTimersByTimeAsync(49)
    expect(mock.rpc.emit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mock.rpc.emit.mock.calls).toEqual([
      ['progress', { jobId: 'first', stage: 'decode', percent: 99, remainingMs: 2000 }],
      ['progress', { jobId: 'second', stage: 'decode', percent: 44, remainingMs: 2000 }]
    ])
    progress('first', 100)
    native.resolve({ exitCode: 0, outputs: [{ handle: 'output', name: 'audio.json', size: 100 }] })
    expect(await first).toMatchObject({ ok: true })
    expect(await second).toMatchObject({ ok: true })
    expect(mock.rpc.emit.mock.calls.slice(2)).toEqual([
      ['progress', { jobId: 'first', stage: 'done', percent: 100 }],
      ['progress', { jobId: 'second', stage: 'done', percent: 100 }]
    ])
    await mock.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mock.rpc.emit).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes cloud stage changes immediately and drops obsolete queued upload progress', async () => {
    vi.useFakeTimers()
    const mock = setup([{ id: 'cloud', provider: 'openai', capabilities: ['ai.transcribe'], credentialState: 'ok' }])
    const response = held<Awaited<ReturnType<typeof mock.network.fetch>>>()
    mock.network.fetch.mockImplementation(() => response.promise)
    const running = mock.call('file', { file: 'cloud.mp3', jobId: 'cloud', engine: 'openai' })
    await vi.advanceTimersByTimeAsync(0)
    mock.rpc.emit.mockClear()
    for (let bytes = 1; bytes <= 100; bytes++) {
      for (const [listener] of mock.network.onProgress.mock.calls) listener({ requestId: 'transcription:cloud', phase: 'upload', bytes, total: 100 })
    }
    expect(mock.rpc.emit.mock.calls).toEqual([['progress', { jobId: 'cloud', stage: 'request' }]])
    await vi.advanceTimersByTimeAsync(100)
    expect(mock.rpc.emit).toHaveBeenCalledOnce()
    response.resolve({ status: 200, headers: {}, bodyBase64: encoded(result) })
    expect(await running).toMatchObject({ ok: true })
    expect(mock.rpc.emit).toHaveBeenLastCalledWith('progress', { jobId: 'cloud', stage: 'done', percent: 100 })
    await mock.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears pending progress on cancellation without reporting completion before physical work ends', async () => {
    vi.useFakeTimers()
    const mock = setup()
    const native = held<Awaited<ReturnType<typeof mock.native.run>>>()
    mock.native.run.mockImplementation(() => native.promise)
    const controller = new AbortController()
    const running = mock.call('file', { file: 'first.mp3', jobId: 'first' }, mock.scope(mock, controller))
    await vi.advanceTimersByTimeAsync(0)
    mock.rpc.emit.mockClear()
    const progress = () => mock.native.onOutput.mock.calls[0][0]({ jobId: 'first', stream: 'stderr', base64: Buffer.from('50%| 50/100 [00:01<00:02, 50frames/s]').toString('base64') })
    progress()
    controller.abort()
    progress()
    await vi.advanceTimersByTimeAsync(150_000)
    expect(mock.rpc.emit).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    native.resolve({ exitCode: 0, outputs: [{ handle: 'output', name: 'audio.json', size: 100 }] })
    expect(await running).toMatchObject({ ok: false, error: 'Transcription cancelled.' })
    expect(mock.rpc.emit).toHaveBeenCalledOnce()
    expect(mock.rpc.emit).toHaveBeenCalledWith('progress', expect.objectContaining({ jobId: 'first', stage: 'cancelled' }))
    await mock.dispose()
  })

  it('shares a model download while cancelling one waiter leaves its peer and progress alive', async () => {
    vi.useFakeTimers()
    const mock = setup()
    const weights = held<Awaited<ReturnType<typeof mock.network.download>>>()
    mock.network.download.mockImplementation(() => weights.promise)
    const firstController = new AbortController()
    const first = mock.call('file', { file: 'first.mp3', jobId: 'first' }, mock.scope(mock, firstController))
    let secondFinished = false
    const second = mock.call('file', { file: 'second.mp3', jobId: 'second' }).then(value => { secondFinished = true; return value })
    await vi.waitFor(() => expect(mock.network.download).toHaveBeenCalledOnce())
    expect(mock.files.cached).toHaveBeenCalledOnce()
    const requestId = mock.network.download.mock.calls[0][0].requestId
    for (const [listener] of mock.network.onProgress.mock.calls) listener({ requestId, phase: 'download', bytes: 5, total: 10 })
    await vi.advanceTimersByTimeAsync(50)
    expect(mock.rpc.emit).toHaveBeenCalledWith('progress', { jobId: 'first', stage: 'download', percent: 50 })
    expect(mock.rpc.emit).toHaveBeenCalledWith('progress', { jobId: 'second', stage: 'download', percent: 50 })
    firstController.abort()
    expect(await first).toMatchObject({ ok: false, error: 'Transcription cancelled.' })
    expect(secondFinished).toBe(false)
    expect(mock.network.cancel).not.toHaveBeenCalledWith(requestId)
    expect(mock.files.release.mock.calls.flat(2)).not.toContain('weights')
    mock.rpc.emit.mockClear()
    for (const [listener] of mock.network.onProgress.mock.calls) listener({ requestId, phase: 'download', bytes: 7, total: 10 })
    await vi.advanceTimersByTimeAsync(50)
    expect(mock.rpc.emit.mock.calls).toEqual([['progress', { jobId: 'second', stage: 'download', percent: 70 }]])
    weights.resolve({ handle: 'weights', name: 'small.pt', size: 100, sha256: models.small.sha256 })
    expect(await second).toMatchObject({ ok: true })
    expect(mock.native.run).toHaveBeenCalledOnce()
    await mock.dispose()
    expect(mock.files.release.mock.calls.filter(([handles]) => handles.includes('weights'))).toEqual([[['weights']]])
  })

  it('cancels the last model waiter and joins physical download cleanup before disposal', async () => {
    vi.useFakeTimers()
    const mock = setup()
    const weights = held<Awaited<ReturnType<typeof mock.network.download>>>()
    const physical = held<void>()
    const released = held<void>()
    mock.network.download.mockImplementation(() => weights.promise)
    mock.network.cancel.mockImplementation(async (requestId?: string) => {
      if (requestId?.startsWith('model:')) {
        await physical.promise
        weights.resolve({ handle: 'weights', name: 'small.pt', size: 100, sha256: models.small.sha256 })
      }
      return true
    })
    mock.files.release.mockImplementation(async handles => { if (handles.includes('weights')) await released.promise })
    let finished = false, disposed = false
    const running = mock.call('file', { file: 'held.mp3', jobId: 'held' }).then(value => { finished = true; return value })
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.network.download).toHaveBeenCalledOnce()
    const disposal = mock.dispose().then(() => { disposed = true })
    await vi.advanceTimersByTimeAsync(150_000)
    expect(finished).toBe(false)
    expect(disposed).toBe(false)
    physical.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.files.release).toHaveBeenCalledWith(['weights'])
    expect(finished).toBe(false)
    expect(disposed).toBe(false)
    released.resolve()
    expect(await running).toMatchObject({ ok: false, error: 'Transcription cancelled.' })
    await disposal
    expect(mock.network.cancel.mock.calls.filter(([id]) => String(id).startsWith('model:'))).toHaveLength(1)
    expect(mock.native.run).not.toHaveBeenCalled()
  })

  it('evicts a failed shared download so a later request can fetch the same verified model', async () => {
    const mock = setup()
    mock.network.download.mockRejectedValueOnce(new Error('Download unavailable'))
    const first = mock.call('file', { file: 'first.mp3', jobId: 'first' })
    const second = mock.call('file', { file: 'second.mp3', jobId: 'second' })
    expect(await first).toMatchObject({ ok: false, error: 'Download unavailable' })
    expect(await second).toMatchObject({ ok: false, error: 'Download unavailable' })
    expect(mock.network.download).toHaveBeenCalledOnce()
    expect(await mock.call('file', { file: 'retry.mp3', jobId: 'retry' })).toMatchObject({ ok: true })
    expect(mock.network.download).toHaveBeenCalledTimes(2)
    await mock.dispose()
  })

  it('does not begin a model download when disposal occurs during its cache lookup', async () => {
    const mock = setup()
    const cache = held<null>()
    mock.files.cached.mockImplementation(() => cache.promise)
    const running = mock.call('file', { file: 'held.mp3', jobId: 'held' })
    await vi.waitFor(() => expect(mock.files.cached).toHaveBeenCalledOnce())
    let disposed = false
    const disposal = mock.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    cache.resolve(null)
    expect(await running).toMatchObject({ ok: false })
    await disposal
    expect(mock.network.download).not.toHaveBeenCalled()
    expect(mock.native.run).not.toHaveBeenCalled()
  })

  it('reports a synchronous cache failure to every caller without retaining a dead waiter', async () => {
    const mock = setup()
    mock.files.cached.mockImplementationOnce(() => { throw new Error('Cache unavailable') })
    expect(await mock.call('file', { file: 'first.mp3', jobId: 'first' })).toMatchObject({ ok: false, error: 'Cache unavailable' })
    expect(await mock.call('file', { file: 'retry.mp3', jobId: 'retry' })).toMatchObject({ ok: true })
    expect(mock.network.download).toHaveBeenCalledOnce()
    await mock.dispose()
  })

  it.each(['local', 'openai'] as const)('retains a %s operation for 150 seconds and uses its captured API', async (engine) => {
    vi.useFakeTimers()
    const mock = setup([{ id: 'cloud', provider: 'openai', capabilities: ['ai.transcribe'], credentialState: 'ok' }])
    const native = held<Awaited<ReturnType<typeof mock.native.run>>>()
    const cloud = held<Awaited<ReturnType<typeof mock.network.fetch>>>()
    const owner = {
      ...mock,
      files: { ...mock.files, openVault: vi.fn(mock.files.openVault.getMockImplementation()!), release: vi.fn(async () => {}) },
      native: { ...mock.native, run: vi.fn(() => native.promise) },
      network: { ...mock.network, fetch: vi.fn(() => cloud.promise) }
    }
    let settled = false
    const running = mock.call('file', { file: 'Media/audio.mp3', engine, jobId: 'held' }, mock.scope(owner)).then((value) => { settled = true; return value })
    await vi.advanceTimersByTimeAsync(150_000)
    expect(settled).toBe(false)
    expect(mock.handlers.has('file')).toBe(false)
    expect(mock.handlers.has('cancel')).toBe(false)
    expect(mock.files.openVault).not.toHaveBeenCalled()
    expect(mock.native.run).not.toHaveBeenCalled()
    expect(mock.network.fetch).not.toHaveBeenCalled()
    if (engine === 'local') native.resolve({ exitCode: 0, outputs: [{ handle: 'output', name: 'audio.json', size: 100 }] })
    else cloud.resolve({ status: 200, headers: {}, bodyBase64: encoded(result) })
    expect(await running).toMatchObject({ ok: true, data: [{ text: 'Guten Tag.' }] })
    expect(owner.files.release).toHaveBeenCalledWith(engine === 'local' ? ['media', 'output'] : ['media'])
    await mock.dispose()
  })

  it.each(['local', 'openai'] as const)('waits for physical %s completion and handle release after cancellation and repeated disposal', async (engine) => {
    vi.useFakeTimers()
    const mock = setup([{ id: 'cloud', provider: 'openai', capabilities: ['ai.transcribe'], credentialState: 'ok' }])
    const native = held<Awaited<ReturnType<typeof mock.native.run>>>()
    const cloud = held<Awaited<ReturnType<typeof mock.network.fetch>>>()
    const closed = held<void>()
    const released = held<void>()
    mock.native.run.mockImplementation(() => native.promise)
    mock.network.fetch.mockImplementation(() => cloud.promise)
    mock.files.release.mockImplementation(async (handles: string[]) => { if (handles.includes('media')) await released.promise })
    const cancelPhysical = async () => {
      await closed.promise
      native.resolve({ exitCode: 0, outputs: [] })
      cloud.resolve({ status: 200, headers: {}, bodyBase64: encoded(result) })
      return true
    }
    if (engine === 'local') mock.native.cancel.mockImplementation(cancelPhysical)
    else mock.network.cancel.mockImplementation(cancelPhysical)
    const controller = new AbortController()
    let settled = false
    const running = mock.call('file', { file: 'Media/audio.mp3', engine, jobId: 'closing' }, mock.scope(mock, controller)).then((value) => { settled = true; return value })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    const disposal = mock.dispose()
    expect(mock.dispose()).toBe(disposal)
    let disposed = false
    void disposal.then(() => { disposed = true })
    await vi.advanceTimersByTimeAsync(150_000)
    expect(settled).toBe(false)
    expect(disposed).toBe(false)
    expect(mock.files.release).not.toHaveBeenCalled()
    expect(mock.rpc.emit.mock.calls.some(([, event]) => ['done', 'cancelled', 'error'].includes(event.stage))).toBe(false)
    closed.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.files.release).toHaveBeenCalledWith(['media'])
    expect(settled).toBe(false)
    expect(disposed).toBe(false)
    released.resolve()
    expect(await running).toMatchObject({ ok: false, error: 'Transcription cancelled.' })
    await disposal
    expect(mock.native.cancel).toHaveBeenCalledTimes(1)
    expect(mock.network.cancel).toHaveBeenCalledTimes(1)
  })

  it('admits at most four jobs and recovers capacity only after their resource release', async () => {
    const mock = setup()
    const outputs = held<Awaited<ReturnType<typeof mock.native.run>>>()
    const released = held<void>()
    mock.native.run.mockImplementation(() => outputs.promise)
    mock.files.release.mockImplementation(async (handles) => { if (handles.includes('media')) await released.promise })
    const runs = Array.from({ length: 4 }, (_, index) => mock.call('file', { file: `${index}.mp3`, jobId: `job-${index}` }))
    expect(await mock.call('file', { file: 'overflow.mp3', jobId: 'overflow' })).toMatchObject({ ok: false, error: expect.stringContaining('Four transcriptions') })
    expect(mock.files.openVault).toHaveBeenCalledTimes(4)
    outputs.resolve({ exitCode: 0, outputs: [{ handle: 'output', name: 'audio.json', size: 100 }] })
    await vi.waitFor(() => expect(mock.files.release).toHaveBeenCalledTimes(4))
    expect(await mock.call('file', { file: 'still-full.mp3', jobId: 'still-full' })).toMatchObject({ ok: false })
    released.resolve()
    expect((await Promise.all(runs)).every((value) => (value as { ok: boolean }).ok)).toBe(true)
    expect(await mock.call('file', { file: 'later.mp3', jobId: 'later' })).toMatchObject({ ok: true })
    await mock.dispose()
  })

  it('downloads verified weights and invokes the granted native tool using file handles', async () => {
    const mock = setup()
    expect(await mock.call('file', { file: 'Media/audio.mp3', model: 'small', language: 'de', jobId: 'local-job' })).toMatchObject({ ok: true, data: [{ id: 'file-hash:0', start: 0.25, end: 2, text: 'Guten Tag.', language: 'de', model: 'small' }] })
    expect(mock.network.download).toHaveBeenCalledWith(expect.objectContaining({ sha256: models.small.sha256, url: models.small.url }))
    expect(mock.native.run).toHaveBeenCalledWith(expect.objectContaining({ executable: 'whisper', tools: ['ffmpeg'], args: [{ input: 'media' }, '--model', { input: 'weights' }, '--output_format', 'json', '--output_dir', { outputDirectory: true }, '--fp16', 'False', '--verbose', 'False', '--language', 'de'] }))
    expect(mock.files.release).toHaveBeenCalledWith(['media', 'output'])
    expect(mock.rpc.emit).toHaveBeenLastCalledWith('progress', { jobId: 'local-job', stage: 'done', percent: 100 })
    await mock.call('file', { file: 'Media/second.mp3', model: 'small', jobId: 'second-job' })
    expect(mock.network.download).toHaveBeenCalledTimes(1)
    await mock.dispose()
  })

  it('uses the selected account endpoint and opaque multipart authorization for OpenAI', async () => {
    const mock = setup([{ id: 'field', provider: 'openai', baseUrl: 'https://proxy.example.test/v1', capabilities: ['ai.transcribe'], credentialState: 'ok' }])
    const response = await mock.call('file', { file: 'Media/audio.mp3', engine: 'openai', connectionId: 'field', language: 'de', jobId: 'cloud-job' })
    expect(response).toMatchObject({ ok: true, data: [{ model: 'whisper-1', start: 0.25, end: 2, text: 'Guten Tag.' }] })
    expect(mock.accounts.authorize).toHaveBeenCalledWith('field', 'ai.transcribe', { host: 'proxy.example.test', port: 443, security: 'tls' })
    expect(mock.network.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://proxy.example.test/v1/audio/transcriptions', credential: { handle: 'opaque-key', placement: 'header', name: 'Authorization', prefix: 'Bearer ' }, multipart: { fields: { model: 'whisper-1', response_format: 'verbose_json', 'timestamp_granularities[]': 'segment', language: 'de' }, files: [{ name: 'file', handle: 'media' }] } }))
    expect(mock.native.run).not.toHaveBeenCalled()
    expect(JSON.stringify(response)).not.toContain('opaque-key')
    await mock.dispose()
  })

  it('fails a missing cloud connection without running the local engine', async () => {
    const mock = setup()
    expect(await mock.call('file', { file: 'Media/audio.mp3', engine: 'openai', connectionId: 'missing' })).toMatchObject({ ok: false, error: expect.stringContaining('Choose a configured OpenAI') })
    expect(mock.native.run).not.toHaveBeenCalled()
    expect(mock.network.fetch).not.toHaveBeenCalled()
    expect(mock.files.release).toHaveBeenCalledWith(['media'])
    await mock.dispose()
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
    await mock.dispose()
  })

  it('validates model and engine before opening a file', async () => {
    const mock = setup()
    for (const input of [{ model: 'unlisted' }, { engine: 'unknown' }]) expect(await mock.call('file', { file: 'Media/audio.mp3', ...input })).toMatchObject({ ok: false })
    expect(mock.files.openVault).not.toHaveBeenCalled()
    await mock.dispose()
  })
})

  it('uses the package locale for backend errors and follows language changes', async () => {
    const mock = setup([])
    mock.i18n.t = (key: string) => (de as Record<string, string>)[key] ?? key
    expect(await mock.call('file', { file: '' })).toMatchObject({ ok: false, error: de['backend.file'] })
    mock.i18n.t = (key: string) => key
    expect((await mock.call('file', { file: '' }) as { error: string }).error).not.toBe(de['backend.file'])
    await mock.dispose()
  })
