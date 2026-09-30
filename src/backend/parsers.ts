import type { TranscriptSegment } from '../serviceClient'
import { normalizeWhisperLanguage } from './languages'

export function whisperArgv(input: {
  audio: string
  model: string
  language: string
  outputDir: string
}): string[] {
  return [
    input.audio,
    '--model',
    input.model,
    '--output_format',
    'json',
    '--output_dir',
    input.outputDir,
    '--fp16',
    'False',
    '--verbose',
    'False',
    ...(input.language ? ['--language', input.language] : [])
  ]
}

/** `[00:12.340 --> 00:15.900]  text` / `[01:02:03.000 --> …]` → end seconds + text. */
export function parseDecodeLine(line: string): { end: number; text: string } | null {
  const match = line.match(
    /^\[(?:(\d+):)?(\d{1,2}):(\d{2}\.\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2}\.\d{3})\]\s?(.*)$/
  )
  if (!match) return null
  const end = Number(match[4] ?? 0) * 3600 + Number(match[5]) * 60 + Number(match[6])
  return { end, text: match[7].trim() }
}

/** The percentage off the model-download tqdm bar, or null. */
export function parseDownloadPercent(chunk: string): number | null {
  const lines = chunk.split(/[\r\n]+/).filter((line) => !/frames\/s/.test(line))
  const matches = lines.flatMap((line) => [...line.matchAll(/(\d{1,3})%\|/g)])
  if (!matches.length) return null
  return Math.min(100, Number(matches[matches.length - 1][1]))
}

export interface DecodeProgress {
  percent: number
  remainingMs?: number
}

function clockMs(value: string): number | undefined {
  const parts = value.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return undefined
  const seconds = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1]
  return seconds * 1000
}

/** Whisper's frame tqdm bar (`25%|…| 250/1000 [01:00<03:00, …frames/s]`). */
export function parseDecodeProgress(chunk: string): DecodeProgress | null {
  const lines = chunk.split(/[\r\n]+/).filter((line) => /frames\/s/.test(line))
  const line = lines[lines.length - 1]
  if (!line) return null
  const percent = line.match(/(\d{1,3})%\|/)
  if (!percent) return null
  const remaining = line.match(/\[[^\]<]*<([^,\]]+)/)
  const remainingMs = remaining ? clockMs(remaining[1].trim()) : undefined
  return {
    percent: Math.min(100, Number(percent[1])),
    ...(remainingMs === undefined ? {} : { remainingMs })
  }
}

/** `  Duration: 00:41:03.12, start: 0.000000, bitrate: …` → seconds, or null. */
export function parseFfmpegDuration(output: string): number | null {
  const match = output.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/)
  if (!match) return null
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

export interface WhisperJson {
  text?: string
  language?: string
  segments?: { start?: number; end?: number; text?: string }[]
}

/**
 * Whisper's JSON → the records we persist.
 *
 * Ids are `<sha1 of the media>:<index>`: content-addressed, so the same file
 * re-transcribed lands on the same ids, and index-bearing, so a transcript is no
 * longer forced into the single `:0` record the previous implementation stored.
 */
export function segmentsFromWhisperJson(input: {
  json: WhisperJson
  relPath: string
  fileHash: string
  model: string
  requestedLanguage: string
  createdAt: string
  transcriptionDurationMs?: number
}): TranscriptSegment[] {
  const language =
    normalizeWhisperLanguage(input.json.language) || normalizeWhisperLanguage(input.requestedLanguage)
  const raw = input.json.segments ?? []
  const segments = raw.length
    ? raw
    : // A file Whisper heard as one utterance still deserves a record.
      [{ start: 0, end: 0, text: input.json.text ?? '' }]
  return segments
    .map((segment, index) => ({
      id: `${input.fileHash}:${index}`,
      file: input.relPath,
      fileHash: input.fileHash,
      start: Math.max(0, segment.start ?? 0),
      end: Math.max(0, segment.end ?? 0),
      text: (segment.text ?? '').trim(),
      language,
      model: input.model,
      transcriptionDurationMs: input.transcriptionDurationMs,
      createdAt: input.createdAt
    }))
    .filter((segment) => segment.text.length > 0)
}
