import { transcribeServices } from './serviceClient'
import type { FC, ReactElement } from 'react'
import type { TranscriptSegment } from './serviceClient'
import type { TranscribeConnection } from './serviceClient'
import { api, React } from './runtime'
import { uiText } from './localization'
import { Crosshair, Search, Stop, X } from './icons'
import { FOLLOW_POSITION_RATIOS, followState, formatTimecode } from './follow'
import { cancelJob, jobForFile, jobReadout, startTranscription, useTranscribeJobs } from './jobs'
import { languageLabel, languageName, orderedLanguages } from './languages'
import { MODEL_OPTIONS } from './models'
import { highlightPieces, searchLines } from './search'
import { useTranscriptField } from './surfaces'
import { onChanged, readSettings, segmentsForFile, writeSetting } from './store'

/**
 * What the note panel shows beside an audio or video file: its transcript.
 *
 * This is where the feature lives. The plugin's older right-sidebar view still
 * exists, but the panel is where a person already is when looking at a media
 * file — the same place that answers Duration and Size should answer "what is
 * said in it".
 *
 * Four things are worth knowing about the implementation:
 *
 * - **Two tabs, because there are two jobs.** Setting up a run (model, language,
 *   Transcribe) and reading the result are different activities, and the second
 *   one wants the whole panel. The strip is the settings kit's `Segmented` —
 *   never a local fork — stretched to the panel width by our own class.
 * - **The subject arrives as a prop.** Core resolves the panel's subject and
 *   hands it in as `ctx.relPath`; reading `api.getState().activePath` here would
 *   be a second, occasionally-disagreeing source of truth.
 * - **The running job is not ours.** It lives in `jobs.ts` so closing this panel
 *   (or the whole sidebar) neither hides nor loses the progress — reopening mid
 *   run shows the same bar the footer does.
 * - **Media time is pushed by the host.** Follow subscribes only while enabled,
 *   so video and transcript share one clock instead of racing two timers.
 */

type Tab = 'setup' | 'text'

/** The model/language line under the transcript — with auto-detect, the only
 *  place the detected language is ever visible. */
const Provenance: FC<{ segments: TranscriptSegment[] }> = ({ segments }) => {
  const first = segments[0]
  if (!first) return null
  const language = languageName(first.language)
  const createdAt = new Date(first.createdAt)
  const timestamp = Number.isNaN(createdAt.getTime())
    ? first.createdAt
    : createdAt.toLocaleString(api.ui.language())
  const duration = first.transcriptionDurationMs === undefined
    ? null
    : uiText('transcribe.transcriptionDuration', {
        time: formatTimecode(first.transcriptionDurationMs / 1000)
      })
  return (
    <div className="transcribe-provenance">
      {[
        first.model,
        language ?? uiText('transcribe.unknownLanguage'),
        uiText('transcribe.transcribedAt', { time: timestamp }),
        duration
      ].filter(Boolean).join(' · ')}
    </div>
  )
}

