import type { MetadataPanelSegment } from '@valley/plugin-sdk'

/**
 * The descriptor `register()` hands to the `metadataPanel.segment` point.
 *
 * `fileKinds: ['audio', 'video']` is the whole reach of this feature: the note
 * panel beside an `.mp3` or an `.mp4` gains a Transcribe tab, and no other file
 * is touched. Video is not an afterthought — Whisper loads it through ffmpeg
 * exactly like audio, and a lecture recording is the case this exists for.
 *
 * A React-free `.ts` file on purpose, as `map/src/metadata.ts` explains: the
 * literal localizer only walks `.tsx`, and it would rewrite the English `label`
 * fallback (which must survive an untranslated locale) into a catalog string.
 * The body arrives as an argument, which also makes the descriptor unit-testable
 * without a DOM.
 */
export function transcribePanelSegment(render: MetadataPanelSegment['render']): MetadataPanelSegment {
  return {
    id: 'transcribe.transcript',
    labelKey: 'manifest.name',
    label: 'Transcribe',
    icon: 'text-align-left',
    fileKinds: ['audio', 'video'],
    render
  }
}
