/**
 * What the main window and the floating dock window (index.html?dock=1) exchange over Tauri
 * events. The dock window holds no stores, i18n or session: every string it shows arrives
 * translated in DockState.
 */

/** Main -> dock: the whole call state, sent on every change. */
export const DOCK_STATE_EVENT = 'dock://state';
/** Dock -> main: a control was used, or the window was dropped back on the app. */
export const DOCK_COMMAND_EVENT = 'dock://command';
/** Dock -> main: the dock page mounted and wants the current state. */
export const DOCK_READY_EVENT = 'dock://ready';

export interface DockParticipant {
  userId: string;
  name: string;
  avatar: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
}

export interface DockLabels {
  mute: string;
  unmute: string;
  deafen: string;
  undeafen: string;
  backToApp: string;
  leave: string;
  participants: string;
  inCall: string;
  dragHint: string;
  reconnecting: string;
}

export interface DockState {
  channelName: string;
  selfId: string;
  participants: DockParticipant[];
  muted: boolean;
  deafened: boolean;
  speakLocked: boolean;
  deafenLocked: boolean;
  encrypted: boolean;
  reconnecting: boolean;
  /** Call start, ms since the epoch. */
  startedAt: number | null;
  labels: DockLabels;
  /** The main document's <html> class, inline style and data-* attributes (theme, skin, colours). */
  html: { className: string; style: string; attributes: Record<string, string> };
}

export interface Point {
  x: number;
  y: number;
}

export type DockCommand =
  | { type: 'mute' }
  | { type: 'deafen' }
  | { type: 'leave' }
  /** Back into the app with the call view open. */
  | { type: 'expand' }
  /** Back into the app; `at` is the dock's top-left from the app window's content origin, logical px. */
  | { type: 'redock'; at?: Point };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** True when the centre of `dock` lies inside `app`. Both in the same screen units. */
export function landsOn(dock: Rect, app: Rect): boolean {
  if (app.width <= 0 || app.height <= 0) return false;
  const cx = dock.x + dock.width / 2;
  const cy = dock.y + dock.height / 2;
  return cx >= app.x && cx < app.x + app.width && cy >= app.y && cy < app.y + app.height;
}

/**
 * The dock window's top-left from the app window's content origin, logical px. `dock` and
 * `appInner` are physical screen px (Tauri outerPosition / innerPosition); `scale` is the
 * app window's scale factor.
 */
export function clientPointFor(dock: Point, appInner: Point, scale: number): Point {
  const s = scale > 0 ? scale : 1;
  return { x: (dock.x - appInner.x) / s, y: (dock.y - appInner.y) / s };
}

/** True when a pointer release at client `x`, `y` lies outside a `width` x `height` viewport. */
export function releasedOutside(x: number, y: number, width: number, height: number): boolean {
  return x < 0 || y < 0 || x >= width || y >= height;
}
