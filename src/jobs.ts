import { transcribeServices } from './serviceClient'
/**
 * Every transcription running in this window, held **outside React**.
 *
 * A run takes minutes — the first one on a fresh model spends most of them
 * downloading weights — and the note panel that started it is unmounted the
 * moment someone selects another segment, opens another file or closes the
 * sidebar. State kept in that component died with it: reopening the panel showed
 * an idle Transcribe button while Whisper was still working, and nothing
 * anywhere reported the download.
 *
 * So the job list lives here, fed by one `onProgress` subscription taken in
 * `register()`. Three consequences worth knowing:
 *
 * - **Unknown jobs are adopted.** Main defaults `jobId` to the file path when a
 *   caller passes none (`drivers/transcribe.ts`), so a run started from the file
 *   tree, the CLI or the assistant reports progress too. A progress event for an
 *   id we never started creates the entry rather than being dropped, which is
 *   what makes the footer honest about *any* transcription.
 * - **The terminal event is the one that frees the entry**, not the resolving
 *   command — but `startTranscription` clears it as well, so a failure that never
 *   reaches the progress channel cannot strand a chip in the footer forever.
 * - **Notifications fire once per job.** An owned run reports through the
 *   command result (the engine's exact error message); an adopted one through
 *   its terminal event. `owned` is what keeps those from doubling up.
 */
import type { TranscribeProgress } from './serviceClient'
import type { TranscriptSegment } from './serviceClient'
import type { ValleyPluginApi } from '@valley/plugin-sdk'
import { api, React } from './runtime'
import { formatTimecode } from './follow'
import { uiText } from './localization'
import { knownModel } from './models'
import { readSettings, replaceFileSegments } from './store'

export interface TranscribeJob {
  jobId: string
  relPath: string
  /** Absent for an adopted job: the caller's model is not in the event. */
  model?: string
  stage: TranscribeProgress['stage']
  /** Absent means indeterminate, never zero. */
  percent?: number
  startedAt: number
  elapsedMs: number
  /** When the *current* stage began — the estimate's clock. */
  stageStartedAt: number
  stageElapsedMs: number
  /** Estimated total wall time for the current stage. */
  estimatedStageDurationMs?: number
  /** Cancel was pressed and the engine has not stopped yet. */
  cancelling?: boolean
}

export interface TranscribeJobsState {
  jobs: readonly TranscribeJob[]
  /** Last failure per file, so the panel can explain an empty transcript even
   *  when the run that failed happened while it was closed. */
  errors: ReadonlyMap<string, string>
}

const EMPTY: TranscribeJobsState = { jobs: [], errors: new Map() }

let state: TranscribeJobsState = EMPTY
const listeners = new Set<() => void>()
/** Jobs this window started, whose outcome the command result reports. */
const owned = new Set<string>()
/** Jobs the user asked to stop — a cancellation is not a failure and must not
 *  reach the error line or the notification, whatever the bus calls it. */
const cancelling = new Set<string>()
let ticker = 0
let runCount = 0
let offProgress: (() => void) | null = null
let jobsApi: ValleyPluginApi | null = null

function workFor(owner: ValleyPluginApi) {
  return owner.runtime.getOrCreate('transcribe.jobWork', () => ({ pending: new Set<Promise<unknown>>(), accepting: true, closed: false }))
}

function retain<T>(owner: ValleyPluginApi, run: () => Promise<T>): Promise<T> {
  const work = workFor(owner)
  if (!work.accepting || work.closed) return Promise.reject(new Error(uiText('backend.cancelled')))
  const pending = run()
  work.pending.add(pending)
  const settled = (): void => { work.pending.delete(pending) }
  void pending.then(settled, settled)
  return pending
}

async function drain(owner: ValleyPluginApi): Promise<void> {
  const work = workFor(owner)
  do { await Promise.allSettled([...work.pending]) } while (work.pending.size)
}

