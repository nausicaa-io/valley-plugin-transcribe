import type { FC } from 'react'
import { api, React } from './runtime'
import { useTranscriptSurface } from './surfaces'
import { jobReadout, useTranscribeJobs } from './jobs'

/**
 * The footer's transcription chip: what a run looks like from anywhere in the
 * app.
 *
 * A transcription outlives the panel that started it — the note panel is one
 * segment among several, the sidebar closes, and the file being transcribed does
 * not have to stay open. Without a status-bar item, "how far along is the model
 * download" was answerable only by not touching anything, which is the opposite
 * of what a background job should demand.
 *
 * Idle renders **nothing**: the host treats an empty plugin footer slot as a
 * zero-width item (`.status-slot:empty`), so a silent chip costs no gap.
 * Clicking opens the file being transcribed, the same as every other status item
 * that names something.
 *
 * `React` is imported for its own sake: JSX here compiles through the *classic*
 * factory (`pluginBuildOptions`), while the typechecker runs the automatic
 * runtime — so a missing import is invisible to `tsc` and throws
 * `React is not defined` the first time a job makes this render. Pinned by the
 * `plugin views bring React into scope` suite.
 */
export const FooterProgress: FC = () => {
  const { jobs } = useTranscribeJobs()
  const job = jobs[0]
  useTranscriptSurface(job?.relPath ?? '', 'footer')
  if (!job) return null

  const { label, percent, time } = jobReadout(job)
  // One chip, however many jobs: the count says the rest without a second item.
  const more = jobs.length > 1 ? ` +${jobs.length - 1}` : ''

  return (
    <button
      type="button"
      className="status-item transcribe-footer"
      title={`${job.relPath} — ${label}${percent} · ${time}`}
      onClick={() => void api.workspace.openFile(job.relPath)}
    >
      <span className="transcribe-footer-dot" aria-hidden="true" />
      <span className="transcribe-footer-label">
        {label}
        {percent}
        {more}
      </span>
    </button>
  )
}
