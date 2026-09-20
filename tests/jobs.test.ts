import { transcribeServices } from '../src/serviceClient'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { TranscribeProgress } from '../src/serviceClient'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import type { TranscriptSegment } from '../src/serviceClient'
import { createMockValleyApi } from './harness'
import { initRuntime } from '../src/runtime'
import { segmentsForFile } from '../src/store'
import TRANSCRIBE_PLUGIN_CONFIG from '../config.json'
import type { TranscribeJob } from '../src/jobs'
import en from '../locales/en.json'
import {
  cancelJob,
  estimateRemainingMs,
  initJobs,
  jobForFile,
  jobReadout,
  relPathForJob,
  startTranscription,
  transcribeJobs
} from '../src/jobs'

/**
 * The store behind "the percentage is visible even with every transcript view
 * closed". What it must get right is that a job is *not* owned by the panel that
 * started it — main is the one running it, and the events are the truth.
 */
function mount(): { api: ValleyPluginApi; emit: (progress: TranscribeProgress) => void; dispose: () => void } {
  const { api } = createMockValleyApi({ manifest: { id: 'transcribe' } })
  transcribeServices(api).cancel = async () => ({ ok: true, data: { cancelled: true } })
  let emit: (progress: TranscribeProgress) => void = () => {}
  transcribeServices(api).onProgress = vi.fn((cb: (progress: TranscribeProgress) => void) => {
    emit = cb
    return () => {}
  })
  initRuntime(api)
  const dispose = initJobs()
  return { api, emit: (progress) => emit(progress), dispose }
}

describe('the job store', () => {
  let harness: ReturnType<typeof mount>

  beforeEach(() => {
    harness = mount()
  })

  it('adopts a run it never started', () => {
    // Main defaults `jobId` to the file path, so a transcription started from
    // the file tree, the CLI or the assistant reports progress under a job id
    // this window has never seen. Dropping those is what used to leave the
    // footer silent for every run but the panel's own.
    harness.emit({ jobId: 'FieldRecordings/Fungi.mp3', stage: 'download', percent: 12 })
    const [job] = transcribeJobs().jobs
    expect(job).toMatchObject({ relPath: 'FieldRecordings/Fungi.mp3', stage: 'download', percent: 12 })
  })

  it('updates a job in place rather than stacking one entry per event', () => {
    harness.emit({ jobId: 'a.mp3', stage: 'download', percent: 4 })
    harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 40 })
    expect(transcribeJobs().jobs).toHaveLength(1)
    expect(transcribeJobs().jobs[0]).toMatchObject({ stage: 'decode', percent: 40 })
  })

  it('frees the entry on every terminal stage', () => {
    for (const stage of ['done', 'error', 'cancelled'] as const) {
      harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 10 })
      expect(transcribeJobs().jobs).toHaveLength(1)
      harness.emit({ jobId: 'a.mp3', stage })
      expect(transcribeJobs().jobs).toEqual([])
    }
  })

  it('remembers why an adopted run failed, for the panel to explain later', () => {
    harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 10 })
    harness.emit({ jobId: 'a.mp3', stage: 'error', message: 'ffmpeg was not found.' })
    expect(transcribeJobs().errors.get('a.mp3')).toBe('ffmpeg was not found.')
  })

  it('keeps a terminal event for an unknown job from inventing one', () => {
    harness.emit({ jobId: 'never-started.mp3', stage: 'done', percent: 100 })
    expect(transcribeJobs().jobs).toEqual([])
    expect(transcribeJobs().errors.size).toBe(0)
  })

  it('tracks several files at once', () => {
    harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 10 })
    harness.emit({ jobId: 'b.mp4', stage: 'decode', percent: 70 })
    expect(jobForFile(transcribeJobs().jobs, 'b.mp4')).toMatchObject({ percent: 70 })
  })

  it('keeps a cancelled run out of the error line', async () => {
    // The driver reports a stopped run as a thrown error, so without the
    // cancel intent every Cancel ended in a red "Transcription cancelled."
    // under the button — and a "failed" notification to match.
    harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 10 })
    await cancelJob('a.mp3')
    expect(transcribeJobs().jobs[0]).toMatchObject({ cancelling: true })
    harness.emit({ jobId: 'a.mp3', stage: 'error', message: 'Transcription cancelled.' })
    expect(transcribeJobs().jobs).toEqual([])
    expect(transcribeJobs().errors.size).toBe(0)
  })

  it('holds the entry while the engine comes down, so it cannot be re-adopted', async () => {
    harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 10 })
    await cancelJob('a.mp3')
    // Whisper keeps emitting for a moment after SIGTERM. Dropping the entry on
    // the click would let the next line recreate it — the button would flip
    // back from "Cancelling…" to "Cancel".
    harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 11 })
    expect(transcribeJobs().jobs).toHaveLength(1)
    expect(transcribeJobs().jobs[0].cancelling).toBe(true)
  })

  it('keeps a failed cancellation actionable and allows another attempt', async () => {
    harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 10 })
    transcribeServices(harness.api).cancel = async () => ({ ok: false, error: 'Engine unavailable' })
    expect(await cancelJob('a.mp3')).toBe(false)
    expect(transcribeJobs().jobs[0].cancelling).toBe(false)
    expect(transcribeJobs().errors.get('a.mp3')).toBe('Engine unavailable')
    transcribeServices(harness.api).cancel = async () => ({ ok: true, data: { cancelled: true } })
    expect(await cancelJob('a.mp3')).toBe(true)
  })

  it('starts empty on a fresh registration', () => {
    harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 10 })
    harness.dispose()
    harness = mount()
    expect(transcribeJobs().jobs).toEqual([])
  })
})

