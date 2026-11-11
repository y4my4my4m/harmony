/**
 * Backslash escapes in message text. `\X` shows X as typed, with no markup meaning, for X in
 * ESCAPABLE. Any other backslash is literal: `C:\Users` keeps it.
 *
 * Stored text keeps the backslash, so an edit shows what was typed. Fenced and inline code are
 * verbatim: a backslash there is a backslash, and it cannot escape the closing backtick.
 *
 * Deviation from CommonMark: only characters with a meaning in Harmony markup are escapable, so
 * `\(x\)` and `\"` in prose stay as written. `\` before http(s):// keeps the URL from linking.
 * The shrug `¯\_(ツ)_/¯` keeps its backslash and draws no italics.
 */

/** Escaped characters map to U+E100 + code point: private use, one unit, no markup meaning. */
const MASK_BASE = 0xe100;
const MASK_RE = /[\uE100-\uE17F]/g;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '~', '|', '>', '#', '@', ':', '[', ']', '<', '+']);

const URL_AFTER = /^https?:\/\//i;

const maskChar = (ch: string): string => String.fromCharCode(MASK_BASE + ch.charCodeAt(0));

/** The code span opening at `at`, as an end offset; -1 when `at` opens none. */
function codeSpanEnd(text: string, at: number): number {
  if (text.startsWith('```', at)) {
    const close = text.indexOf('```', at + 3);
    return close === -1 ? -1 : close + 3;
  }
  const close = text.indexOf('`', at + 1);
  return close > at + 1 ? close + 1 : -1;
}

/** Walks `text` outside code. `keepBackslash` keeps every unit, one for one. */
function walkEscapes(text: string, keepBackslash: boolean): string {
  if (!text.includes('\\')) return text;
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '`') {
      const end = codeSpanEnd(text, i);
      if (end !== -1) {
        out.push(text.slice(i, end));
        i = end;
        continue;
      }
    }
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '_' && text[i - 1] === '¯') {
        out.push(keepBackslash ? '\\' : maskChar('\\'), maskChar('_'));
        i += 2;
        continue;
      }
      if (ESCAPABLE.has(next)) {
        if (keepBackslash) out.push('\\');
        out.push(maskChar(next));
        i += 2;
        continue;
      }
      if (URL_AFTER.test(text.slice(i + 1, i + 9))) {
        if (keepBackslash) out.push('\\');
        i += 1;
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** `text` with each escape replaced by its masked character, the backslash dropped. */
export function maskEscapes(text: string): string {
  return walkEscapes(text, false);
}

/** Masked characters back as `render` shows them. */
export function restoreMasked(text: string, render: (ch: string) => string = (ch) => ch): string {
  return text.replace(MASK_RE, (m) => render(String.fromCharCode(m.charCodeAt(0) - MASK_BASE)));
}

/** `text` with the inline markers behind masks, so no later formatting pass reads them. */
export function maskInlineMarkers(text: string): string {
  return text.replace(/[*_~|+]/g, maskChar);
}

/** Text as read: escapes resolved, code verbatim. For plain-text views of a message. */
export function unescapeMarkup(text: string): string {
  return restoreMasked(maskEscapes(text));
}

/**
 * `text` with each escaped character behind its mask and the backslash kept, so a parser's
 * offsets hold on the original. restoreMasked undoes it.
 */
export function hideEscapedChars(text: string): string {
  return walkEscapes(text, true);
}

/** The character at `at` follows an odd run of backslashes. */
export function isEscapedAt(text: string, at: number): boolean {
  let run = 0;
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) run++;
  return run % 2 === 1;
}
