import type { FileTreeContextItem, ValleyPluginApi, ValleyPluginModule } from '@valley/plugin-sdk'
import { FILE_TREE_CONTEXT_ITEM_V1, METADATA_PANEL_SEGMENT_V1 } from '@valley/plugin-sdk'
import type { TranscriptSegment } from './serviceClient'
import { initRuntime, React } from './runtime'
import { initLocalization } from './localization'
import { transcribePanelSegment } from './metadata'
import { FooterProgress } from './FooterProgress'
import { renderMetadataSegment } from './MetadataSegment'
import { SettingsView } from './SettingsView'
import { TranscriptView } from './TranscriptView'
import {
  cancelJob,
  transcribeJobs,
  initJobs,
  startFinishedNotifications,
  startTranscription,
  transcribeToStore
} from './jobs'
import { MODEL_OPTIONS, knownModel } from './models'
import { loadSegments, readSettings, replaceFileSegments, segmentsForFile } from './store'
import { inspectTranscriptProperties, registerTranscriptSurfaces } from './surfaces'
import { injectStyles } from './styles'

interface TranscribeInput {
  file: string
  model?: string
  language?: string
  jobId?: string
  durationMs?: number
}

function commandInput(usage: string): {
  schema: Record<string, unknown>
  parse: (raw: unknown) => TranscribeInput
  fromCli: (args: string[], flags: Record<string, string | boolean>) => TranscribeInput
} {
  const parse = (raw: unknown): TranscribeInput => {
    const value = (raw ?? {}) as Record<string, unknown>
    const file = typeof value.file === 'string' ? value.file.trim() : ''
    if (!file) throw new Error(usage)
    if (value.model !== undefined && !MODEL_OPTIONS.some((model) => model.value === value.model)) throw new Error('Unknown transcription model.')
    if (value.durationMs !== undefined && (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0)) throw new Error('Invalid media duration.')
    const text = (key: string): string | undefined => {
      const candidate = value[key]
      return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
    }
    return {
      file,
      model: text('model'),
      language: text('language'),
      jobId: text('jobId'),
      durationMs: typeof value.durationMs === 'number' ? value.durationMs : undefined
    }
  }
  return {
    schema: { type: 'object', properties: { file: { type: 'string', minLength: 1 }, model: { type: 'string', enum: MODEL_OPTIONS.map((model) => model.value) }, language: { type: 'string' }, jobId: { type: 'string' }, durationMs: { type: 'number', minimum: 0 } }, required: ['file'], additionalProperties: false },
    parse,
    fromCli: (args, flags) => parse({ file: args[0], model: flags.model, language: flags.language })
  }
}

