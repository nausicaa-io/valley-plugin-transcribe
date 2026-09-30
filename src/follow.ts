/**
 * Which transcript line the player is actually inside.
 *
 * Pure on purpose: the panel's whole follow behaviour is a function of
 * (segments, playhead, window), so it is unit-testable without a DOM or a
 * running player — see `tests/follow.test.ts`.
 */

export interface FollowSpan {
  start: number
  end: number
}

export interface FollowState {
  /** Line being spoken right now, or -1 in silence/outside the transcript. */
  currentIndex: number
}

export const FOLLOW_POSITIONS = ['top', 'upper-middle', 'middle', 'lower-middle', 'bottom'] as const
export type FollowPosition = typeof FOLLOW_POSITIONS[number]

export const FOLLOW_POSITION_RATIOS: Record<FollowPosition, number> = {
  top: 0,
  'upper-middle': 0.25,
  middle: 0.5,
  'lower-middle': 0.75,
  bottom: 1
}

export function normalizeFollowPosition(value: unknown): FollowPosition {
  return FOLLOW_POSITIONS.includes(value as FollowPosition) ? value as FollowPosition : 'middle'
}

/**
 * A media position as a timecode: `m:ss`, or `h:mm:ss` once there is an hour to
 * show. Both views and the progress estimate share it — a two-hour lecture used
 * to render its last segment as `119:47`, and an hour of remaining time as
 * `60:00`, which reads as a minute past the hour rather than an hour.
 */
export function formatTimecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  const rest = `${minutes % 60}:${String(whole % 60).padStart(2, '0')}`
  if (minutes < 60) return rest
  return `${Math.floor(minutes / 60)}:${rest.padStart(5, '0')}`
}

/**
 * Start is inclusive and end is exclusive, so two touching segments switch at
 * the exact boundary. Silence highlights nothing: Follow must describe what is
 * being spoken now, not retain the last line until another one begins.
 */
export function followState(segments: readonly FollowSpan[], time: number): FollowState {
  let currentIndex = -1
  segments.forEach((segment, index) => {
    if (time >= segment.start && time < segment.end) {
      if (currentIndex === -1 || segment.start >= segments[currentIndex].start) currentIndex = index
    }
  })
  return { currentIndex }
}