describe('estimateRemainingMs', () => {
  const job = (over: Partial<TranscribeJob>): TranscribeJob => ({
    jobId: 'a.mp3',
    relPath: 'a.mp3',
    stage: 'decode',
    startedAt: 0,
    elapsedMs: 60_000,
    stageStartedAt: 0,
    stageElapsedMs: 60_000,
    ...over
  })

  it('extrapolates from the rate this stage has actually run at', () => {
    // A quarter done after a minute → three minutes to go.
    expect(estimateRemainingMs(job({ percent: 25 }))).toBe(180_000)
  })

  it('counts down between progress events instead of increasing elapsed time', () => {
    const sampled = job({ percent: 25, estimatedStageDurationMs: 240_000 })
    expect(estimateRemainingMs(sampled)).toBe(180_000)
    expect(estimateRemainingMs({ ...sampled, stageElapsedMs: 70_000 })).toBe(170_000)
  })

  it('says nothing until there is evidence worth extrapolating from', () => {
    // "1 % after two seconds" predicts three minutes; the same run a moment
    // later predicts twenty. An absent estimate beats a wrong one.
    expect(estimateRemainingMs(job({ percent: 25, stageElapsedMs: 1000 }))).toBeUndefined()
    expect(estimateRemainingMs(job({ percent: 0.2 }))).toBeUndefined()
    expect(estimateRemainingMs(job({ percent: undefined }))).toBeUndefined()
  })

  it('is silent at the finish line and while cancelling', () => {
    expect(estimateRemainingMs(job({ percent: 100 }))).toBeUndefined()
    expect(estimateRemainingMs(job({ percent: 40, cancelling: true }))).toBeUndefined()
  })

  it('does not carry the model download into the decode estimate', () => {
    // The stage clock is the whole point: 4 minutes of weights arriving, then
    // 1 % decoded in the 10 s since. Job-elapsed math predicted ~7 hours.
    const afterDownload = job({ percent: 1, elapsedMs: 250_000, stageElapsedMs: 10_000 })
    expect(estimateRemainingMs(afterDownload)).toBe(990_000)
  })
})

