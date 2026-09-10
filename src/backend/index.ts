import { uiText, initBackendLocalization } from '../localization'
import type { PluginBackendApi } from '@valley/plugin-sdk'
import type { PluginNativeArgument } from '@valley/plugin-sdk/pluginNative'
import type { PluginFileHandle } from '@valley/plugin-sdk/pluginNative'
import type { TranscribeProgress } from '../serviceClient'
import { MODEL_OPTIONS, DEFAULT_MODEL } from '../models'
import { normalizeWhisperLanguage } from './languages'
import { parseDecodeProgress, parseDownloadPercent, segmentsFromWhisperJson, type WhisperJson } from './parsers'
import models from './models.json'

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

export function register(api: PluginBackendApi): () => void {
  initBackendLocalization(api)
  const jobs = new Map<string, { cancelled: boolean; requestId: string }>()
  const modelFiles = new Map<string, PluginFileHandle>()
  const report = (jobId: string, progress: Omit<TranscribeProgress, 'jobId'>) => api.rpc.emit('progress', { jobId, ...progress })
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
  const readJson = async (file: PluginFileHandle): Promise<WhisperJson> => {
    if (file.size > 32 * 1024 * 1024) throw new Error(uiText('backend.large'))
    let value = ''
    let offset = 0
    const decoder = new TextDecoder()
    for (;;) {
      const result = await api.files.read(file.handle, { offset, maxBytes: 1024 * 1024 })
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
    await Promise.all([api.native.cancel(jobId), api.network.cancel(job.requestId)])
    return true
  }
  const handlers: Array<() => void> = []
  const handle = (name: string, handler: (payload: Record<string, unknown>) => unknown | Promise<unknown>) => {
    handlers.push(api.rpc.handle(name, async (value) => {
      try { return { ok: true, data: await handler(object(value ?? {})) } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    }))
  }
  handle('cancel', async ({ jobId }) => ({ cancelled: await cancel(text(jobId)) }))
  handle('listConnections', async () => ({ connections: (await api.accounts.list()).filter((account) => account.provider === 'openai' && account.capabilities.includes('ai.transcribe')).map((account) => ({ id: account.id, provider: account.provider, providerName: 'OpenAI', label: account.displayName ?? '', configured: account.credentialState === 'ok' })) }))
  const resolveWhisper = async (executablePath?: string) => {
    const resolved = await api.native.resolve({ name: 'whisper', executablePath })
    const framework = resolved?.interpreterPath?.match(/^(.*\/Python\.framework\/Versions\/[^/]+)\/bin\/python[^/]*$/)
    return resolved && framework ? await api.native.resolve({ name: 'whisper', executablePath: resolved.path, interpreterPath: `${framework[1]}/Resources/Python.app/Contents/MacOS/Python` }) : resolved
  }
  handle('status', async ({ binPath }) => {
    const [executable, ffmpeg] = await Promise.all([resolveWhisper(text(binPath) || undefined), api.native.resolve({ name: 'ffmpeg' })])
    return { available: executable !== null, binPath: executable?.path ?? null, ffmpeg: ffmpeg !== null }
  })
  handle('file', async (payload) => {
    const file = text(payload.file)
    if (!file) throw new Error(uiText('backend.file'))
    const jobId = text(payload.jobId, file)
    if (!jobId || jobs.has(jobId)) throw new Error(uiText('backend.running'))
    const settings = api.settings.get()
    const engine = text(payload.engine, 'local')
    if (engine !== 'local' && engine !== 'openai') throw new Error(uiText('backend.engine'))
    const language = normalizeWhisperLanguage(text(payload.language))
    const model = text(payload.model, DEFAULT_MODEL)
    if (!MODEL_OPTIONS.some((option) => option.value === model)) throw new Error(uiText('backend.model'))
    const job = { cancelled: false, requestId: `transcription:${jobId}` }
    jobs.set(jobId, job)
    const handles: string[] = []
    const started = Date.now()
    const ensureActive = () => { if (job.cancelled) throw new Error(uiText('backend.cancelled')) }
    try {
      report(jobId, { stage: 'start' })
      const input = await api.files.openVault(file)
      handles.push(input.handle)
      let result: WhisperJson
      let outputModel = model
      if (engine === 'local') {
        const [executable, ffmpeg] = await Promise.all([resolveWhisper(text(settings.whisperPath) || undefined), api.native.resolve({ name: 'ffmpeg' })])
        if (!executable || !ffmpeg) throw new Error(uiText('backend.tools'))
        ensureActive()
        const source = models[model as keyof typeof models]
        let weights = modelFiles.get(model) ?? await api.files.cached({ sha256: source.sha256, name: source.name })
        if (!weights) {
          report(jobId, { stage: 'download', percent: 0 })
          weights = await api.network.download({ requestId: job.requestId, url: source.url, name: source.name, sha256: source.sha256, maxBytes: 4 * 1024 ** 3 })
        }
        modelFiles.set(model, weights)
        ensureActive()
        const args: PluginNativeArgument[] = [{ input: input.handle }, '--model', { input: weights.handle }, '--output_format', 'json', '--output_dir', { outputDirectory: true }, '--fp16', 'False', '--verbose', 'False', ...(language ? ['--language', language] : [])]
        report(jobId, { stage: 'decode' })
        const output = await api.native.run({ jobId, executable: executable.handle, tools: [ffmpeg.handle], args, environment: { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' } })
        handles.push(...output.outputs.map((entry) => entry.handle))
        ensureActive()
        if (output.exitCode !== 0) throw new Error(uiText('backend.exit', { code: output.exitCode }))
        const transcript = output.outputs.find((entry) => entry.name.endsWith('.json'))
        if (!transcript) throw new Error(uiText('backend.empty'))
        result = await readJson(transcript)
      } else {
        const connectionId = text(payload.connectionId)
        const connections = (await api.accounts.list()).filter((account) => account.provider === 'openai' && account.capabilities.includes('ai.transcribe') && account.credentialState === 'ok')
        const connection = connectionId ? connections.find((account) => account.id === connectionId) : connections[0]
        if (!connection) throw new Error(uiText('backend.connection'))
        const url = new URL(`${(connection.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/audio/transcriptions`)
        const credential = await api.accounts.authorize(connection.id, 'ai.transcribe', { host: url.hostname, port: Number(url.port || 443), security: 'tls' })
        ensureActive()
        report(jobId, { stage: 'upload', percent: 0 })
        const response = await api.network.fetch({ requestId: job.requestId, url: url.toString(), method: 'POST', timeoutMs: 900000, credential: { handle: credential, placement: 'header', name: 'Authorization', prefix: 'Bearer ' }, multipart: { fields: { model: 'whisper-1', response_format: 'verbose_json', 'timestamp_granularities[]': 'segment', ...(language ? { language } : {}) }, files: [{ name: 'file', handle: input.handle }] } })
        ensureActive()
        const json = object(JSON.parse(decode(response.bodyBase64)))
        if (response.status < 200 || response.status >= 300) throw new Error(typeof (json.error as { message?: unknown } | undefined)?.message === 'string' ? String((json.error as { message: string }).message) : uiText('backend.openai', { status: response.status }))
        result = json as WhisperJson
        outputModel = 'whisper-1'
      }
      ensureActive()
      const segments = segmentsFromWhisperJson({ json: result, relPath: file, fileHash: input.sha1!, model: outputModel, requestedLanguage: language, createdAt: new Date().toISOString(), transcriptionDurationMs: Date.now() - started })
      report(jobId, { stage: 'done', percent: 100 })
      return segments
    } catch (error) {
      const message = job.cancelled ? uiText('backend.cancelled') : error instanceof Error ? error.message : uiText('backend.failed')
      report(jobId, { stage: job.cancelled ? 'cancelled' : 'error', message })
      throw new Error(message)
    } finally { jobs.delete(jobId); if (handles.length) await api.files.release(handles).catch(() => {}) }
  })
  return () => { for (const jobId of jobs.keys()) void cancel(jobId); offOutput(); offNetwork(); for (const dispose of handlers) dispose(); void api.files.release([...modelFiles.values()].map((entry) => entry.handle)).catch(() => {}); modelFiles.clear() }
}
