/**
 * The spoken languages the transcriber can be pointed at.
 *
 * This is the **display** half of Whisper's language vocabulary — what a person
 * picks from a dropdown. The engine's half (reading its detected language back
 * into a code) lives in `src/main/modules/media/whisperLanguages.ts`, because that is a
 * protocol detail of the CLI rather than a UI concern. `tests/languages.test.ts`
 * asserts the two agree on the set of codes; that is the only way they can
 * meaningfully drift.
 *
 * Nothing here is translated. Language names are **data**, not UI chrome: the
 * code is what reaches disk and the argv, and a speaker recognises the endonym
 * whatever the app's interface language happens to be. The one translated string
 * in the picker is "Auto-detect", which belongs to the UI and is a catalog key.
 *
 * A plain `.ts` module on purpose — the literal localizer only walks `.tsx`, and
 * it would otherwise pull every endonym into the catalogs as UI text.
 */

export interface TranscribeLanguage {
  /** ISO-639-1 (or Whisper's `haw`/`yue`), passed to `--language` and persisted. */
  code: string
  /** English name, so the list is searchable in the app's default language. */
  name: string
  /** The language's own name — how a speaker recognises it. */
  endonym: string
}

/** Languages Whisper supports, alphabetical by English name. */
export const TRANSCRIBE_LANGUAGES: readonly TranscribeLanguage[] = [
  { code: 'af', name: 'Afrikaans', endonym: 'Afrikaans' },
  { code: 'sq', name: 'Albanian', endonym: 'Shqip' },
  { code: 'am', name: 'Amharic', endonym: 'አማርኛ' },
  { code: 'ar', name: 'Arabic', endonym: 'العربية' },
  { code: 'hy', name: 'Armenian', endonym: 'Հայերեն' },
  { code: 'as', name: 'Assamese', endonym: 'অসমীয়া' },
  { code: 'az', name: 'Azerbaijani', endonym: 'Azərbaycanca' },
  { code: 'ba', name: 'Bashkir', endonym: 'Башҡортса' },
  { code: 'eu', name: 'Basque', endonym: 'Euskara' },
  { code: 'be', name: 'Belarusian', endonym: 'Беларуская' },
  { code: 'bn', name: 'Bengali', endonym: 'বাংলা' },
  { code: 'bs', name: 'Bosnian', endonym: 'Bosanski' },
  { code: 'br', name: 'Breton', endonym: 'Brezhoneg' },
  { code: 'bg', name: 'Bulgarian', endonym: 'Български' },
  { code: 'my', name: 'Burmese', endonym: 'မြန်မာ' },
  { code: 'yue', name: 'Cantonese', endonym: '粵語' },
  { code: 'ca', name: 'Catalan', endonym: 'Català' },
  { code: 'zh', name: 'Chinese', endonym: '中文' },
  { code: 'hr', name: 'Croatian', endonym: 'Hrvatski' },
  { code: 'cs', name: 'Czech', endonym: 'Čeština' },
  { code: 'da', name: 'Danish', endonym: 'Dansk' },
  { code: 'nl', name: 'Dutch', endonym: 'Nederlands' },
  { code: 'en', name: 'English', endonym: 'English' },
  { code: 'et', name: 'Estonian', endonym: 'Eesti' },
  { code: 'fo', name: 'Faroese', endonym: 'Føroyskt' },
  { code: 'fi', name: 'Finnish', endonym: 'Suomi' },
  { code: 'fr', name: 'French', endonym: 'Français' },
  { code: 'gl', name: 'Galician', endonym: 'Galego' },
  { code: 'ka', name: 'Georgian', endonym: 'ქართული' },
  { code: 'de', name: 'German', endonym: 'Deutsch' },
  { code: 'el', name: 'Greek', endonym: 'Ελληνικά' },
  { code: 'gu', name: 'Gujarati', endonym: 'ગુજરાતી' },
  { code: 'ht', name: 'Haitian Creole', endonym: 'Kreyòl ayisyen' },
  { code: 'ha', name: 'Hausa', endonym: 'Hausa' },
  { code: 'haw', name: 'Hawaiian', endonym: 'ʻŌlelo Hawaiʻi' },
  { code: 'he', name: 'Hebrew', endonym: 'עברית' },
  { code: 'hi', name: 'Hindi', endonym: 'हिन्दी' },
  { code: 'hu', name: 'Hungarian', endonym: 'Magyar' },
  { code: 'is', name: 'Icelandic', endonym: 'Íslenska' },
  { code: 'id', name: 'Indonesian', endonym: 'Bahasa Indonesia' },
  { code: 'it', name: 'Italian', endonym: 'Italiano' },
  { code: 'ja', name: 'Japanese', endonym: '日本語' },
  { code: 'jw', name: 'Javanese', endonym: 'Basa Jawa' },
  { code: 'kn', name: 'Kannada', endonym: 'ಕನ್ನಡ' },
  { code: 'kk', name: 'Kazakh', endonym: 'Қазақша' },
  { code: 'km', name: 'Khmer', endonym: 'ភាសាខ្មែរ' },
  { code: 'ko', name: 'Korean', endonym: '한국어' },
  { code: 'lo', name: 'Lao', endonym: 'ລາວ' },
  { code: 'la', name: 'Latin', endonym: 'Latina' },
  { code: 'lv', name: 'Latvian', endonym: 'Latviešu' },
  { code: 'ln', name: 'Lingala', endonym: 'Lingála' },
  { code: 'lt', name: 'Lithuanian', endonym: 'Lietuvių' },
  { code: 'lb', name: 'Luxembourgish', endonym: 'Lëtzebuergesch' },
  { code: 'mk', name: 'Macedonian', endonym: 'Македонски' },
  { code: 'mg', name: 'Malagasy', endonym: 'Malagasy' },
  { code: 'ms', name: 'Malay', endonym: 'Bahasa Melayu' },
  { code: 'ml', name: 'Malayalam', endonym: 'മലയാളം' },
  { code: 'mt', name: 'Maltese', endonym: 'Malti' },
  { code: 'mi', name: 'Maori', endonym: 'Te Reo Māori' },
  { code: 'mr', name: 'Marathi', endonym: 'मराठी' },
  { code: 'mn', name: 'Mongolian', endonym: 'Монгол' },
  { code: 'ne', name: 'Nepali', endonym: 'नेपाली' },
  { code: 'no', name: 'Norwegian', endonym: 'Norsk' },
  { code: 'nn', name: 'Norwegian Nynorsk', endonym: 'Nynorsk' },
  { code: 'oc', name: 'Occitan', endonym: 'Occitan' },
  { code: 'ps', name: 'Pashto', endonym: 'پښتو' },
  { code: 'fa', name: 'Persian', endonym: 'فارسی' },
  { code: 'pl', name: 'Polish', endonym: 'Polski' },
  { code: 'pt', name: 'Portuguese', endonym: 'Português' },
  { code: 'pa', name: 'Punjabi', endonym: 'ਪੰਜਾਬੀ' },
  { code: 'ro', name: 'Romanian', endonym: 'Română' },
  { code: 'ru', name: 'Russian', endonym: 'Русский' },
  { code: 'sa', name: 'Sanskrit', endonym: 'संस्कृतम्' },
  { code: 'sr', name: 'Serbian', endonym: 'Српски' },
  { code: 'sn', name: 'Shona', endonym: 'ChiShona' },
  { code: 'sd', name: 'Sindhi', endonym: 'سنڌي' },
  { code: 'si', name: 'Sinhala', endonym: 'සිංහල' },
  { code: 'sk', name: 'Slovak', endonym: 'Slovenčina' },
  { code: 'sl', name: 'Slovenian', endonym: 'Slovenščina' },
  { code: 'so', name: 'Somali', endonym: 'Soomaali' },
  { code: 'es', name: 'Spanish', endonym: 'Español' },
  { code: 'su', name: 'Sundanese', endonym: 'Basa Sunda' },
  { code: 'sw', name: 'Swahili', endonym: 'Kiswahili' },
  { code: 'sv', name: 'Swedish', endonym: 'Svenska' },
  { code: 'tl', name: 'Tagalog', endonym: 'Tagalog' },
  { code: 'tg', name: 'Tajik', endonym: 'Тоҷикӣ' },
  { code: 'ta', name: 'Tamil', endonym: 'தமிழ்' },
  { code: 'tt', name: 'Tatar', endonym: 'Татарча' },
  { code: 'te', name: 'Telugu', endonym: 'తెలుగు' },
  { code: 'th', name: 'Thai', endonym: 'ไทย' },
  { code: 'bo', name: 'Tibetan', endonym: 'བོད་སྐད' },
  { code: 'tr', name: 'Turkish', endonym: 'Türkçe' },
  { code: 'tk', name: 'Turkmen', endonym: 'Türkmençe' },
  { code: 'uk', name: 'Ukrainian', endonym: 'Українська' },
  { code: 'ur', name: 'Urdu', endonym: 'اردو' },
  { code: 'uz', name: 'Uzbek', endonym: 'Oʻzbekcha' },
  { code: 'vi', name: 'Vietnamese', endonym: 'Tiếng Việt' },
  { code: 'cy', name: 'Welsh', endonym: 'Cymraeg' },
  { code: 'yi', name: 'Yiddish', endonym: 'ייִדיש' },
  { code: 'yo', name: 'Yoruba', endonym: 'Yorùbá' }
]

/** A fresh copy in the canonical alphabetical order used by every locale. */
export function orderedLanguages(): TranscribeLanguage[] {
  return [...TRANSCRIBE_LANGUAGES]
}

/** `Deutsch — German`, the row a person reads. */
export function languageLabel(language: TranscribeLanguage): string {
  return language.endonym === language.name
    ? language.name
    : `${language.endonym} — ${language.name}`
}

/** How a stored code is shown back (footer line, settings summary). Unknown or
 *  empty codes get no name — the caller shows its own "Automatic". */
export function languageName(code: string): string | null {
  return TRANSCRIBE_LANGUAGES.find((language) => language.code === code)?.name ?? null
}