function emit(next: TranscribeJobsState): void {
  state = next
  for (const listener of listeners) listener()
}

function setJobs(jobs: readonly TranscribeJob[]): void {
  emit({ jobs, errors: state.errors })
  // The elapsed clock runs only while something is running: the estimate is
  // derived from it, and an idle interval would tick for the whole session.
  if (jobs.length > 0 && ticker === 0) {
    ticker = window.setInterval(() => {
      const now = Date.now()
      emit({
        jobs: state.jobs.map((job) => ({
          ...job,
          elapsedMs: now - job.startedAt,
          stageElapsedMs: now - job.stageStartedAt
        })),
        errors: state.errors
      })
    }, 1000)
  } else if (jobs.length === 0 && ticker !== 0) {
    window.clearInterval(ticker)
    ticker = 0
  }
}

function upsert(job: TranscribeJob): void {
  const index = state.jobs.findIndex((entry) => entry.jobId === job.jobId)
  if (index === -1) {
    setJobs([...state.jobs, job])
    return
  }
  const jobs = state.jobs.slice()
  jobs[index] = job
  setJobs(jobs)
}

function drop(jobId: string): TranscribeJob | undefined {
  const existing = state.jobs.find((job) => job.jobId === jobId)
  if (existing) setJobs(state.jobs.filter((job) => job.jobId !== jobId))
  return existing
}

function setError(relPath: string, message: string): void {
  const errors = new Map(state.errors)
  if (message) errors.set(relPath, message)
  else errors.delete(relPath)
  emit({ jobs: state.jobs, errors })
}

/** `Lecture.mp3#3` → `Lecture.mp3`. Only a run counter is ever appended, so a
 *  file whose own name contains `#` survives the trip. */
export function relPathForJob(jobId: string): string {
  return jobId.replace(/#\d+$/, '')
}

function baseName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath
}

/** `transcribe:<relPath>` — the key a click on the banner comes back under. */
const NOTIFY_KEY_PREFIX = 'finished:'

/**
 * Announce a finished run — the app is in the background by then, which is the
 * whole reason this is not a toast.
 *
 * Whether it reaches the OS, an in-app toast, both or nothing is the user's row
 * in Preferences → Notification, not a switch of our own: this plugin used to
 * carry a private `notifyOnDone` boolean, and two controls for one behaviour is
 * one too many.
 */
function notifyFinished(relPath: string, error: string, owner: ValleyPluginApi): void {
  const file = baseName(relPath)
  void owner.notifications.notify(error ? 'failed' : 'done', {
    title: error ? uiText('transcribe.notifyFailedTitle') : uiText('transcribe.notifyDoneTitle'),
    body: error ? uiText('transcribe.notifyFailedBody', { file, message: error }) : file,
    key: `${NOTIFY_KEY_PREFIX}${relPath}`
  })
}

/**
 * Clicking the banner opens the transcript it is about. Main has already focused
 * the window by the time this arrives.
 */
export function startFinishedNotifications(owner = api): () => void {
  return owner.notifications.onAction(({ key, action }) => {
    if (action !== 'click' || !key.startsWith(NOTIFY_KEY_PREFIX)) return
    void owner.workspace.openFile(key.slice(NOTIFY_KEY_PREFIX.length))
  })
}

