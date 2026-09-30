// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  parseDecodeLine,
  parseDecodeProgress,
  parseDownloadPercent,
  parseFfmpegDuration,
  segmentsFromWhisperJson,
  whisperArgv
} from '../src/backend/parsers'

describe('whisperArgv', () => {
  const base = { audio: '/vault/talk.mp4', model: 'small', outputDir: '/tmp/out' }

  it('asks for JSON in a private output dir', () => {
    const argv = whisperArgv({ ...base, language: 'de' })
    expect(argv[0]).toBe('/vault/talk.mp4')
    expect(argv).toContain('--output_format')
    expect(argv[argv.indexOf('--output_format') + 1]).toBe('json')
    expect(argv[argv.indexOf('--output_dir') + 1]).toBe('/tmp/out')
    expect(argv[argv.indexOf('--model') + 1]).toBe('small')
  })

  it('passes a chosen language as a code', () => {
    const argv = whisperArgv({ ...base, language: 'de' })
    expect(argv[argv.indexOf('--language') + 1]).toBe('de')
  })

  it('omits --language entirely for auto-detect', () => {
    // `--language ''` is an argparse error, not "detect it" — the flag has to be
    // absent, which is what makes auto-detect work at all.
    expect(whisperArgv({ ...base, language: '' })).not.toContain('--language')
  })

  it('asks Whisper for its frame progress bar', () => {
    const argv = whisperArgv({ ...base, language: '' })
    expect(argv[argv.indexOf('--verbose') + 1]).toBe('False')
  })

  it('never builds a shell string, whatever the file is called', () => {
    const argv = whisperArgv({ ...base, audio: '/vault/a b; rm -rf ~/.mp3', language: '' })
    // One argv entry, quoting and all. `spawn` runs with `shell:false`, so the
    // semicolon is part of a file name and nothing else.
    expect(argv[0]).toBe('/vault/a b; rm -rf ~/.mp3')
    expect(argv.filter((token) => token.includes(';'))).toHaveLength(1)
  })
})

describe('parseDecodeLine', () => {
  it('reads a decoded segment off the verbose stream', () => {
    expect(parseDecodeLine('[00:12.340 --> 00:15.900]  Guten Abend.')).toEqual({
      end: 15.9,
      text: 'Guten Abend.'
    })
  })

  it('reads the hour form a long recording produces', () => {
    expect(parseDecodeLine('[01:02:03.000 --> 01:02:07.500]  Still going.')?.end).toBe(3727.5)
  })

  it('ignores anything that is not a segment line', () => {
    expect(parseDecodeLine('Detecting language using up to the first 30 seconds')).toBeNull()
    expect(parseDecodeLine('')).toBeNull()
  })
})

describe('parseDownloadPercent', () => {
  it('reads the weights download off the tqdm bar', () => {
    expect(parseDownloadPercent('  5%|▌         | 36.0M/461M [00:02<00:25, 16.6MiB/s]')).toBe(5)
  })

  it('takes the latest figure when a chunk carries several', () => {
    expect(parseDownloadPercent('10%|x| a\r 40%|xxxx| b')).toBe(40)
  })

  it('answers null for ordinary output', () => {
    expect(parseDownloadPercent('Detected language: German')).toBeNull()
  })
})

describe('parseDecodeProgress', () => {
  it('reads completion and remaining time from Whisper’s frame bar', () => {
    expect(parseDecodeProgress(' 25%|██▌       | 250/1000 [01:00<03:00, 4.17frames/s]')).toEqual({
      percent: 25,
      remainingMs: 180_000
    })
  })

  it('does not mistake the model download for decoding', () => {
    expect(parseDecodeProgress('  5%|▌         | 36.0M/461M [00:02<00:25, 16.6MiB/s]')).toBeNull()
  })
})

describe('parseFfmpegDuration', () => {
  // The decode percentage divides by this. It used to come from the renderer's
  // player, which only knows the file it is holding — so transcribing anything
  // else reported no percentage at all, for the whole run.
  const dump = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'FieldRecordings/Fungi.mp4':",
    '  Metadata:',
    '    encoder         : Lavf58.29.100',
    '  Duration: 01:12:33.45, start: 0.000000, bitrate: 1174 kb/s'
  ].join('\n')

  it('reads the length out of the metadata dump', () => {
    expect(parseFfmpegDuration(dump)).toBeCloseTo(4353.45, 2)
  })

  it('handles a short file and sub-second precision', () => {
    expect(parseFfmpegDuration('  Duration: 00:00:41.20, start: 0.000000')).toBeCloseTo(41.2, 2)
  })

  it('answers null rather than zero when there is no duration', () => {
    // N/A is what a stream with no known length prints; zero would be a
    // denominator, null falls back to an honest indeterminate bar.
    expect(parseFfmpegDuration('  Duration: N/A, start: 0.000000, bitrate: N/A')).toBeNull()
    expect(parseFfmpegDuration('ffmpeg version 7.1')).toBeNull()
    expect(parseFfmpegDuration('  Duration: 00:00:00.00, start: 0.000000')).toBeNull()
  })
})

describe('segmentsFromWhisperJson', () => {
  const base = {
    relPath: 'Lounge/talk.mp4',
    fileHash: 'abc123',
    model: 'small',
    requestedLanguage: '',
    createdAt: '2026-08-03T20:00:00.000Z',
    transcriptionDurationMs: 654_321
  }

  it('turns each spoken segment into a timestamped record', () => {
    const segments = segmentsFromWhisperJson({
      ...base,
      json: {
        language: 'german',
        segments: [
          { start: 0, end: 4.2, text: ' Guten Abend.' },
          { start: 4.2, end: 9, text: ' Wir fangen an.' }
        ]
      }
    })
    expect(segments).toHaveLength(2)
    expect(segments.map((segment) => segment.id)).toEqual(['abc123:0', 'abc123:1'])
    expect(segments[1]).toMatchObject({ start: 4.2, end: 9, text: 'Wir fangen an.', model: 'small' })
    expect(segments[1].transcriptionDurationMs).toBe(654_321)
    // Timestamps are the whole point — the previous implementation stored
    // `start: 0, end: 0` for every file.
    expect(segments[1].start).toBeGreaterThan(0)
  })

  it('stores the detected language as a code, like an explicit one', () => {
    const auto = segmentsFromWhisperJson({ ...base, json: { language: 'german', segments: [{ start: 0, end: 1, text: 'x' }] } })
    const explicit = segmentsFromWhisperJson({
      ...base,
      requestedLanguage: 'de',
      json: { language: 'de', segments: [{ start: 0, end: 1, text: 'x' }] }
    })
    expect(auto[0].language).toBe('de')
    expect(explicit[0].language).toBe(auto[0].language)
  })

  it('falls back to the requested language when the engine reports none', () => {
    const segments = segmentsFromWhisperJson({
      ...base,
      requestedLanguage: 'fr',
      json: { segments: [{ start: 0, end: 1, text: 'x' }] }
    })
    expect(segments[0].language).toBe('fr')
  })

  it('still records a file the engine heard as one utterance', () => {
    const segments = segmentsFromWhisperJson({ ...base, json: { text: 'Just one line.' } })
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Just one line.')
  })

  it('drops empty segments rather than storing blank rows', () => {
    const segments = segmentsFromWhisperJson({
      ...base,
      json: { segments: [{ start: 0, end: 1, text: '  ' }, { start: 1, end: 2, text: 'Real.' }] }
    })
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe('Real.')
  })
})