describe('the stage clock', () => {
  it('restarts when the run moves from downloading to decoding', () => {
    const harness = mount()
    harness.emit({ jobId: 'a.mp3', stage: 'download', percent: 90 })
    const downloading = transcribeJobs().jobs[0]
    harness.emit({ jobId: 'a.mp3', stage: 'decode', percent: 1 })
    const decoding = transcribeJobs().jobs[0]
    expect(decoding.stageElapsedMs).toBe(0)
    expect(decoding.stageStartedAt).toBeGreaterThanOrEqual(downloading.stageStartedAt)
    // The job's own clock keeps running — only the estimate's is per stage.
    expect(decoding.startedAt).toBe(downloading.startedAt)
    harness.dispose()
  })
})

describe('relPathForJob', () => {
  it('strips the run counter the panel appends, and nothing else', () => {
    expect(relPathForJob('FieldRecordings/Fungi.mp3#3')).toBe('FieldRecordings/Fungi.mp3')
    // A `#` in the file's own name is not a counter.
    expect(relPathForJob('Notes/Track #2.mp3')).toBe('Notes/Track #2.mp3')
  })
})

describe('jobReadout', () => {
  const job = (over: Partial<TranscribeJob>): TranscribeJob => ({
    jobId: 'a.mp3',
    relPath: 'a.mp3',
    stage: 'decode',
    startedAt: 0,
    elapsedMs: 60_000,
    stageStartedAt: 0,
    stageElapsedMs: 60_000,
    ...over
  })

  it('shows the time left once the rate is trustworthy', () => {
    expect(jobReadout(job({ percent: 25 })).time).toContain('3:00')
    expect(jobReadout(job({ percent: 25 })).percent).toBe(' 25 %')
  })

  it('shows a calculating state before Whisper can provide a countdown', () => {
    const preparing = jobReadout(job({ stage: 'start', percent: undefined, elapsedMs: 32_000 }))
    expect(preparing.percent).toBe('')
    expect(preparing.time).not.toContain('0:32')
    // Against the catalog, not a substring of the key: until the catalog was
    // filled the raw key `transcribe.calculatingRemaining` satisfied a
    // 'calculat' match, so this assertion passed while the UI showed the key.
    expect(preparing.time).toBe(en['transcribe.calculatingRemaining'])
  })

  it('always says something about time, in every stage', () => {
    const stages: TranscribeJob['stage'][] = ['start', 'download', 'decode']
    for (const stage of stages) {
      for (const percent of [undefined, 0.2, 50, 100]) {
        expect(jobReadout(job({ stage, percent })).time).not.toBe('')
      }
    }
    expect(jobReadout(job({ percent: 40, cancelling: true })).time).not.toBe('')
  })

  it('names the model while its weights are coming down', () => {
    expect(jobReadout(job({ stage: 'download', model: 'medium', percent: 30 })).label).toContain('medium')
  })
})

/**
 * The panel button's path. It must NOT reach the command bus: the SDK tags a
 * plugin dispatch as an autonomous caller, and `transcribe:file` is a `write`
 * command, so it resolved against `defaultWrite: confirm` and parked a Guards
 * approval prompt on whatever assistant chat happened to be open. With no chat
 * in sight, pressing Transcribe sat on "Transcribing…" for the 30-minute
 * approval TTL and then denied itself — no Whisper process was ever spawned.
 */
