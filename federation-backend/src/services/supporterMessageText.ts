/**
 * Supporter message text rules: public.supporter_message_problem (migration 20261106100001),
 * applied here to feeds read from another instance. NFC, no leading or trailing space, 1 to
 * `max` code points, no C0/C1 control or line/paragraph separator, no bidi mark, embedding,
 * override or isolate, no run of three combining marks from the generic combining blocks.
 */

export const SUPPORTER_MESSAGE_MAX = 50;

// eslint-disable-next-line no-control-regex -- matches control characters to refuse them
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// eslint-disable-next-line no-misleading-character-class -- matches combining marks on their own
const MARK_RUN = /[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]{3}/u;

export type TextProblem = 'type' | 'empty' | 'normalization' | 'length' | 'whitespace' | 'control' | 'bidi' | 'marks';

/** Null for valid text; otherwise the rule it breaks. Length counts code points. */
export function textProblem(value: unknown, max: number = SUPPORTER_MESSAGE_MAX): TextProblem | null {
  if (typeof value !== 'string') return 'type';
  if (value === '') return 'empty';
  if (value !== value.normalize('NFC')) return 'normalization';
  if ([...value].length > max) return 'length';
  if (value !== value.replace(/^ +| +$/g, '')) return 'whitespace';
  if (CONTROL.test(value)) return 'control';
  if (BIDI.test(value)) return 'bidi';
  if (MARK_RUN.test(value)) return 'marks';
  return null;
}

/** `value` when it passes textProblem with `max`, else null. */
export function cleanText(value: unknown, max: number): string | null {
  return textProblem(value, max) === null ? (value as string) : null;
}
