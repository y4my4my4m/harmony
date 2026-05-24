/**
 * Discord-style blockquote parsing for chat/DM messages.
 *
 * Supports:
 * - `> quoted line` (optional space after `>`)
 * - consecutive `>` lines grouped into one blockquote
 * - `>>> multi-line block` — quotes that line (after prefix) and all following lines
 */

export type BlockSegment =
  | { type: 'text'; content: string }
  | { type: 'blockquote'; lines: string[]; multiLine?: boolean };

const SINGLE_QUOTE_LINE = /^> ?(.*)$/;

export function isSingleQuoteLine(line: string): boolean {
  if (isMultiQuoteStart(line)) return false;
  return line === '>' || SINGLE_QUOTE_LINE.test(line);
}

export function stripSingleQuotePrefix(line: string): string {
  if (line === '>') return '';
  const match = line.match(SINGLE_QUOTE_LINE);
  return match ? match[1] : line;
}

export function isMultiQuoteStart(line: string): boolean {
  return line.startsWith('>>>');
}

export function stripMultiQuotePrefix(line: string): string {
  return line.slice(3).replace(/^ /, '');
}

const FENCE_LINE = /^```/;

export function splitIntoBlockSegments(text: string): BlockSegment[] {
  if (!text) return [];

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

    textBuffer.push(line);
    i++;
  }

  flushText();
  return segments;
}

/**
 * Render text with Discord-style blockquotes. `renderLine` receives each logical
 * line (already stripped of `>` / `>>>` prefixes for blockquote content).
 */
export function renderTextWithBlockquotes(
  text: string,
  renderLine: (line: string) => string = (line) => line,
): string {
  const segments = splitIntoBlockSegments(text);
  if (segments.length === 0) return '';

  return segments
    .map((segment) => {
      if (segment.type === 'text') {
        if (!segment.content) return '';
        return segment.content.split('\n').map(renderLine).join('<br>');
      }

      const inner = segment.lines.map(renderLine).join('<br>');
      return `<blockquote class="md-blockquote">${inner}</blockquote>`;
    })
    .filter((part) => part.length > 0)
    .join('<br>');
}
