import type { ReactElement, ReactNode } from 'react'
import { React } from './runtime'

/**
 * Inline SVG glyphs drawn with the host's React (Lucide-style). Plugins cannot
 * bundle react-icons — it would pull in a second React — so the glyphs are
 * hand-rolled and stay monochrome via `currentColor`. Each is a component so the
 * JSX only runs at render time, never at module top level.
 *
 * The manifest icon (`text-align-left`) is a different mechanism: that name is
 * resolved by the host's own table. These are body glyphs.
 */
type IconProps = { className?: string }

const Svg = (props: IconProps & { children: ReactNode }): ReactElement =>
  React.createElement(
    'svg',
    {
      className: props.className,
      width: '1em',
      height: '1em',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true
    },
    props.children
  )

/** Follow-playback toggle: a reticle sighting the line being spoken. */
export const Crosshair = (props: IconProps): ReactElement => (
  <Svg className={props.className}>
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />
  </Svg>
)

/** Stop a running transcription. */
export const Stop = (props: IconProps): ReactElement => (
  <Svg className={props.className}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
)

/** The search field's leading glyph. */
export const Search = (props: IconProps): ReactElement => (
  <Svg className={props.className}>
    <circle cx="11" cy="11" r="7" />
    <path d="m16.5 16.5 4 4" />
  </Svg>
)

/** Clear the search field. */
export const X = (props: IconProps): ReactElement => (
  <Svg className={props.className}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)