export function register(api: ValleyPluginApi): () => void {
  initLocalization(api)
  initRuntime(api)
  const disposeStyles = injectStyles()
  const offJobs = initJobs()
  const offSurfaces = registerTranscriptSurfaces(api)

  const usage = 'transcribe file <vault-relative-file> [--model <model>] [--language <code>]'

  const offCommand = api.commands.register({
      id: 'file',
      label: "Transcribe: Transcribe a file",
      labelKey: 'transcribe.commandLabel',
      paletteSafe: false,
      sideEffect: 'write',
      usage,
      input: commandInput(usage),
      run: async (input) => {
      const settings = readSettings()
      // The same helper the panel button runs — one engine call, one write, so
      // the palette/CLI/assistant path and the human one cannot diverge. A
      // re-run replaces the file's transcript wholesale, so `previous` is what
      // ⌘Z restores: exactly what was there, not "nothing".
      const { segments, previous } = await transcribeToStore({
        relPath: input.file,
        engine: settings.engine,
        connectionId: settings.openAiConnectionId || undefined,
        model: knownModel(input.model ?? settings.model),
        language: input.language ?? settings.language,
        jobId: input.jobId,
        durationMs: input.durationMs
      })
      return {
        value: segments,
        revert: {
          label: `Transcribe ${input.file}`,
          run: async () => {
            if (!(await replaceFileSegments(input.file, previous)).ok) {
              throw new Error('Could not remove the transcript segments.')
            }
          },
          reapply: async () => {
            if (!(await replaceFileSegments(input.file, segments)).ok) {
              throw new Error('Could not restore the transcript segments.')
            }
          }
        }
      }
    },
      formatCli: (value) => {
      const segments = value as TranscriptSegment[]
      return segments.map((segment) => segment.text).join(' ')
    },
      revision: async (input) => ({ file: await api.vault.fileInfo(input.file), segments: await segmentsForFile(input.file), settings: readSettings() }),
      preview: (input) => ({
      action: 'transcribe-file',
      file: input.file,
      model: knownModel(input.model ?? readSettings().model),
      language: input.language ?? readSettings().language ?? null
    })
    })

  const fileInput = { schema: { type: 'object', properties: { file: { type: 'string', minLength: 1 } }, required: ['file'], additionalProperties: false }, parse: (raw: unknown) => { const file = (raw as Record<string, unknown>)?.file; if (typeof file !== 'string' || !file.trim()) throw new Error('Expected a media file path.'); return { file } } }
  const extraCommands = [
    api.commands.register({ id: 'list', label: 'Transcribe: List transcripts', labelKey: 'transcribe.command.list', paletteSafe: false, sideEffect: 'read', input: { schema: { type: 'object', properties: { file: { type: 'string' }, query: { type: 'string' } }, additionalProperties: false }, parse: (raw) => { const input = (raw ?? {}) as Record<string, unknown>; for (const key of ['file', 'query']) if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error('Expected transcript filter text.'); return { file: input.file as string | undefined, query: input.query as string | undefined } } }, run: async ({ file, query }) => (await loadSegments()).filter((segment) => (!file || segment.file === file) && (!query || segment.text.toLowerCase().includes(query.toLowerCase()))) }),
    api.commands.register({ id: 'get', label: 'Transcribe: Read transcript', labelKey: 'transcribe.command.get', paletteSafe: false, sideEffect: 'read', input: fileInput, run: async ({ file }) => { if (!(await api.vault.fileInfo(file))) throw new Error('The media file no longer exists.'); return segmentsForFile(file) } }),
    api.commands.register({ id: 'jobs', label: 'Transcribe: List jobs', labelKey: 'transcribe.command.jobs', paletteSafe: false, sideEffect: 'read', run: () => ({ jobs: transcribeJobs().jobs, errors: Object.fromEntries(transcribeJobs().errors) }) }),
    api.commands.register({
      id: 'cancel',
      label: 'Transcribe: Cancel job',
      labelKey: 'transcribe.command.cancel',
      paletteSafe: false,
      sideEffect: 'write',
      input: { schema: { type: 'object', properties: { jobId: { type: 'string', minLength: 1 } }, required: ['jobId'], additionalProperties: false }, parse: (raw) => { const jobId = (raw as Record<string, unknown>)?.jobId; if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Expected a transcription job id.'); return { jobId } } },
      run: async ({ jobId }) => { if (!transcribeJobs().jobs.some((job) => job.jobId === jobId)) throw new Error('This transcription job is no longer running.'); if (!(await cancelJob(jobId))) throw new Error('Could not cancel the transcription job.'); return { value: { jobId }, revert: null } },
      revision: ({ jobId }) => { const job = transcribeJobs().jobs.find((entry) => entry.jobId === jobId); return job ? { jobId, relPath: job.relPath, startedAt: job.startedAt, cancelling: !!job.cancelling } : null },
      preview: ({ jobId }) => ({ action: 'cancel-transcription', jobId })
    }),
    api.commands.register({ id: 'open-segment', label: 'Transcribe: Open segment', labelKey: 'transcribe.command.openSegment', paletteSafe: false, sideEffect: 'read', input: { schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false }, parse: (raw) => { const id = (raw as Record<string, unknown>)?.id; if (typeof id !== 'string' || !id.trim()) throw new Error('Expected a transcript segment id.'); return { id } } }, run: async ({ id }) => { const segment = (await loadSegments()).find((entry) => entry.id === id); if (!segment) throw new Error('The transcript segment no longer exists.'); if (!(await api.vault.fileInfo(segment.file))) throw new Error('The media file no longer exists.'); api.workspace.openFile(segment.file, { type: 'media-time', seconds: segment.start }); return segment } })
  ]

  // Offer "Transcribe file…" on media files in the file tree. Core neither
  // knows this plugin nor when the entry applies — we declare both.
  const offContextItem = api.interop.extensions.provide(FILE_TREE_CONTEXT_ITEM_V1, {
      id: 'transcribe',
      label: 'Transcribe file…',
      labelKey: 'transcribe.transcribe',
      icon: 'text-align-left',
      fileKinds: ['audio', 'video'],
      // Through the job store, not straight at the command: a run started here
      // has no panel open, which is exactly the one that needs the footer chip
      // and the finished notification.
      run: (relPath: string) => {
        void startTranscription({ relPath })
      }
    } satisfies FileTreeContextItem)

  const FileView = (): ReturnType<typeof React.createElement> => React.createElement(TranscriptView, {})
  const Page = (): ReturnType<typeof React.createElement> => React.createElement(TranscriptView, { all: true })
  api.registerView('transcribe.file', FileView)
  api.registerView('transcribe.page', Page)
  api.registerView('transcribe.settings', SettingsView)
  api.registerView('transcribe.footer', FooterProgress)

  const offSegment = api.interop.extensions.provide(
    METADATA_PANEL_SEGMENT_V1,
    { ...transcribePanelSegment(({ relPath }) => (relPath ? renderMetadataSegment(relPath) : null)), inspect: ({ relPath }) => inspectTranscriptProperties(relPath) }
  )

  const offFinished = startFinishedNotifications()
  return () => {
    offCommand()
    extraCommands.forEach((off) => off())
    offContextItem()
    offSegment()
    offFinished()
    offJobs()
    offSurfaces()
    disposeStyles()
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
