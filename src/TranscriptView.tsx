import type { FC } from 'react'
import type { TranscriptSegment } from './serviceClient'
import { api, React } from './runtime'
import { uiText } from './localization'
import { formatTimecode } from './follow'
import { languageName } from './languages'
import { selectTranscript, useTranscriptSurface } from './surfaces'
import { loadSegments, onChanged } from './store'

/**
 * The right-sidebar and full-page transcript lists.
 *
 * These predate the note-panel segment and stay for the two jobs it does not do:
 * the sidebar keeps a transcript open beside an unrelated file, and the page
 * lists **every** transcript in the vault at once. Transcription itself now
 * belongs to the panel segment, which is where a person is already looking when
 * they want it — so this view reads rather than writes.
 */
export const TranscriptView: FC<{ all?: boolean }> = ({ all }) => {
  const [segments, setSegments] = React.useState<TranscriptSegment[]>([])
  const [, rerender] = React.useReducer((value: number) => value + 1, 0)
  const activePath = api.getState().activePath
  const surface = all ? 'main_workspace' : 'right_sidebar'
  useTranscriptSurface(activePath ?? '', surface)

  React.useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void loadSegments().then((next) => {
        if (!disposed) setSegments(next)
      })
    }
    refresh()
    const offState = api.subscribe(refresh)
    const offLanguage = api.ui.onLanguageChanged(rerender)
    const offChanged = onChanged(refresh)
    return () => {
      disposed = true
      offState()
      offLanguage()
      offChanged()
    }
  }, [])

  const visible = (all ? segments : segments.filter((segment) => segment.file === activePath)).sort(
    (a, b) => (a.file === b.file ? a.start - b.start : a.file.localeCompare(b.file))
  )

  return (
    <section className="transcribe-view" aria-label={uiText('transcribe.title')}>
      <header className="transcribe-header">
        <strong>{all ? uiText('transcribe.allFiles') : uiText('transcribe.title')}</strong>
      </header>
      {!all && !activePath ? <p className="transcribe-empty">{uiText('transcribe.emptyFile')}</p> : null}
      {activePath && !all && visible.length === 0 ? (
        <p className="transcribe-empty">{uiText('transcribe.emptySegments')}</p>
      ) : null}
      <div className="transcribe-segments">
        {visible.map((segment) => {
          const time = formatTimecode(segment.start)
          return (
            <button
              type="button"
              className="transcribe-segment"
              key={segment.id}
              aria-label={uiText('transcribe.openAt', { time })}
              onClick={() => { selectTranscript(segment, surface); api.workspace.openFile(segment.file, { type: 'media-time', seconds: segment.start }) }}
            >
              {all ? <span className="transcribe-file">{segment.file}</span> : null}
              <span className="transcribe-time">{time}</span>
              <span className="transcribe-text">{segment.text}</span>
              <span className="transcribe-language">
                {languageName(segment.language) ?? uiText('transcribe.unknownLanguage')}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
