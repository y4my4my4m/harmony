/**
 * Discord-style blockquote parsing for chat/DM messages.
 *
 * Supports:
 * - `> quoted line` - requires a space after `>` (Discord behavior). `>foo`
 *   without a space is NOT a quote; it's left as plain text (or greentext if
 *   the user has the option enabled).
 * - consecutive `> ` lines grouped into one blockquote
 * - `>>> multi-line block` - quotes that line (after prefix) and all following
 *   lines. Requires a space after `>>>` for the same reason.
 */

export interface BlockquoteOptions {
  /**
   * When true, lines beginning with `>` (no space) render as imageboard-style
   * greentext rather than plain text. Lines with `> ` are always blockquotes
   * regardless of this option.
   */
  greentext?: boolean;
}

export type BlockSegment =
  | { type: 'text'; content: string }
  | { type: 'greentext'; lines: string[] }
  | { type: 'blockquote'; lines: string[]; multiLine?: boolean };

// `> ` followed by NON-EMPTY content. The full `> ` (space, no content)
// and bare `>` (no space) are NOT blockquotes - they're incomplete
// markers the user is still typing. Promoting them eagerly rewrites
// the editor DOM into a styled scaffold mid-keystroke, strands the
// cursor inside a zero-width content span, and the next keystroke can
// end up inside the marker rather than the content, dropping input.
const SINGLE_QUOTE_LINE = /^> (.+)$/;

export function isSingleQuoteLine(line: string): boolean {
  if (isMultiQuoteStart(line)) return false;
  return SINGLE_QUOTE_LINE.test(line);
}

export function stripSingleQuotePrefix(line: string): string {
  const match = line.match(SINGLE_QUOTE_LINE);
  return match ? match[1] : line;
}

export function isMultiQuoteStart(line: string): boolean {
  // Match `>>> something` with at least one trailing non-space char.
  // A bare `>>>` or `>>> ` with no content is incomplete - see the
  // rationale on `isSingleQuoteLine` above for why we don't promote
  // it eagerly.
  return /^>>> .+/.test(line);
}

export function stripMultiQuotePrefix(line: string): string {
  return line.slice(4);
}

// Imageboard-style greentext: EXACTLY ONE `>` followed by a non-space,
// non-`>` character at the start of a line.
//
// `>>foo` / `>>>foo` (and longer) are NOT greentext - those are reply
// chains (`>>123` is the imageboard reply syntax) or partially-typed
// multi-line blockquote markers (`>>> body`). Promoting them to greentext
// would (a) confuse anyone used to imageboard conventions and (b) cause a
// visible green flash as the user types `>>>` toward a multi-line quote.
//
// Also explicitly excluded: `> foo` (single-`>` followed by SPACE - that's
// a blockquote, handled separately), bare `>` / `>>>` (incomplete markers
// the user is still typing), `>>> foo` (multi-line blockquote start),
// and any text where the line doesn't START with `>` (so the `>` in
// `<https://example.com>foo` doesn't get interpreted because the line
// starts with `<`).
const GREENTEXT_LINE = /^>[^>\s]/;

export function isGreentextLine(line: string): boolean {
  if (!line.startsWith('>')) return false;
  if (isMultiQuoteStart(line)) return false;
  return GREENTEXT_LINE.test(line);
}

const FENCE_LINE = /^```/;

export function splitIntoBlockSegments(
  text: string,
  options: BlockquoteOptions = {},
): BlockSegment[] {
  if (!text) return [];

  const greentextEnabled = options.greentext ?? false;
  const lines = text.split('\n');
  const segments: BlockSegment[] = [];
  let textBuffer: string[] = [];
  let insideFence = false;

  const flushText = () => {
    if (textBuffer.length === 0) return;
    segments.push({ type: 'text', content: textBuffer.join('\n') });
    textBuffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Track fenced code blocks so `>` inside them is treated as literal text.
    if (FENCE_LINE.test(line)) {
      insideFence = !insideFence;
      textBuffer.push(line);
      i++;
      continue;
    }

    if (!insideFence && isMultiQuoteStart(line)) {
      flushText();
      const quoteLines = [stripMultiQuotePrefix(line)];
      i++;
      while (i < lines.length) {
        quoteLines.push(lines[i]);
        i++;
      }
      segments.push({ type: 'blockquote', lines: quoteLines, multiLine: true });
      continue;
    }

    if (!insideFence && isSingleQuoteLine(line)) {
      flushText();
      const quoteLines: string[] = [];
      while (i < lines.length && isSingleQuoteLine(lines[i])) {
        quoteLines.push(stripSingleQuotePrefix(lines[i]));
        i++;
      }
      segments.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    if (!insideFence && greentextEnabled && isGreentextLine(line)) {
      flushText();
      const greenLines: string[] = [];
      while (i < lines.length && isGreentextLine(lines[i])) {
        greenLines.push(lines[i]);
        i++;
      }
      segments.push({ type: 'greentext', lines: greenLines });
      continue;
    }

    textBuffer.push(line);
    i++;
  }

  flushText();
  return segments;
}

/**
 * Render text with Discord-style blockquotes. `renderLine` receives each logical
 * line (already stripped of `>` / `>>>` prefixes for blockquote content; for
 * greentext lines the leading `>` is preserved).
 */
export function renderTextWithBlockquotes(
  text: string,
  renderLine: (line: string) => string = (line) => line,
  options: BlockquoteOptions = {},
): string {
  const segments = splitIntoBlockSegments(text, options);
  if (segments.length === 0) return '';

  return segments
    .map((segment) => {
      if (segment.type === 'text') {
        if (!segment.content) return '';
        return segment.content.split('\n').map(renderLine).join('<br>');
      }

      if (segment.type === 'greentext') {
        return segment.lines
          .map((line) => `<span class="md-greentext">${renderLine(line)}</span>`)
          .join('<br>');
      }

      const inner = segment.lines.map(renderLine).join('<br>');
      return `<blockquote class="md-blockquote">${inner}</blockquote>`;
    })
    .filter((part) => part.length > 0)
    .join('<br>');
}
