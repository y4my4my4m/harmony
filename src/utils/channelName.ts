// Channel names by type, as typed and as stored. The database applies the stored form to every
// local channel (channel_name_normalized, 20261030700001), after sanitize_profile_string: NFC,
// control, zero-width, bidi and BOM characters removed, ends trimmed.
//
//   voice (type 1)   spaces and letter case kept: a run of whitespace becomes one space, the
//                    ends are trimmed. Punctuation and emoji stay.
//   other types      lowercase; whitespace becomes '-'; ASCII characters other than a-z, 0-9,
//                    '-' and '_' go; runs of '-' become one; leading and trailing '-' go.
//                    Characters outside ASCII stay, as on Discord.
//
// While typing, a trailing separator survives so the next word can follow. Category names keep
// spaces and letter case, as the default "Text Channels" does, under the voice rule.

/** Channel type whose names keep spaces and letter case. */
export const VOICE_CHANNEL_TYPE = 1

// sanitize_profile_string's removal set, newlines included.
// eslint-disable-next-line no-control-regex -- the set is control and format characters.
const STRIPPED = new RegExp('[\\u0001-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]', 'g')
// U+0020, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000.
const SPACE = '[ \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const ONE_SPACE = new RegExp(SPACE, 'g')
const SPACE_RUN = new RegExp(`${SPACE}+`, 'g')
// Printable ASCII other than a-z, 0-9, '-' and '_'.
const ASCII_DROPPED = /[!-,./:-^`{-~]/g

function cleaned(raw: string): string {
  return raw.normalize('NFC').replace(STRIPPED, '')
}

/** True for a channel type whose name keeps spaces and letter case. */
export function namesKeepSpaces(type: number | null | undefined): boolean {
  return Number(type) === VOICE_CHANNEL_TYPE
}

/** Text-like channel name while typing. */
export function formatChannelNameInput(raw: string): string {
  return cleaned(raw)
    .toLowerCase()
    .replace(ONE_SPACE, '-')
    .replace(ASCII_DROPPED, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
}

/** Text-like channel name as created. */
export function finalizeChannelName(raw: string): string {
  return formatChannelNameInput(raw).replace(/-+$/, '')
}

/** Name that keeps spaces and case, while typing: a run of whitespace becomes one space; no leading space. */
export function formatSpacedNameInput(raw: string): string {
  return cleaned(raw).replace(SPACE_RUN, ' ').replace(/^ /, '')
}

/** Name that keeps spaces and case, as created or renamed. */
export function finalizeSpacedName(raw: string): string {
  return formatSpacedNameInput(raw).replace(/ $/, '')
}

/** A channel name of `type` while typing. */
export function formatChannelNameFor(type: number | null | undefined, raw: string): string {
  return namesKeepSpaces(type) ? formatSpacedNameInput(raw) : formatChannelNameInput(raw)
}

/** A channel name of `type` as created or renamed; channel_name_normalized gives the same. */
export function finalizeChannelNameFor(type: number | null | undefined, raw: string): string {
  return namesKeepSpaces(type) ? finalizeSpacedName(raw) : finalizeChannelName(raw)
}

/** Category name while typing. */
export function formatCategoryNameInput(raw: string): string {
  return formatSpacedNameInput(raw)
}

/** Category name as created or renamed. */
export function finalizeCategoryName(raw: string): string {
  return finalizeSpacedName(raw)
}

export type CategoryNameProblem = 'required' | 'tooShort' | 'tooLong'

/** The rule both category dialogs apply to a finalized name; the database caps it at 100. */
export function categoryNameProblem(name: string): CategoryNameProblem | null {
  if (!name) return 'required'
  if (name.length < 2) return 'tooShort'
  if (name.length > 100) return 'tooLong'
  return null
}
