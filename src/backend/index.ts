import { uiText, initBackendLocalization } from '../localization'
import type { PluginBackendApi, PluginBackendOperationContext } from '@valley/plugin-sdk'
import type { PluginNativeArgument } from '@valley/plugin-sdk/pluginNative'
import type { PluginFileHandle } from '@valley/plugin-sdk/pluginNative'
import type { TranscribeProgress } from '../serviceClient'
import { MODEL_OPTIONS, DEFAULT_MODEL } from '../models'
import { normalizeWhisperLanguage } from './languages'
import { parseDecodeProgress, parseDownloadPercent, segmentsFromWhisperJson, type WhisperJson } from './parsers'
import models from './models.json'
import { createModelCache } from './modelCache'

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(uiText('backend.request'))
  return value as Record<string, unknown>
}
const text = (value: unknown, fallback = '') => {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error(uiText('backend.text'))
  return value.trim()
}
const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)))

export function register(api: PluginBackendApi): () => Promise<void> {
  initBackendLocalization(api)
  type Progress = Omit<TranscribeProgress, 'jobId'>
  type Job = { cancelled: boolean; requestId: string; api: PluginBackendOperationContext['api']; done: Promise<void>; cancelling?: Promise<void>; model?: ReturnType<ReturnType<typeof createModelCache>['acquire']>; progress?: Progress; queuedProgress?: Progress; progressTimer?: ReturnType<typeof setTimeout>; progressAt?: number }
  const jobs = new Map<string, Job>()
  let closing = false
  let disposal: Promise<void> | undefined
  const modelCache = createModelCache(api, models)
  const clearProgress = (job: Job) => {
    clearTimeout(job.progressTimer)
    job.progressTimer = undefined
    job.queuedProgress = undefined
  }
  const publishProgress = (jobId: string, job: Job, progress: Progress) => {
    clearProgress(job)
    job.progress = progress
    job.progressAt = Date.now()
    job.api.rpc.emit('progress', { jobId, ...progress })
  }
  const report = (jobId: string, progress: Progress) => {
    const job = jobs.get(jobId)
    if (!job) return
    const terminal = ['done', 'error', 'cancelled'].includes(progress.stage)
    if (job.cancelled && !terminal) return
    if (terminal || job.progress?.stage !== progress.stage || Date.now() - (job.progressAt ?? 0) >= 50) {
      publishProgress(jobId, job, progress)
      return
    }
    job.queuedProgress = progress
    job.progressTimer ??= setTimeout(() => {
      const queued = job.queuedProgress
      if (jobs.get(jobId) === job && !job.cancelled && queued) publishProgress(jobId, job, queued)
      else clearProgress(job)
    }, Math.max(0, 50 - (Date.now() - (job.progressAt ?? 0))))
  }
  const offOutput = api.native.onOutput(({ jobId, stream, base64 }) => {
    if (stream !== 'stderr' || !jobs.has(jobId)) return
    const chunk = decode(base64)
    const download = parseDownloadPercent(chunk)
    if (download !== null) report(jobId, { stage: 'download', percent: download })
    const progress = parseDecodeProgress(chunk)
    if (progress) report(jobId, { stage: 'decode', ...progress })
  })
  const offNetwork = api.network.onProgress(({ requestId, phase, bytes, total }) => {
    const job = [...jobs].find(([, current]) => current.requestId === requestId)
    if (job) {
      report(job[0], { stage: phase === 'download' ? 'download' : 'upload', ...(total ? { percent: Math.min(100, bytes / total * 100) } : {}) })
      if (phase === 'upload' && total && bytes >= total) report(job[0], { stage: 'request' })
    }
  })
  const readJson = async (owner: PluginBackendOperationContext['api'], file: PluginFileHandle): Promise<WhisperJson> => {
    if (file.size > 32 * 1024 * 1024) throw new Error(uiText('backend.large'))
    let value = ''
    let offset = 0
    const decoder = new TextDecoder()
    for (;;) {
      const result = await owner.files.read(file.handle, { offset, maxBytes: 1024 * 1024 })
      const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0))
      offset += bytes.byteLength
      value += decoder.decode(bytes, { stream: !result.done })
      if (result.done) break
      if (!bytes.length) throw new Error(uiText('backend.read'))
    }
    return object(JSON.parse(value)) as WhisperJson
  }
  const cancel = async (jobId: string): Promise<boolean> => {
    const job = jobs.get(jobId)
    if (!job) return false
    job.cancelled = true
    clearProgress(job)
    job.cancelling ??= Promise.allSettled([job.api.native.cancel(jobId), job.api.network.cancel(job.requestId), job.model?.cancel()]).then(async (results) => {
      await job.done
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })
    await job.cancelling
    return true
  }
  const handlers: Array<() => void> = []
  const handle = (name: string, handler: (payload: Record<string, unknown>) => unknown | Promise<unknown>) => {
    handlers.push(api.rpc.handle(name, async (value) => {
      try { return { ok: true, data: await handler(object(value ?? {})) } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }))
  }
  const handleOperation = (name: string, handler: (payload: Record<string, unknown>, context: PluginBackendOperationContext) => unknown | Promise<unknown>) => {
    handlers.push(api.rpc.handleOperation(name, async (value, context) => {
      try {
        if (closing) throw new Error(uiText('backend.cancelled'))
        return { ok: true, data: await handler(object(value ?? {}), context) }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }))
  }
  handleOperation('cancel', async ({ jobId }) => ({ cancelled: await cancel(text(jobId)) }))
  handle('listConnections', async () => ({ connections: (await api.accounts.list()).filter((account) => account.provider === 'openai' && account.capabilities.includes('ai.transcribe')).map((account) => ({ id: account.id, provider: account.provider, providerName: 'OpenAI', label: account.displayName ?? '', configured: account.credentialState === 'ok' })) }))
  const resolveWhisper = async (owner: PluginBackendOperationContext['api'], executablePath?: string) => {
    const resolved = await owner.native.resolve({ name: 'whisper', executablePath })
    const framework = resolved?.interpreterPath?.match(/^(.*\/Python\.framework\/Versions\/[^/]+)\/bin\/python[^/]*$/)
    return resolved && framework ? await owner.native.resolve({ name: 'whisper', executablePath: resolved.path, interpreterPath: `${framework[1]}/Resources/Python.app/Contents/MacOS/Python` }) : resolved
  }
  handle('status', async ({ binPath }) => {
    const [executable, ffmpeg] = await Promise.all([resolveWhisper(api, text(binPath) || undefined), api.native.resolve({ name: 'ffmpeg' })])
    return { available: executable !== null, binPath: executable?.path ?? null, ffmpeg: ffmpeg !== null }
  })
  handleOperation('file', async (payload, context) => {
    const owner = context.api
    const file = text(payload.file)
    if (!file) throw new Error(uiText('backend.file'))
    const jobId = text(payload.jobId, file)
    if (!jobId || jobs.has(jobId)) throw new Error(uiText('backend.running'))
    if (jobs.size >= 4) throw new Error(uiText('backend.capacity'))
    const settings = owner.settings.get()
    const engine = text(payload.engine, 'local')
    if (engine !== 'local' && engine !== 'openai') throw new Error(uiText('backend.engine'))
    const language = normalizeWhisperLanguage(text(payload.language))
    const model = text(payload.model, DEFAULT_MODEL)
    if (!MODEL_OPTIONS.some((option) => option.value === model)) throw new Error(uiText('backend.model'))
    let finished!: () => void
    const job: Job = { cancelled: context.cancellation.aborted, requestId: `transcription:${jobId}`, api: owner, done: new Promise<void>((resolve) => { finished = resolve }) }
    jobs.set(jobId, job)
    const aborted = (): void => { void cancel(jobId).catch(() => {}) }
    context.cancellation.addEventListener('abort', aborted, { once: true })
    const handles: string[] = []
    const started = Date.now()
    let terminal: Omit<TranscribeProgress, 'jobId'> | undefined
    const ensureActive = () => { if (job.cancelled) throw new Error(uiText('backend.cancelled')) }
    try {
      ensureActive()
      report(jobId, { stage: 'start' })
      const input = await owner.files.openVault(file)
      handles.push(input.handle)
      let result: WhisperJson
      let outputModel = model
      if (engine === 'local') {
        const [executable, ffmpeg] = await Promise.all([resolveWhisper(owner, text(settings.whisperPath) || undefined), owner.native.resolve({ name: 'ffmpeg' })])
        if (!executable || !ffmpeg) throw new Error(uiText('backend.tools'))
        ensureActive()
        job.model = modelCache.acquire(model, percent => report(jobId, { stage: 'download', percent }))
        const weights = await job.model.result
        ensureActive()
        const args: PluginNativeArgument[] = [{ input: input.handle }, '--model', { input: weights.handle }, '--output_format', 'json', '--output_dir', { outputDirectory: true }, '--fp16', 'False', '--verbose', 'False', ...(language ? ['--language', language] : [])]
        report(jobId, { stage: 'decode' })
        const output = await owner.native.run({ jobId, executable: executable.handle, tools: [ffmpeg.handle], args, environment: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' } })
        handles.push(...output.outputs.map((entry) => entry.handle))
        ensureActive()
        if (output.exitCode !== 0) throw new Error(uiText('backend.exit', { code: output.exitCode }))
        const transcript = output.outputs.find((entry) => entry.name.endsWith('.json'))
        if (!transcript) throw new Error(uiText('backend.empty'))
        result = await readJson(owner, transcript)
      } else {
        const connectionId = text(payload.connectionId)
        const connections = (await owner.accounts.list()).filter((account) => account.provider === 'openai' && account.capabilities.includes('ai.transcribe') && account.credentialState === 'ok')
        const connection = connectionId ? connections.find((account) => account.id === connectionId) : connections[0]
        if (!connection) throw new Error(uiText('backend.connection'))
        const url = new URL(`${(connection.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/audio/transcriptions`)
        const credential = await owner.accounts.authorize(connection.id, 'ai.transcribe', { host: url.hostname, port: Number(url.port || 443), security: 'tls' })
        ensureActive()
        report(jobId, { stage: 'upload', percent: 0 })
        const response = await owner.network.fetch({ requestId: job.requestId, url: url.toString(), method: 'POST', timeoutMs: 900000, credential: { handle: credential, placement: 'header', name: 'Authorization', prefix: 'Bearer ' }, multipart: { fields: { model: 'whisper-1', response_format: 'verbose_json', 'timestamp_granularities[]': 'segment', ...(language ? { language } : {}) }, files: [{ name: 'file', handle: input.handle }] } })
        ensureActive()
        const json = object(JSON.parse(decode(response.bodyBase64)))
        if (response.status < 200 || response.status >= 300) throw new Error(typeof (json.error as { message?: unknown } | undefined)?.message === 'string' ? String((json.error as { message: string }).message) : uiText('backend.openai', { status: response.status }))
        result = json as WhisperJson
        outputModel = 'whisper-1'
      }
      ensureActive()
      const segments = segmentsFromWhisperJson({ json: result, relPath: file, fileHash: input.sha1!, model: outputModel, requestedLanguage: language, createdAt: new Date().toISOString(), transcriptionDurationMs: Date.now() - started })
      terminal = { stage: 'done', percent: 100 }
      return segments
    } catch (error) {
      const message = job.cancelled ? uiText('backend.cancelled') : error instanceof Error ? error.message : uiText('backend.failed')
      terminal = { stage: job.cancelled ? 'cancelled' : 'error', message }
      throw new Error(message)
    } finally {
      try {
        const cleanup = await Promise.allSettled([job.model?.cancel(), handles.length ? owner.files.release(handles) : undefined])
        const failure = cleanup.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
        ensureActive()
      } catch (error) {
        terminal = { stage: job.cancelled ? 'cancelled' : 'error', message: error instanceof Error ? error.message : String(error) }
        throw error
      } finally {
        context.cancellation.removeEventListener('abort', aborted)
        try { if (terminal) report(jobId, terminal) }
        finally { clearProgress(job); jobs.delete(jobId); finished() }
      }
    }
  })
  return () => {
    if (disposal) return disposal
    closing = true
    for (const dispose of handlers) dispose()
    disposal = (async () => {
      const results = await Promise.allSettled([...jobs.keys()].map(cancel))
      offOutput()
      offNetwork()
      await modelCache.dispose()
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })()
    return disposal
  }
}
