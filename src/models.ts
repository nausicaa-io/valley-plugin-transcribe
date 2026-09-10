/**
 * The Whisper models offered in the UI.
 *
 * The main-process driver keeps its own allowlist and validates against it — a
 * model name reaches an argv, so the renderer is not the place that decides what
 * is acceptable. This list is what a person picks from, and the labels carry the
 * two facts that actually drive the choice: how large the download is and how
 * much slower it runs. Weights land in `~/.cache/whisper` on first use and are
 * shared with every other Whisper install on the machine.
 *
 * A plain `.ts` module: the manifest imports it (so it must stay React-free) and
 * the literal localizer only walks `.tsx`, which is what keeps these English
 * fallbacks out of the catalogs.
 */

export interface TranscribeModel {
  value: string
  /** English fallback, rendered through `manifestText(labelKey, label)`. */
  label: string
  labelKey: string
}

export const MODEL_OPTIONS: readonly TranscribeModel[] = [
  { value: 'tiny', label: 'Tiny — 75 MB, fastest', labelKey: 'plugin.transcribe.model.tiny' },
  { value: 'base', label: 'Base — 142 MB', labelKey: 'plugin.transcribe.model.base' },
  { value: 'small', label: 'Small — 466 MB, balanced', labelKey: 'plugin.transcribe.model.small' },
  { value: 'medium', label: 'Medium — 1.5 GB', labelKey: 'plugin.transcribe.model.medium' },
  { value: 'large-v3', label: 'Large — 2.9 GB, most accurate', labelKey: 'plugin.transcribe.model.large' },
  { value: 'turbo', label: 'Turbo — 1.6 GB, large quality at speed', labelKey: 'plugin.transcribe.model.turbo' }
]

export const DEFAULT_MODEL = 'small'

/** A persisted model that is no longer offered falls back rather than failing
 *  the run: the value is only a default, and the driver would reject it. */
export function knownModel(value: unknown): string {
  return typeof value === 'string' && MODEL_OPTIONS.some((model) => model.value === value)
    ? value
    : DEFAULT_MODEL
}