function handleProgress(event: TranscribeProgress, owner: ValleyPluginApi): void {
  const terminal = event.stage === 'done' || event.stage === 'error' || event.stage === 'cancelled'
  if (terminal) {
    const finished = drop(event.jobId)
    // An owned run is reported by `startTranscription`, which still needs the
    // cancel intent to tell "the user pressed Stop" from "the engine failed" —
    // consuming the entry here left every Cancel looking like a failure.
    if (owned.has(event.jobId)) return
    const stopped = cancelling.delete(event.jobId)
    if (!finished) return
    const relPath = finished.relPath
    if (event.stage === 'error' && !stopped) setError(relPath, event.message || uiText('transcribe.failed'))
    if (event.stage !== 'cancelled' && !stopped) {
      void notifyFinished(relPath, event.stage === 'error' ? event.message ?? '' : '', owner)
    }
    return
  }
  const existing = state.jobs.find((job) => job.jobId === event.jobId)
  const now = Date.now()
  const base = existing ?? {
    jobId: event.jobId,
    relPath: relPathForJob(event.jobId),
    startedAt: now,
    elapsedMs: 0,
    stageStartedAt: now,
    stageElapsedMs: 0
  }
  // A new stage restarts the estimate's clock. Downloading 1.5 GB of weights
  // and then decoding are two different rates, and carrying the download's
  // minutes into the first decode percent predicted hours.
  const stageChanged = existing !== undefined && existing.stage !== event.stage
  const stageStartedAt = stageChanged ? now : base.stageStartedAt
  const stageElapsedMs = stageChanged ? 0 : now - stageStartedAt
  const measuredTotal = event.remainingMs === undefined
    ? event.percent !== undefined && event.percent >= MIN_ESTIMATE_PERCENT && event.percent < 100 && stageElapsedMs >= MIN_ESTIMATE_MS
      ? (stageElapsedMs / event.percent) * 100
      : undefined
    : stageElapsedMs + event.remainingMs
  upsert({
    ...base,
    stage: event.stage,
    percent: event.percent,
    stageStartedAt,
    stageElapsedMs,
    estimatedStageDurationMs: stageChanged
      ? measuredTotal
      : measuredTotal ?? existing?.estimatedStageDurationMs
  })
}

/**
 * How much longer this stage has, from the rate it has actually run at.
 *
 * Deliberately not a model of Whisper's speed: the same arithmetic serves a
 * 20 MB/s download and a decode running at 3× realtime. Two guards keep it from
 * lying — an estimate needs a few seconds of evidence and at least one full
 * percent, because extrapolating from "1 % after 2 s" produces the hour-long
 * predictions that make a progress bar worse than none.
 */
const MIN_ESTIMATE_MS = 4000
const MIN_ESTIMATE_PERCENT = 1

export function estimateRemainingMs(job: TranscribeJob): number | undefined {
  const percent = job.percent
  if (job.cancelling || percent === undefined) return undefined
  if (percent < MIN_ESTIMATE_PERCENT || percent >= 100) return undefined
  const total = job.estimatedStageDurationMs ?? (
    job.stageElapsedMs >= MIN_ESTIMATE_MS
      ? (job.stageElapsedMs / percent) * 100
      : undefined
  )
  if (total === undefined) return undefined
  return Math.max(0, total - job.stageElapsedMs)
}

/** What a running job says in the panel and in the footer chip. */
export interface JobReadout {
  /** "Downloading the medium model…" · "Transcribing…" · "Stopping…" */
  label: string
  /** " 42 %", or `''` while the stage is indeterminate. */
  percent: string
  /** "~1:34 left", or a calculating label until an estimate is trustworthy. */
  time: string
}

/**
 * The one place a live job is put into words, so the panel line and the footer
 * chip cannot drift apart.
 *
 * **There is always a status.** Until Whisper has measured enough frames for an
 * ETA, the UI says it is calculating. It never substitutes elapsed time: that
 * counts upward in the exact place the user expects a countdown.
 */
export function jobReadout(job: TranscribeJob): JobReadout {
  const label = job.cancelling
    ? uiText('transcribe.cancelling')
    : job.stage === 'download'
      ? job.model
        ? uiText('transcribe.downloadingModel', { model: job.model })
        : uiText('transcribe.downloadingAnyModel')
      : job.stage === 'upload'
        ? uiText('transcribe.uploading')
        : job.stage === 'request'
          ? uiText('transcribe.waitingForOpenAi')
          : uiText('transcribe.transcribing')
  const remainingMs = estimateRemainingMs(job)
  return {
    label,
    percent: job.cancelling || job.percent === undefined ? '' : ` ${Math.round(job.percent)} %`,
    time: remainingMs === undefined
      ? uiText('transcribe.calculatingRemaining')
      : uiText('transcribe.remaining', { time: formatTimecode(remainingMs / 1000) })
  }
}

