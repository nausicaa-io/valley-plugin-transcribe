import { describe, expect, it } from 'vitest'
import {
  FOLLOW_POSITION_RATIOS,
  followState,
  formatTimecode,
  normalizeFollowPosition
} from '../src/follow'

/** Four lines with a deliberate 2 s silence between the second and the third. */
const LINES = [
  { start: 0, end: 4 },
  { start: 4, end: 8 },
  { start: 10, end: 14 },
  { start: 14, end: 20 }
]

describe('followState', () => {
  it('finds the line being spoken', () => {
    expect(followState(LINES, 5).currentIndex).toBe(1)
    expect(followState(LINES, 11.5).currentIndex).toBe(2)
  })

  it('highlights nothing during silence', () => {
    expect(followState(LINES, 9).currentIndex).toBe(-1)
  })

  it('has no current line before the first one starts', () => {
    expect(followState(LINES, -1).currentIndex).toBe(-1)
  })

  it('highlights nothing past the end of the transcript', () => {
    expect(followState(LINES, 999).currentIndex).toBe(-1)
  })

  it('switches to the next segment at an exact shared boundary', () => {
    expect(followState(LINES, 4).currentIndex).toBe(1)
  })

  it('says nothing about an empty transcript', () => {
    expect(followState([], 5)).toEqual({ currentIndex: -1 })
  })
})

describe('normalizeFollowPosition', () => {
  it('keeps the five automatic-scroll anchors', () => {
    expect(normalizeFollowPosition('top')).toBe('top')
    expect(normalizeFollowPosition('upper-middle')).toBe('upper-middle')
    expect(normalizeFollowPosition('middle')).toBe('middle')
    expect(normalizeFollowPosition('lower-middle')).toBe('lower-middle')
    expect(normalizeFollowPosition('bottom')).toBe('bottom')
  })

  it('spaces the anchors evenly through the viewport', () => {
    expect(Object.values(FOLLOW_POSITION_RATIOS)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('defaults old or malformed settings to the middle', () => {
    expect(normalizeFollowPosition(undefined)).toBe('middle')
    expect(normalizeFollowPosition('center')).toBe('middle')
  })
})

describe('formatTimecode', () => {
  it('is m:ss for anything under an hour', () => {
    expect(formatTimecode(0)).toBe('0:00')
    expect(formatTimecode(9.7)).toBe('0:09')
    expect(formatTimecode(605)).toBe('10:05')
    expect(formatTimecode(3599)).toBe('59:59')
  })

  it('grows an hours field rather than counting past 60 minutes', () => {
    // A two-hour wildlife recording used to end at `119:47`, and an hour of remaining time
    // read as `60:00` — a minute past the hour, not an hour.
    expect(formatTimecode(3600)).toBe('1:00:00')
    expect(formatTimecode(3661)).toBe('1:01:01')
    expect(formatTimecode(7187)).toBe('1:59:47')
  })

  it('never renders a negative position', () => {
    expect(formatTimecode(-5)).toBe('0:00')
  })
})
