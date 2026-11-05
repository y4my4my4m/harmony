/**
 * Supporter message rules as public.supporter_message_problem (migration 20261106100001)
 * applies them, for feedback while typing; the database decides. Length counts code points
 * after NFC.
 */

export const SUPPORTER_MESSAGE_MAX = 50

// eslint-disable-next-line no-control-regex -- matches control characters to refuse them
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u
// eslint-disable-next-line no-misleading-character-class -- matches combining marks on their own
const MARK_RUN = /[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]{3}/u

export type SupporterMessageProblem = 'empty' | 'length' | 'control' | 'bidi' | 'marks'

/** The text the database stores for `input`: NFC, outer spaces trimmed. */
export function normalizeSupporterMessage(input: string): string {
  return input.normalize('NFC').replace(/^ +| +$/g, '')
}

export function supporterMessageLength(input: string): number {
  return [...normalizeSupporterMessage(input)].length
}

export function supporterMessageProblem(input: string): SupporterMessageProblem | null {
  const body = normalizeSupporterMessage(input)
  if (body === '') return 'empty'
  if ([...body].length > SUPPORTER_MESSAGE_MAX) return 'length'
  if (CONTROL.test(body)) return 'control'
  if (BIDI.test(body)) return 'bidi'
  if (MARK_RUN.test(body)) return 'marks'
  return null
}