/** Subscribe once, in `register()`. Returns the disposer the plugin unwinds. */
export function initJobs(owner = api): () => Promise<void> {
  offProgress?.()
  jobsApi = owner
  const work = workFor(owner)
  // A fresh instance starts empty. A hot reload mid-run loses its chip for at
  // most one progress event — the next one re-adopts the job.
  owned.clear()
  cancelling.clear()
  if (ticker !== 0) window.clearInterval(ticker)
  ticker = 0
  emit(EMPTY)
  const off = transcribeServices(owner).onProgress((event) => { if (jobsApi === owner) handleProgress(event, owner) })
  offProgress = off
  const offUnload = owner.runtime.onBeforeUnload(async () => {
    work.accepting = false
    await drain(owner)
  }, () => { if (!work.closed) work.accepting = true })
  let disposal: Promise<void> | undefined
  return () => {
    if (disposal) return disposal
    work.closed = true
    work.accepting = false
    off()
    offUnload()
    if (offProgress === off) offProgress = null
    disposal = drain(owner).then(() => {
      if (jobsApi !== owner) return
      if (ticker !== 0) window.clearInterval(ticker)
      ticker = 0
      owned.clear()
      cancelling.clear()
      emit(EMPTY)
    })
    return disposal
  }
}

/**
 * Run the engine and persist what it produced — the one place a transcript is
 * written, shared by the panel button and the `transcribe:file` command so the
 * two can never disagree about what a finished run leaves on disk.
 *
 * A re-run replaces the file's transcript wholesale, so `previous` comes back
 * with it: that is what an undo entry restores, and "nothing" is the wrong
 * answer for a file that already had one.
 */
export function transcribeToStore(input: {
  relPath: string
  engine: 'local' | 'openai'
  connectionId?: string
  model: string
  language: string
  jobId?: string
  durationMs?: number
}, owner = api): Promise<{ segments: TranscriptSegment[]; previous: TranscriptSegment[] }> {
  return retain(owner, async () => {
    const response = await transcribeServices(owner).file(input.relPath, {
      engine: input.engine,
      connectionId: input.connectionId,
      model: input.model,
      language: input.language,
      jobId: input.jobId,
      durationMs: input.durationMs
    })
    if (!response.ok || !response.data) throw new Error(response.error || uiText('transcribe.failed'))
    const segments = response.data
    const { ok, previous } = await replaceFileSegments(input.relPath, segments, owner)
    if (!ok) throw new Error(uiText('transcribe.persistFailed'))
    return { segments, previous }
  })
}

/**
 * THE way the UI starts a transcription — the panel button, the file-tree entry,
 * anything else added later. Going through here is what buys the run its footer
 * chip, its resumable panel state and its notification.
 *
 * **It calls the driver, not the command bus, and that is load-bearing.** The
 * SDK tags every plugin dispatch as an autonomous caller, so `transcribe:file`
 * — a `write` command — resolved against `policy.defaultWrite = confirm` and
 * parked a Guards approval prompt on whatever assistant chat happened to be
 * open. With the panel in front of you and no chat in sight, pressing
 * Transcribe sat on "Transcribing…" for the 30-minute approval TTL and then
 * quietly denied itself: no Whisper process was ever spawned. A human pressing
 * a button in our own view is not an autonomous action, and a driver call is
 * the path that says so (deny-only guarding, like every other plugin write).
 * The command still exists for the palette, the CLI and the assistant, where
 * the prompt belongs — see the manifest's `guardPresets`.
 *
 * Undo is registered here rather than inherited from the bus, the same way the
 * todo and calendar data layers do it, so ⌘Z still restores the transcript the
 * run replaced.
 */
