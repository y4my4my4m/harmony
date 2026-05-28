export type InlineFormatKind = 'bold' | 'italic';

const FORMAT_MARKERS: Record<InlineFormatKind, string> = {
  bold: '**',
  italic: '*',
};

export function hasInlineFormatMarkers(
  text: string,
  start: number,
  end: number,
  kind: InlineFormatKind,
): boolean {
  if (kind === 'bold') {
    return (
      start >= 2 &&
      end + 2 <= text.length &&
      text.slice(start - 2, start) === '**' &&
      text.slice(end, end + 2) === '**'
    );
  }
  return (
    start >= 1 &&
    end + 1 <= text.length &&
    text[start - 1] === '*' &&
    text[end] === '*' &&
    (start < 2 || text[start - 2] !== '*') &&
    (end + 1 >= text.length || text[end + 1] !== '*')
  );
}

/**
 * Toggle Discord-style markdown wrappers on a plain-text selection.
 */
export function applyInlineFormatToggle(
  text: string,
  start: number,
  end: number,
  kind: InlineFormatKind,
): { text: string; selectionStart: number; selectionEnd: number } {
  const marker = FORMAT_MARKERS[kind];
  const markerLen = marker.length;
  const selStart = Math.min(start, end);
  const selEnd = Math.max(start, end);

  if (selStart === selEnd) {
    const newText = text.slice(0, selStart) + marker + marker + text.slice(selEnd);
    const cursor = selStart + markerLen;
    return { text: newText, selectionStart: cursor, selectionEnd: cursor };
  }

  if (hasInlineFormatMarkers(text, selStart, selEnd, kind)) {
    const selected = text.slice(selStart, selEnd);
    const stripLen = kind === 'bold' ? 2 : 1;
    const newText = text.slice(0, selStart - stripLen) + selected + text.slice(selEnd + stripLen);
    return {
      text: newText,
      selectionStart: selStart - stripLen,
      selectionEnd: selEnd - stripLen,
    };
  }

  const selected = text.slice(selStart, selEnd);
  const newText = text.slice(0, selStart) + marker + selected + marker + text.slice(selEnd);
  return {
    text: newText,
    selectionStart: selStart + markerLen,
    selectionEnd: selEnd + markerLen,
  };
}
