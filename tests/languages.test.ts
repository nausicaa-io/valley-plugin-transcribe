import { describe, expect, it } from 'vitest'
import { TRANSCRIBE_LANGUAGES, languageName, languageLabel } from '../src/languages'
import { WHISPER_LANGUAGE_CODES } from '../src/backend/languages'
describe('language choices', () => { it('uses unique canonical codes', () => { expect(new Set(TRANSCRIBE_LANGUAGES.map(language => language.code)).size).toBe(TRANSCRIBE_LANGUAGES.length); expect(languageName('de')).toBe('German'); expect(languageLabel({ code: 'de', name: 'German', endonym: 'Deutsch' })).toBe('Deutsch — German') }) })

it('keeps engine language normalization aligned with package language choices', () => {
  expect(TRANSCRIBE_LANGUAGES.map(({ code }) => code).filter(Boolean).sort()).toEqual(WHISPER_LANGUAGE_CODES)
})
