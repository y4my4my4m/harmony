/**
 * Content and placement of the voice user menu and stream popovers, kept
 * free of Vue so the rules are testable.
 */

export type VoiceVolumeSection = 'mic' | 'screen';

export type VoiceMenuAction =
  | 'watch'
  | 'stop-watching'
  | 'focus'
  | 'exit-focus'
  | 'fullscreen'
  | 'pop-out'
  | 'close-pop-out'
  | 'stop-streaming'
  | 'self-mute'
  | 'self-deafen';

export interface VoiceMenuInput {
  isSelf: boolean;
  /** Tile the menu was opened from; screen puts the stream first. */
  source: 'camera' | 'screen';
  isStreaming: boolean;
  hasCamera: boolean;
  /** Stream opt-in is available (LiveKit). */
  canWatch: boolean;
  watching: boolean;
  isFocused: boolean;
  isPoppedOut: boolean;
  /** The host can take a tile to browser full screen. */
  canFullscreen: boolean;
}

export interface VoiceMenuModel {
  volumes: VoiceVolumeSection[];
  showQuality: boolean;
  actions: VoiceMenuAction[];
}

export function buildVoiceMenu(input: VoiceMenuInput): VoiceMenuModel {
  if (input.isSelf) {
    const actions: VoiceMenuAction[] = [];
    if (input.isStreaming) actions.push('stop-streaming');
    if (input.isStreaming || input.hasCamera) actions.push(input.isFocused ? 'exit-focus' : 'focus');
    actions.push('self-mute', 'self-deafen');
    return { volumes: [], showQuality: input.isStreaming || input.hasCamera, actions };
  }

  const volumes: VoiceVolumeSection[] = input.isStreaming
    ? (input.source === 'screen' ? ['screen', 'mic'] : ['mic', 'screen'])
    : ['mic'];

  const actions: VoiceMenuAction[] = [];
  const streamVisible = input.isStreaming && (!input.canWatch || input.watching);
  if (input.isStreaming && input.canWatch) {
    actions.push(input.watching ? 'stop-watching' : 'watch');
  }
  if (streamVisible || input.hasCamera) {
    actions.push(input.isFocused ? 'exit-focus' : 'focus');
    if (input.canFullscreen) actions.push('fullscreen');
  }
  if (streamVisible) {
    actions.push(input.isPoppedOut ? 'close-pop-out' : 'pop-out');
  }
  return { volumes, showQuality: false, actions };
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Top-left corner for a popover of `size`, in viewport CSS pixels.
 * A point anchor (right-click) opens down-right of the cursor; a rect
 * anchor (button) opens above it, centred, else below. The result always
 * lies inside the viewport minus `margin`.
 */
export function placePopover(anchor: Point | Rect, size: Size, viewport: Size, margin = 8): Point {
  let x: number;
  let y: number;
  if ('width' in anchor) {
    x = anchor.left + anchor.width / 2 - size.width / 2;
    const above = anchor.top - size.height - margin;
    const below = anchor.top + anchor.height + margin;
    y = above >= margin || below + size.height > viewport.height - margin ? above : below;
  } else {
    x = anchor.x;
    y = anchor.y;
    if (x + size.width > viewport.width - margin) x = anchor.x - size.width;
    if (y + size.height > viewport.height - margin) y = viewport.height - margin - size.height;
  }
  const maxX = Math.max(margin, viewport.width - margin - size.width);
  const maxY = Math.max(margin, viewport.height - margin - size.height);
  return {
    x: Math.round(Math.min(maxX, Math.max(margin, x))),
    y: Math.round(Math.min(maxY, Math.max(margin, y))),
  };
}

/** Window event asking every open voice popover to close (the overlay's Escape). */
export const VOICE_POPOVER_DISMISS = 'harmony:voice-popover-dismiss';

/** True while a voice popover is open; Escape closes it before anything else. */
export function voicePopoverOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('[data-voice-popover]');
}

export function dismissVoicePopovers(): void {
  window.dispatchEvent(new CustomEvent(VOICE_POPOVER_DISMISS));
}
