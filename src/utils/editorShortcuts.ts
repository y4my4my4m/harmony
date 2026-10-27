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

// Keys an editor's ImeKeyFilter found to be the input method's.
const imeKeys = new WeakSet<object>();

/**
 * A key the input method owns: pressed while a composition is open, or the Enter that commits
 * one. Chromium sets isComposing on both. WebKit (Safari, the macOS and iOS apps) dispatches the
 * committing Enter after compositionend with isComposing false and keyCode 229; the editor's
 * ImeKeyFilter marks it.
 */
export function isImeKeyEvent(event: Pick<KeyboardEvent, 'isComposing'>): boolean {
  return event.isComposing || imeKeys.has(event);
}

type FilteredKey = Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'timeStamp'>;

export interface ImeKeyFilter {
  compositionStart(): void;
  compositionEnd(event: Pick<Event, 'timeStamp'>): void;
  /** Forgets the composition: focus left the editor. */
  reset(): void;
  /** True for a key of the input method; isImeKeyEvent then answers the same for the event. */
  isImeKey(event: FilteredKey): boolean;
}

/**
 * Composition state of one editor. keyCode 229 is the input method's only during a composition
 * and, for one key, within 500 ms after compositionend: IBus and fcitx send 229 for plain keys,
 * phone keyboards for every key. ProseMirror's inOrNearComposition applies the 500 ms window to
 * any key and on Safari alone; here it applies to keyCode 229 on every engine, as the committing
 * Enter of WebKit is the only key it is for.
 */
export function createImeKeyFilter(): ImeKeyFilter {
  let composing = false;
  let endedAt = Number.NEGATIVE_INFINITY;
  return {
    compositionStart() {
      composing = true;
    },
    compositionEnd(event) {
      composing = false;
      endedAt = event.timeStamp;
    },
    reset() {
      composing = false;
      endedAt = Number.NEGATIVE_INFINITY;
    },
    isImeKey(event) {
      if (event.isComposing || imeKeys.has(event)) return true;
      if (event.keyCode !== 229) return false;
      if (!composing) {
        if (Math.abs(event.timeStamp - endedAt) >= 500) return false;
        endedAt = Number.NEGATIVE_INFINITY;
      }
      imeKeys.add(event);
      return true;
    },
  };
}