export const MetadataSegment: FC<{ relPath: string }> = ({ relPath }) => {
  const [segments, setSegments] = React.useState<TranscriptSegment[]>([])
  const [settings, setSettings] = React.useState(() => readSettings())
  const [model, setModel] = useTranscriptField<string>(relPath, 'model', settings.model)
  const [language, setLanguage] = useTranscriptField<string>(relPath, 'language', settings.language)
  const [follow, setFollow] = useTranscriptField<boolean>(relPath, 'follow', settings.followByDefault)
  const [tab, setTab] = useTranscriptField<Tab>(relPath, 'tab', 'setup')
  const [query, setQuery] = useTranscriptField<string>(relPath, 'query', '')
  const [mediaTime, setMediaTime] = React.useState(0)
  const [installed, setInstalled] = React.useState<{ available: boolean; ffmpeg: boolean } | null>(null)
  const [connections, setConnections] = React.useState<TranscribeConnection[]>([])
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const [chosenTab, setChosenTab] = useTranscriptField<boolean>(relPath, 'chosenTab', false)
  const [settingsError, setSettingsError] = React.useState('')

  const { Segmented, SelectField } = api.ui.settings
  const { jobs, errors } = useTranscribeJobs()
  const job = jobForFile(jobs, relPath)
  const busy = job !== undefined
  const error = settingsError || errors.get(relPath) || ''
  const saveSetting = (key: 'engine' | 'openAiConnectionId', value: string): void => {
    void writeSetting(key, value).then(() => setSettingsError('')).catch((reason) => setSettingsError(`${uiText('transcribe.failed')} ${String(reason)}`))
  }

  // Transcript + settings, reloaded whenever either changes underneath us.
  React.useEffect(() => {
    let disposed = false
    void transcribeServices(api).listConnections().then((result) => {
      if (!disposed && result.ok) {
        setConnections((result.data?.connections ?? []).filter((connection) => connection.provider === 'openai'))
      }
    })
    return () => { disposed = true }
  }, [settings.engine, settings.openAiConnectionId])

  React.useEffect(() => {
    if (settings.engine !== 'local') setInstalled(null)
    let disposed = false
    const refresh = (): void => {
      void segmentsForFile(relPath).then((next) => {
        if (disposed) return
        setSegments(next)
        // A file that already has a transcript opens on it; one that does not
        // opens on the controls that produce it. Only until the person picks a
        // tab themselves — after that the choice is theirs for as long as the
        // file stays open.
        if (!chosenTab) setTab(next.length ? 'text' : 'setup')
      })
      if (!disposed) setSettings(readSettings())
    }
    refresh()
    const off = onChanged(refresh)
    return () => {
      disposed = true
      off()
    }
  }, [relPath, settings.engine, chosenTab, setTab])

  // Whether Whisper is actually on this machine. Asked once per mount so the
  // empty state can say "install it" instead of letting the button fail.
  React.useEffect(() => {
    let disposed = false
    void transcribeServices(api).status(settings.whisperPath).then((result) => {
      if (!disposed && result.ok && result.data) {
        setInstalled({ available: result.data.available, ffmpeg: result.data.ffmpeg })
      }
    })
    return () => {
      disposed = true
    }
  }, [settings.engine, settings.whisperPath])

  // Subscribe only while following; the host publishes at a capped live rate
  // while media plays and immediately on seeks.
  React.useEffect(() => {
    if (!follow || segments.length === 0) return
    setMediaTime(api.workspace.getMediaTime() ?? 0)
    return api.workspace.onMediaTimeChanged((seconds) => setMediaTime(seconds ?? 0))
  }, [follow, segments.length])

  const { currentIndex } = React.useMemo(
    () => followState(segments, mediaTime),
    [segments, mediaTime]
  )

  const hits = React.useMemo(
    () => searchLines(segments.map((segment) => segment.text), query),
    [segments, query]
  )

  // Follow means the current line owns the viewport, not merely that it remains
  // somewhere inside it. This runs only when the segment changes.
  React.useEffect(() => {
    if (!follow || tab !== 'text' || currentIndex < 0) return
    const list = listRef.current
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${currentIndex}"]`)
    if (!list || !row) return
    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const rowTop = list.scrollTop + rowRect.top - listRect.top
    const available = Math.max(0, list.clientHeight - rowRect.height)
    const target = rowTop - available * FOLLOW_POSITION_RATIOS[settings.followPosition]
    const top = Math.min(Math.max(0, target), Math.max(0, list.scrollHeight - list.clientHeight))
    list.scrollTo({ top, behavior: 'smooth' })
  }, [follow, currentIndex, settings.followPosition, tab])

  const pickTab = (next: Tab): void => {
    setChosenTab(true)
    setTab(next)
  }

  const transcribe = async (): Promise<void> => {
    await startTranscription({
      relPath,
      model,
      language,
      durationMs: (api.workspace.getMediaDuration() ?? 0) * 1000
    })
    // The result is what someone pressed the button for — show it rather than
    // leaving them on the empty controls pane they just used.
    if (!chosenTab) setTab('text')
  }

  const percent = job?.percent
  const roundedPercent = percent === undefined
    ? undefined
    : Math.min(100, Math.max(0, Math.round(percent)))
  const readout = job ? jobReadout(job) : null
  const usableConnections = connections.filter((connection) => connection.configured)
  const cloudReady = usableConnections.some((connection) => connection.id === settings.openAiConnectionId)

  return (
    <div className="right-panel-body transcribe-meta">
      <div className="transcribe-meta-tabs">
        <Segmented
          value={tab}
          onChange={(value) => pickTab(value as Tab)}
          options={[
            { value: 'text', label: uiText('transcribe.tabText') },
            { value: 'setup', label: uiText('transcribe.tabSetup') }
          ]}
          ariaLabel={uiText('transcribe.tabsLabel')}
        />
      </div>

      {tab === 'setup' ? (
        <div className="transcribe-meta-pane">
          <SelectField
            value={settings.engine}
            onChange={(value) => saveSetting('engine', value)}
            options={[
              { value: 'local', label: uiText('transcribe.engineLocal') },
              { value: 'openai', label: uiText('transcribe.engineOpenAi') }
            ]}
            ariaLabel={uiText('transcribe.engineLabel')}
            disabled={busy}
            className="transcribe-meta-select"
          />
          {settings.engine === 'local' ? (
            <SelectField
              value={model}
              onChange={setModel}
              options={MODEL_OPTIONS.map((option) => ({
                value: option.value,
                label: api.ui.t(option.labelKey)
              }))}
              ariaLabel={uiText('transcribe.modelLabel')}
              disabled={busy}
              className="transcribe-meta-select"
            />
          ) : (
            <SelectField
              value={cloudReady ? settings.openAiConnectionId : ''}
              onChange={(value) => saveSetting('openAiConnectionId', value)}
              options={usableConnections.map((connection) => ({
                value: connection.id,
                label: connection.label || connection.providerName
              }))}
              placeholder={uiText('transcribe.openAiChooseConnection')}
              ariaLabel={uiText('transcribe.openAiConnectionLabel')}
              disabled={busy}
              className="transcribe-meta-select"
            />
          )}
          <SelectField
            value={language}
            onChange={setLanguage}
            options={[
              { value: '', label: uiText('transcribe.autoDetect') },
              ...orderedLanguages().map((entry) => ({ value: entry.code, label: languageLabel(entry) }))
            ]}
            ariaLabel={uiText('transcribe.languageLabel')}
            disabled={busy}
            className="transcribe-meta-select"
          />
          <button
            type="button"
            className="transcribe-meta-run"
            onClick={() => void (job ? cancelJob(job.jobId) : transcribe())}
            // Nothing to press while the engine is coming down — it can take a
            // few seconds, and a live Cancel there just repeats a sent kill.
            disabled={job?.cancelling || (!busy && (
              settings.engine === 'local'
                ? installed !== null && !installed.available
                : !cloudReady
            ))}
          >
            {busy ? <Stop /> : null}
            {job?.cancelling
              ? uiText('transcribe.cancelling')
              : busy
                ? uiText('transcribe.cancel')
                : segments.length
                  ? uiText('transcribe.retranscribe')
                  : uiText('transcribe.transcribe')}
          </button>

          {/* Directly under the button that started it. Elsewhere in the app the
              footer chip is what reports the same run. */}
          {busy && readout ? (
            <div className="transcribe-meta-progress">
              <div
                className="transcribe-meta-bar"
                role="progressbar"
                aria-label={readout.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={roundedPercent}
              >
                <div
                  className="transcribe-meta-bar-fill"
                  style={roundedPercent === undefined ? undefined : { width: `${roundedPercent}%` }}
                  data-indeterminate={percent === undefined ? true : undefined}
                />
              </div>
              <span className="transcribe-meta-stage">
                {readout.label}
                {readout.percent}
                {` · ${readout.time}`}
              </span>
            </div>
          ) : null}

          {error ? (
            <p className="transcribe-meta-error" role="alert">
              {error}
            </p>
          ) : null}

          {settings.engine === 'local' && installed && !installed.available ? (
            <p className="transcribe-meta-hint">{uiText('transcribe.notInstalled')}</p>
          ) : null}
          {settings.engine === 'local' && installed?.available && !installed.ffmpeg ? (
            <p className="transcribe-meta-hint">{uiText('transcribe.ffmpegMissing')}</p>
          ) : null}
          {settings.engine === 'openai' && !cloudReady ? (
            <p className="transcribe-meta-hint">
              {uiText('transcribe.openAiNeedsConnection')}{' '}
              <button type="button" className="transcribe-meta-link" onClick={() => api.workspace.openSettings('ai-providers')}>
                {uiText('transcribe.manageAiProviders')}
              </button>
            </p>
          ) : null}
          <Provenance segments={segments} />
        </div>
      ) : (
        <div className="transcribe-meta-pane transcribe-meta-pane--text">
          <div className="transcribe-meta-buttons">
            <div className="transcribe-search">
              <Search className="transcribe-search-icon" />
              <input
                type="text"
                className="transcribe-search-input"
                value={query}
                placeholder={uiText('transcribe.searchPlaceholder')}
                aria-label={uiText('transcribe.searchPlaceholder')}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query) {
                    // Ours to handle only while there is something to clear —
                    // otherwise Escape belongs to whatever layer is above us.
                    event.stopPropagation()
                    setQuery('')
                  }
                }}
              />
              {query ? (
                <>
                  <span className="transcribe-search-count">
                    {hits.length}/{segments.length}
                  </span>
                  <button
                    type="button"
                    className="transcribe-search-clear"
                    aria-label={uiText('transcribe.searchClear')}
                    title={uiText('transcribe.searchClear')}
                    onClick={() => setQuery('')}
                  >
                    <X />
                  </button>
                </>
              ) : null}
            </div>
            <button
              type="button"
              className={`transcribe-meta-follow${follow ? ' is-on' : ''}`}
              aria-pressed={follow}
              aria-label={uiText('transcribe.follow')}
              title={uiText('transcribe.follow')}
              onClick={() => setFollow((value) => !value)}
            >
              <Crosshair />
            </button>
          </div>

          {segments.length === 0 && !busy ? (
            <p className="transcribe-meta-hint">{uiText('transcribe.emptySegments')}</p>
          ) : null}
          {segments.length > 0 && hits.length === 0 ? (
            <p className="transcribe-meta-hint">{uiText('transcribe.searchEmpty', { query })}</p>
          ) : null}

          <div className="transcribe-meta-lines" ref={listRef}>
            {hits.map(({ index, ranges }) => {
              const segment = segments[index]
              return (
                <button
                  key={segment.id}
                  type="button"
                  data-index={index}
                  className={[
                    'transcribe-meta-line',
                    follow && index === currentIndex ? 'is-current' : '',
                    follow && index !== currentIndex ? 'is-dim' : ''
                  ].filter(Boolean).join(' ')}
                  aria-label={uiText('transcribe.openAt', { time: formatTimecode(segment.start) })}
                  onClick={() =>
                    api.workspace.openFile(segment.file, { type: 'media-time', seconds: segment.start })
                  }
                >
                  <span className="transcribe-meta-time">{formatTimecode(segment.start)}</span>
                  <span className="transcribe-meta-text">
                    {highlightPieces(segment.text, ranges).map((piece, pieceIndex) =>
                      piece.hit ? (
                        <mark className="transcribe-meta-hit" key={pieceIndex}>
                          {piece.text}
                        </mark>
                      ) : (
                        <span key={pieceIndex}>{piece.text}</span>
                      )
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Wrapper the descriptor renders, so `segment.render(ctx)` returns an element
 *  rather than calling a hook-bearing function inline. */
export function renderMetadataSegment(relPath: string): ReactElement {
  return <MetadataSegment relPath={relPath} key={relPath} />
}
