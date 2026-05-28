import { ref, computed } from 'vue';

export interface UndoState {
  text: string;
  cursorPosition: number;
}

export interface UseUndoRedoOptions {
  maxHistory?: number;
  groupingDelayMs?: number;
}

export function useUndoRedo(opts?: UseUndoRedoOptions) {
  const maxHistory = opts?.maxHistory ?? 100;
  const groupingDelayMs = opts?.groupingDelayMs ?? 300;

  const history = ref<UndoState[]>([{ text: '', cursorPosition: 0 }]);
  const pointer = ref(0);
  let lastPushTime = 0;

  const canUndo = computed(() => pointer.value > 0);
  const canRedo = computed(() => pointer.value < history.value.length - 1);

  const isWordBoundary = (ch: string) => /[\s.,;:!?()[\]{}"'/\\-]/.test(ch);

  function findChangedChar(oldText: string, newText: string): string | null {
    if (newText.length > oldText.length) {
      // Character(s) inserted - find the first differing position
      for (let i = 0; i < newText.length; i++) {
        if (i >= oldText.length || newText[i] !== oldText[i]) {
          return newText[i];
        }
      }
    } else if (newText.length < oldText.length) {
      // Deletion - treat as a boundary break (new group)
      return ' ';
    }
    return null;
  }

  function pushState(text: string, cursorPosition: number) {
    const now = Date.now();
    const current = history.value[pointer.value];

    if (current && current.text === text) {
      return;
    }

    const withinGroupWindow = now - lastPushTime < groupingDelayMs;
    lastPushTime = now;

    // Detect word-boundary transitions: typing a space/punctuation always starts a new group
    let hitBoundary = false;
    if (current) {
      const ch = findChangedChar(current.text, text);
      if (ch !== null && isWordBoundary(ch)) {
        hitBoundary = true;
      }
    }

    if (withinGroupWindow && !hitBoundary && pointer.value > 0) {
      history.value[pointer.value] = { text, cursorPosition };
      return;
    }

    // Truncate any redo history beyond current pointer
    history.value.length = pointer.value + 1;

    history.value.push({ text, cursorPosition });

    // Enforce max history limit
    if (history.value.length > maxHistory) {
      history.value.splice(0, history.value.length - maxHistory);
    }

    pointer.value = history.value.length - 1;
  }

  function undo(): UndoState | null {
    if (!canUndo.value) return null;
    pointer.value--;
    return { ...history.value[pointer.value] };
  }

  function redo(): UndoState | null {
    if (!canRedo.value) return null;
    pointer.value++;
    return { ...history.value[pointer.value] };
  }

  function clear() {
    history.value = [{ text: '', cursorPosition: 0 }];
    pointer.value = 0;
    lastPushTime = 0;
  }

  function reset(text: string, cursorPosition: number) {
    history.value = [{ text, cursorPosition }];
    pointer.value = 0;
    lastPushTime = 0;
  }

  return {
    pushState,
    undo,
    redo,
    clear,
    reset,
    canUndo,
    canRedo,
  };
}
