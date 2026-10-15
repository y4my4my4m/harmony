import { onBeforeUnmount, ref } from 'vue';

/**
 * Drag a voice participant row onto another voice channel's row in the
 * channel list to move them (MOVE_MEMBERS), as in Discord. Pointer-driven,
 * like the channel list's own reordering: Tauri's WebView2 swallows HTML5
 * drag and drop on Windows. The voice menu's Move to is the keyboard path.
 *
 * A drop target is a `.channel-wrapper[data-channel-id]` holding a voice row
 * (ChannelSidebar), other than the source channel.
 */

/** Pointer travel before a press becomes a drag, px. */
export const VOICE_DRAG_THRESHOLD_PX = 5;

export interface VoiceMemberDragOptions {
  /** Channel the rows belong to; null disables dragging. */
  channelId: () => string | null;
  canDrag: (userId: string) => boolean;
  label: (userId: string) => string;
  drop: (userId: string, channelId: string) => void;
}

const TARGET_STYLE = { outline: '2px dashed var(--harmony-primary)', outlineOffset: '-2px' };

export function useVoiceMemberDrag(options: VoiceMemberDragOptions) {
  const dragging = ref<string | null>(null);
  let press: { x: number; y: number; userId: string } | null = null;
  let ghost: HTMLElement | null = null;
  let target: HTMLElement | null = null;
  let swallowClickUntil = 0;

  function dropTargetAt(x: number, y: number): HTMLElement | null {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const wrapper = hit?.closest('.channel-wrapper[data-channel-id]') as HTMLElement | null;
    if (!wrapper?.querySelector('.channel-row.voice-row')) return null;
    if (!wrapper.dataset.channelId || wrapper.dataset.channelId === options.channelId()) return null;
    return wrapper;
  }

  function mark(next: HTMLElement | null): void {
    if (next === target) return;
    const previousRow = target?.querySelector<HTMLElement>('.channel-row');
    if (previousRow) {
      previousRow.style.outline = '';
      previousRow.style.outlineOffset = '';
    }
    target?.removeAttribute('data-voice-drop-target');
    target = next;
    if (!next) return;
    next.setAttribute('data-voice-drop-target', 'true');
    const row = next.querySelector<HTMLElement>('.channel-row');
    if (row) Object.assign(row.style, TARGET_STYLE);
  }

  function showGhost(text: string, x: number, y: number): void {
    ghost = document.createElement('div');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.dataset.testid = 'voice-drag-ghost';
    ghost.textContent = text;
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${x + 12}px`,
      top: `${y + 12}px`,
      zIndex: '10010',
      pointerEvents: 'none',
      padding: '4px 10px',
      borderRadius: 'var(--radius-base, 6px)',
      background: 'var(--background-floating)',
      color: 'var(--text-primary)',
      boxShadow: 'var(--shadow-large)',
      fontSize: 'var(--font-size-sm)',
      whiteSpace: 'nowrap',
    });
    document.body.appendChild(ghost);
  }

  function end(commit: boolean): void {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    const userId = dragging.value;
    const channelId = target?.dataset.channelId ?? null;
    mark(null);
    ghost?.remove();
    ghost = null;
    if (userId) swallowClickUntil = Date.now() + 300;
    dragging.value = null;
    press = null;
    if (commit && userId && channelId) options.drop(userId, channelId);
  }

  function onMove(event: PointerEvent): void {
    if (!press) return;
    if (!dragging.value) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < VOICE_DRAG_THRESHOLD_PX) return;
      dragging.value = press.userId;
      showGhost(options.label(press.userId), event.clientX, event.clientY);
    }
    if (ghost) {
      ghost.style.left = `${event.clientX + 12}px`;
      ghost.style.top = `${event.clientY + 12}px`;
    }
    mark(dropTargetAt(event.clientX, event.clientY));
  }

  function onUp(): void {
    end(true);
  }

  function onCancel(): void {
    end(false);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !dragging.value) return;
    event.preventDefault();
    event.stopPropagation();
    end(false);
  }

  /** Bound to a row's pointerdown. Keeps the channel list's reordering from taking the press. */
  function onPointerDown(event: PointerEvent, userId: string): void {
    if (event.button !== 0 || !options.channelId() || !options.canDrag(userId)) return;
    event.stopPropagation();
    press = { x: event.clientX, y: event.clientY, userId };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }

  /** Bound to mousedown and touchstart: the list's reordering listens to those where pointer events are off. */
  function shield(event: Event, userId: string): void {
    if (options.channelId() && options.canDrag(userId)) event.stopPropagation();
  }

  /** True for the click a finished drag leaves behind; the row ignores it. */
  function swallowsClick(): boolean {
    return Date.now() < swallowClickUntil;
  }

  onBeforeUnmount(() => end(false));

  return { dragging, onPointerDown, shield, swallowsClick };
}