export function startTranscription(input: {
  relPath: string
  model?: string
  language?: string
  durationMs?: number
}, owner = api): Promise<void> {
  return retain(owner, async () => {
    const settings = readSettings(owner)
    const model = knownModel(input.model ?? settings.model)
    const language = input.language ?? settings.language
    runCount += 1
    const jobId = `${input.relPath}#${runCount}`
    owned.add(jobId)
    setError(input.relPath, '')
    const startedAt = Date.now()
    upsert({
      jobId,
      relPath: input.relPath,
      model,
      stage: 'start',
      startedAt,
      elapsedMs: 0,
      stageStartedAt: startedAt,
      stageElapsedMs: 0
    })

    let message = ''
    try {
      const { segments, previous } = await transcribeToStore({
        relPath: input.relPath,
        engine: settings.engine,
        connectionId: settings.openAiConnectionId || undefined,
        model,
        language,
        jobId,
        durationMs: input.durationMs
      }, owner)
      owner.undo.push({
        label: uiText('transcribe.undoLabel', { file: baseName(input.relPath) }),
        undo: async () => ({ ok: (await replaceFileSegments(input.relPath, previous, owner)).ok }),
        redo: async () => ({ ok: (await replaceFileSegments(input.relPath, segments, owner)).ok })
      })
    } catch (err) {
      message = err instanceof Error ? err.message : uiText('transcribe.failed')
    } finally {
      owned.delete(jobId)
      if (jobsApi === owner) drop(jobId)
    }

    // Cancelling is not a failure — it is the button doing what it says. The
    // driver does not know that: it reports a stopped run as a thrown error, so
    // our own intent is the only thing that tells them apart, and without it
    // every Cancel ended in a red line plus a "failed" notification.
    const stopped = cancelling.delete(jobId)
    const failure = Boolean(message) && !stopped
    if (failure && jobsApi === owner) setError(input.relPath, message)
    if (!stopped) void notifyFinished(input.relPath, failure ? message : '', owner)
  })
}

/**
 * Ask the engine to stop, and say so in the UI immediately.
 *
 * The entry is kept (marked `cancelling`) rather than dropped: Whisper can take
 * seconds to come down, and a dropped entry would be re-adopted by the very next
 * progress line, flipping the button back to Cancel.
 */
export async function cancelJob(jobId: string, owner = api): Promise<boolean> {
  if (jobsApi !== owner) return false
  const job = state.jobs.find((entry) => entry.jobId === jobId)
  if (!job) return false
  if (job.cancelling) return true
  cancelling.add(jobId)
  upsert({ ...job, cancelling: true })
  const result = await transcribeServices(owner).cancel(jobId).catch((reason) => ({ ok: false as const, error: reason instanceof Error ? reason.message : String(reason), data: undefined }))
  if (jobsApi !== owner) return result.ok && result.data?.cancelled !== false
  if (!result.ok || result.data?.cancelled === false) {
    cancelling.delete(jobId)
    if (!state.jobs.some((entry) => entry.jobId === jobId)) return false
    upsert({ ...job, cancelling: false })
    setError(job.relPath, result.error ?? uiText('transcribe.failed'))
    return false
  }
  return true
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): TranscribeJobsState {
  return state
}

/** The store outside React — what the views read through {@link useTranscribeJobs}. */
export function transcribeJobs(owner = api): TranscribeJobsState {
  return jobsApi === owner ? state : EMPTY
}

export function useTranscribeJobs(): TranscribeJobsState {
  return React.useSyncExternalStore(subscribe, snapshot)
}

/** The run for one file, if any — what the panel's button and bar read. */
export function jobForFile(jobs: readonly TranscribeJob[], relPath: string): TranscribeJob | undefined {
  return jobs.find((job) => job.relPath === relPath)
}
