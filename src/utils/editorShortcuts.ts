export type HistoryShortcut = 'undo' | 'redo';

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/**
 * Letter of a Ctrl/Cmd chord, lower case. `key` is upper case under Shift or
 * Caps Lock; a non-Latin layout reports its own glyph, so the physical `code`
 * stands in.
 */
function chordLetter(event: ShortcutEvent): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(event.code);
  return physical ? physical[1].toLowerCase() : null;
}

/** Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo. */
export function historyShortcut(event: ShortcutEvent): HistoryShortcut | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const letter = chordLetter(event);
  if (letter === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (letter === 'y' && !event.shiftKey) return 'redo';
  return null;
}

/**
 * A key the input method owns: pressed while a composition is open, or the Enter that commits
 * one. WebKit (Safari, the macOS and iOS apps) dispatches that Enter's keydown after
 * compositionend, with isComposing false and keyCode 229; Chromium sets isComposing.
 */
export function isImeKeyEvent(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229;
}
