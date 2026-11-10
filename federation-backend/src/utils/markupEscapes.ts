/**
 * Backslash escapes of message text, as the reader sees them. Mirror of unescapeMarkup in
 * src/utils/markupEscapes.ts (frontend); markupEscapes.parity.test.ts asserts the two agree.
 *
 * Outbound HTML carries the character without its backslash: fediverse software has no such
 * markup. A Mention needs a tag on the receiving side, so `\\@bob` stays text there.
 */

const ESCAPABLE = new Set(['\\', '`', '*', '_', '~', '|', '>', '#', '@', ':', '[', ']', '<', '+']);
const URL_AFTER = /^https?:\/\//i;

function codeSpanEnd(text: string, at: number): number {
  if (text.startsWith('```', at)) {
    const close = text.indexOf('```', at + 3);
    return close === -1 ? -1 : close + 3;
  }
  const close = text.indexOf('`', at + 1);
  return close > at + 1 ? close + 1 : -1;
}

export function unescapeMarkup(text: string): string {
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
        out.push('\\_');
        i += 2;
        continue;
      }
      if (ESCAPABLE.has(next)) {
        out.push(next);
        i += 2;
        continue;
      }
      if (URL_AFTER.test(text.slice(i + 1, i + 9))) {
        i += 1;
        continue;
      }
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}