describe('starting a transcription from the UI', () => {
  afterEach(() => vi.useRealTimers())
  const SEGMENT: TranscriptSegment = {
    id: 'hash:0',
    file: 'a.mp3',
    fileHash: 'hash',
    start: 0,
    end: 2,
    text: 'hello',
    language: 'en',
    createdAt: '2026-01-01T00:00:00.000Z'
  }

  type TranscribeFile = ReturnType<typeof transcribeServices>['file']

  function mountWith(file: TranscribeFile): ReturnType<typeof createMockValleyApi> {
    const mock = createMockValleyApi({
      manifest: {
        id: 'transcribe',
        datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets']
      }
    })
    transcribeServices(mock.api).file = file
    transcribeServices(mock.api).cancel = async () => ({ ok: true, data: { cancelled: true } })
    initRuntime(mock.api)
    initJobs()
    return mock
  }

  it('keeps a 150-second result, saved transcript, and undo with the session that accepted it', async () => {
    vi.useFakeTimers()
    let finish!: (result: Awaited<ReturnType<TranscribeFile>>) => void
    const file = vi.fn(() => new Promise<Awaited<ReturnType<TranscribeFile>>>((resolve) => { finish = resolve }))
    const previous = mountWith(file)
    const running = startTranscription({ relPath: 'a.mp3' })
    await vi.advanceTimersByTimeAsync(150_000)
    const current = mountWith(async () => ({ ok: true, data: [] }))
    finish({ ok: true, data: [SEGMENT] })
    await running
    expect(file).toHaveBeenCalledTimes(1)
    expect(await segmentsForFile('a.mp3', previous.api)).toEqual([SEGMENT])
    expect(await segmentsForFile('a.mp3', current.api)).toEqual([])
    expect(previous.undoActions).toHaveLength(1)
    expect(current.undoActions).toHaveLength(0)
    await previous.undoActions[0].undo()
    expect(await segmentsForFile('a.mp3', previous.api)).toEqual([])
    await previous.undoActions[0].redo?.()
    expect(await segmentsForFile('a.mp3', previous.api)).toEqual([SEGMENT])
    expect(await segmentsForFile('a.mp3', current.api)).toEqual([])
  })

  it('joins persistence and undo during repeated disposal after the backend result arrives', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe', datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets'] } })
    let finish!: (result: Awaited<ReturnType<TranscribeFile>>) => void
    transcribeServices(mock.api).file = () => new Promise((resolve) => { finish = resolve })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const transaction = mock.api.data.transaction.bind(mock.api.data)
    const persist = vi.spyOn(mock.api.data, 'transaction').mockImplementation(async (...args) => { await held; return transaction(...args) })
    initRuntime(mock.api)
    const dispose = initJobs()
    const running = startTranscription({ relPath: 'a.mp3' })
    const closing = dispose()
    expect(dispose()).toBe(closing)
    let disposed = false
    void closing.then(() => { disposed = true })
    finish({ ok: true, data: [SEGMENT] })
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    expect(disposed).toBe(false)
    expect(mock.undoActions).toHaveLength(0)
    await expect(startTranscription({ relPath: 'later.mp3' }, mock.api)).rejects.toThrow('cancelled')
    release()
    await Promise.all([running, closing])
    expect(mock.undoActions).toHaveLength(1)
    expect(await segmentsForFile('a.mp3', mock.api)).toEqual([SEGMENT])
  })

  it('uses the owned backend route once and preserves an unknown outcome without saving or replaying', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'transcribe', datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets'] } })
    const unknown = Object.assign(new Error('Backend outcome is unknown'), { outcome: 'unknown', retryable: false })
    const operation = vi.spyOn(mock.api.backend, 'callOperation').mockRejectedValue(unknown)
    const ordinary = vi.spyOn(mock.api.backend, 'call')
    initRuntime(mock.api)
    const dispose = initJobs()
    await startTranscription({ relPath: 'a.mp3' })
    expect(operation).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledWith('file', expect.objectContaining({ file: 'a.mp3' }))
    expect(ordinary).not.toHaveBeenCalled()
    expect(await segmentsForFile('a.mp3')).toEqual([])
    expect(mock.undoActions).toHaveLength(0)
    expect(transcribeJobs().errors.get('a.mp3')).toBe(unknown.message)
    await dispose()
  })

  it('drains accepted work during preparation and resumes admission when the transition is cancelled', async () => {
    let finish!: (result: Awaited<ReturnType<TranscribeFile>>) => void
    const mock = mountWith(() => new Promise((resolve) => { finish = resolve }))
    const running = startTranscription({ relPath: 'a.mp3' })
    let prepared = false
    const preparing = mock.runBeforeUnload().then(() => { prepared = true })
    await expect(startTranscription({ relPath: 'later.mp3' })).rejects.toThrow('cancelled')
    expect(prepared).toBe(false)
    finish({ ok: true, data: [SEGMENT] })
    await Promise.all([running, preparing])
    expect(mock.undoActions).toHaveLength(1)
    mock.runUnloadCancellation()
    transcribeServices(mock.api).file = async () => ({ ok: true, data: [SEGMENT] })
    await startTranscription({ relPath: 'a.mp3' })
    expect(mock.undoActions).toHaveLength(2)
  })

  it('runs the driver and never dispatches the write command', async () => {
    const file = vi.fn(async () => ({ ok: true, data: [SEGMENT] }))
    const mock = mountWith(file)
    await startTranscription({ relPath: 'a.mp3', model: 'tiny', language: 'en' })
    expect(mock.commandRuns.map((call) => call.id)).toEqual([])
    expect(file).toHaveBeenCalledWith(
      'a.mp3',
      expect.objectContaining({ model: 'tiny', language: 'en', jobId: expect.stringContaining('a.mp3#') })
    )
    expect(await segmentsForFile('a.mp3')).toEqual([SEGMENT])
    // And it lets go of the job, so the panel returns to an idle button.
    expect(transcribeJobs().jobs).toEqual([])
  })

  it('registers ⌘Z, which the bus used to provide', async () => {
    const mock = mountWith(async () => ({ ok: true, data: [SEGMENT] }))
    await startTranscription({ relPath: 'a.mp3' })
    const [action] = mock.undoActions
    expect(action.label).toContain('a.mp3')
    // A re-run replaces a transcript wholesale, so undo restores what was
    // there — for a first run, nothing.
    await action.undo()
    expect(await segmentsForFile('a.mp3')).toEqual([])
    await action.redo?.()
    expect(await segmentsForFile('a.mp3')).toEqual([SEGMENT])
  })

  it('puts a failed run on the file’s error line', async () => {
    mountWith(async () => ({ ok: false, error: 'ffmpeg was not found.' }))
    await startTranscription({ relPath: 'a.mp3' })
    expect(transcribeJobs().errors.get('a.mp3')).toBe('ffmpeg was not found.')
    expect(transcribeJobs().jobs).toEqual([])
  })

  it('does not report a run the user stopped as a failure', async () => {
    // The terminal progress event arrives before the driver's rejection, and it
    // used to consume the cancel intent on its way past — so the owner saw a
    // plain failure and drew a red line under the button it had just obeyed.
    let emit: (progress: TranscribeProgress) => void = () => {}
    const mock = createMockValleyApi({
      manifest: {
        id: 'transcribe',
        datasets: TRANSCRIBE_PLUGIN_CONFIG.datasets as unknown as ValleyPluginManifest['datasets']
      }
    })
    transcribeServices(mock.api).onProgress = vi.fn((cb: (progress: TranscribeProgress) => void) => {
      emit = cb
      return () => {}
    })
    transcribeServices(mock.api).cancel = async () => ({ ok: true, data: { cancelled: true } })
    transcribeServices(mock.api).file = async (_file, opts) => {
      await cancelJob(opts?.jobId ?? '')
      emit({ jobId: opts?.jobId ?? '', stage: 'cancelled' })
      return { ok: false, error: 'Transcription cancelled.' }
    }
    initRuntime(mock.api)
    initJobs()
    await startTranscription({ relPath: 'a.mp3' })
    expect(transcribeJobs().errors.size).toBe(0)
    expect(transcribeJobs().jobs).toEqual([])
  })
})
