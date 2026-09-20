/**
 * Transcript records and plugin settings — everything the views read and write.
 *
 * The one rule that matters here: **re-transcribing a file replaces every
 * segment it owns.** The previous implementation only ever touched the `:0`
 * record (a file could not produce more than one), so with real per-segment
 * output an `update()` would leave the whole stale tail behind, silently
 * doubling the transcript.
 */
import type { DatasetRecord, ValleyPluginApi } from '@valley/plugin-sdk'
import type { TranscriptSegment } from './serviceClient'
import { api } from './runtime'
import { normalizeFollowPosition, type FollowPosition } from './follow'
import { DEFAULT_MODEL, knownModel } from './models'

const TRANSCRIPTIONS_DATASET = 'transcribe.transcriptions'
const SEGMENTS_DATASET = 'transcribe.transcript_segments'

export interface TranscribeSettings {
  engine: 'local' | 'openai'
  openAiConnectionId: string
  model: string
  language: string
  followByDefault: boolean
  followPosition: FollowPosition
  whisperPath: string
}

async function allRows(owner: ValleyPluginApi, dataset: string): Promise<DatasetRecord[]> {
  const rows: DatasetRecord[] = []
  let cursor: string | undefined
  do {
    const page = await owner.data.dataset(dataset).query({ limit: 1000, cursor })
    rows.push(...page.rows)
    cursor = page.cursor
  } while (cursor)
  return rows
}

export function onChanged(listener: () => void, owner = api): () => void {
  const offTranscriptions = owner.data.dataset(TRANSCRIPTIONS_DATASET).subscribe(listener)
  const offSegments = owner.data.dataset(SEGMENTS_DATASET).subscribe(listener)
  const offSettings = owner.settings.subscribe(listener)
  return () => {
    offTranscriptions()
    offSegments()
    offSettings()
  }
}

interface SegmentLoadState {
  pending: Promise<TranscriptSegment[]> | null
  revision: number
}

function segmentLoadState(owner: ValleyPluginApi): SegmentLoadState {
  return owner.runtime.getOrCreate('transcribe.segmentLoad', () => {
    const state: SegmentLoadState = { pending: null, revision: 0 }
    const invalidate = (): void => { state.revision += 1 }
    owner.data.dataset(TRANSCRIPTIONS_DATASET).subscribe(invalidate)
    owner.data.dataset(SEGMENTS_DATASET).subscribe(invalidate)
    return state
  })
}

export function loadSegments(owner = api): Promise<TranscriptSegment[]> {
  const state = segmentLoadState(owner)
  if (state.pending) return state.pending
  const pending = (async () => {
    let revision: number
    let segments: TranscriptSegment[]
    do {
      revision = state.revision
      segments = await readSegments(owner)
    } while (revision !== state.revision)
    return segments
  })()
  state.pending = pending
  const clear = (): void => { if (state.pending === pending) state.pending = null }
  void pending.then(clear, clear)
  return pending
}

async function readSegments(owner: ValleyPluginApi): Promise<TranscriptSegment[]> {
  const [transcriptions, segments] = await Promise.all([
    allRows(owner, TRANSCRIPTIONS_DATASET),
    allRows(owner, SEGMENTS_DATASET)
  ])
  const parents = new Map(transcriptions.map((row) => [String(row.id), row]))
  return segments.flatMap((segment) => {
    const parent = parents.get(String(segment.transcriptionId))
    if (!parent || typeof segment.segmentId !== 'string' || typeof parent.file !== 'string' ||
      typeof parent.fileHash !== 'string' || typeof segment.start !== 'number' ||
      typeof segment.end !== 'number' || typeof segment.text !== 'string' || typeof parent.createdAt !== 'string') return []
    return [{
      id: segment.segmentId,
      file: parent.file,
      fileHash: parent.fileHash,
      start: segment.start,
      end: segment.end,
      text: segment.text,
      language: typeof parent.language === 'string' ? parent.language : '',
      model: typeof parent.model === 'string' ? parent.model : undefined,
      transcriptionDurationMs: typeof parent.transcriptionDurationMs === 'number'
        ? parent.transcriptionDurationMs
        : undefined,
      createdAt: parent.createdAt
    }]
  })
}

/** One file's transcript, in playback order. */
export async function segmentsForFile(relPath: string, owner = api): Promise<TranscriptSegment[]> {
  const all = await loadSegments(owner)
  return all.filter((segment) => segment.file === relPath).sort((a, b) => a.start - b.start)
}

/**
 * Set a file's transcript to exactly `next`, leaving every other file's records
 * untouched.
 *
 * Parent replacement and ordered segment insertion share one transaction, so
 * a crash cannot leave a half-written transcript.
 */
export async function replaceFileSegments(
  relPath: string,
  next: TranscriptSegment[],
  owner = api
): Promise<{ ok: boolean; previous: TranscriptSegment[] }> {
  const previous = await segmentsForFile(relPath, owner)
  try {
    const current = await owner.data.dataset(TRANSCRIPTIONS_DATASET).query({ where: { file: relPath }, limit: 1 })
    const currentId = typeof current.rows[0]?.id === 'string' ? current.rows[0].id : null
    if (!next.length) {
      if (currentId) await owner.data.dataset(TRANSCRIPTIONS_DATASET).delete({ id: currentId })
      return { ok: true, previous }
    }
    const first = next[0]
    const transcriptionId = first.fileHash
    await owner.data.transaction([
      ...(currentId ? [{ dataset: TRANSCRIPTIONS_DATASET, operation: 'delete' as const, key: { id: currentId } }] : []),
      {
        dataset: TRANSCRIPTIONS_DATASET,
        operation: 'insert',
        values: {
          id: transcriptionId,
          file: relPath,
          fileHash: first.fileHash,
          language: first.language,
          model: first.model ?? null,
          transcriptionDurationMs: first.transcriptionDurationMs ?? null,
          createdAt: first.createdAt
        }
      },
      {
        dataset: SEGMENTS_DATASET,
        operation: 'insert',
        values: next.map((segment, position) => ({
          transcriptionId,
          position,
          segmentId: segment.id,
          start: segment.start,
          end: segment.end,
          text: segment.text
        }))
      }
    ])
    return { ok: true, previous }
  } catch {
    return { ok: false, previous }
  }
}

export function readSettings(owner = api): TranscribeSettings {
  const raw = owner.settings.get()
  return {
    engine: raw.engine === 'openai' ? 'openai' : 'local',
    openAiConnectionId: typeof raw.openAiConnectionId === 'string' ? raw.openAiConnectionId : '',
    model: knownModel(raw.model),
    language: typeof raw.language === 'string' ? raw.language : '',
    followByDefault: raw.followByDefault !== false,
    followPosition: normalizeFollowPosition(raw.followPosition),
    whisperPath: typeof raw.whisperPath === 'string' ? raw.whisperPath : ''
    // Finished-run delivery is configured through Notifications.
  }
}

export async function writeSetting(key: keyof TranscribeSettings, value: unknown, owner = api): Promise<void> {
  const result = await owner.settings.set(key, value)
  if (!result.ok) throw new Error(result.error ?? 'Could not save transcription settings.')
}

export { DEFAULT_MODEL }
