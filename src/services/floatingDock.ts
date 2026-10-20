/**
 * The floating voice dock (desktop app): the minimized call controls torn off into a
 * borderless, always-on-top window (src-tauri/src/float_dock.rs) that stays over other
 * applications. That window runs FloatingDockApp.vue without stores or i18n; this module
 * sends it the call's state and runs the commands it sends back. Dropping the window back
 * on the app, or Back to the app, returns the dock to the main window.
 */

import { ref, watch, type WatchStopHandle } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriRuntime } from '@/services/instanceConfig';
import { isMobileUserAgent } from '@/utils/platform';
import { nativeZoomFactor } from '@/utils/appZoom';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { debug } from '@/utils/debug';
import { SPEAKING_LEVEL } from '@/services/voice/speakingDetector';
import {
  DOCK_COMMAND_EVENT,
  DOCK_READY_EVENT,
  DOCK_STATE_EVENT,
  type DockCommand,
  type DockParticipant,
  type DockState,
  type Point,
} from '@/overlay/floatingDockProtocol';

/** Label of the dock window (FLOAT_DOCK_LABEL). */
const DOCK_WINDOW = 'dock';
// State pushes are coalesced to one per interval, ms: speaking flips arrive per 50 ms tick.
const PUSH_INTERVAL_MS = 40;

export const floatingDockActive = ref(false);

type DockCommandHandler = (command: DockCommand) => void;
const commandHandlers = new Set<DockCommandHandler>();

/** Commands the main window's dock component acts on: redock and expand. */
export function onFloatingDockCommand(handler: DockCommandHandler): () => void {
  commandHandlers.add(handler);
  return () => commandHandlers.delete(handler);
}

export function floatingDockSupported(): boolean {
  return isTauriRuntime() && !isMobileUserAgent();
}

/** What building the state needs; loaded when the dock first floats, so the in-app dock stays light. */
export interface DockStateDeps {
  t: (key: string, named?: Record<string, unknown>, plural?: number) => string;
  profile: (userId: string) => { name: string; avatar: string };
}

async function loadDeps(): Promise<DockStateDeps> {
  const [{ i18n }, { userDataService }, { getAvatarUrl }] = await Promise.all([
    import('@/i18n'),
    import('@/services/userDataService'),
    import('@/utils/avatarUtils'),
  ]);
  return {
    t: (key, named, plural) =>
      plural === undefined ? i18n.global.t(key, named ?? {}) : i18n.global.t(key, named ?? {}, plural),
    profile: (userId) => {
      const p = userDataService.getUserProfile(userId);
      return {
        name: p?.display_name || p?.username || 'User',
        avatar: getAvatarUrl(p?.avatar_url) || '/default_avatar.webp',
      };
    },
  };
}

let deps: DockStateDeps | null = null;

function htmlSnapshot(): DockState['html'] {
  const root = document.documentElement;
  const attributes: Record<string, string> = {};
  for (const attr of Array.from(root.attributes)) {
    if (attr.name.startsWith('data-')) attributes[attr.name] = attr.value;
  }
  return { className: root.className, style: root.getAttribute('style') ?? '', attributes };
}

/** The dock window's view of the call. */
export function buildDockState({ t, profile: profileOf }: DockStateDeps): DockState {
  const store = useUnifiedVoiceChannelStore();
  const self = store.localState;
  const participants: DockParticipant[] = [
    { userId: self.userId, speaking: self.audioLevel > SPEAKING_LEVEL && !self.isMuted, muted: !!self.isMuted, deafened: !!self.isDeafened, ...profileOf(self.userId) },
    ...(store.allUsers || []).map((u: any) => ({
      userId: u.userId,
      speaking: !!u.isSpeaking,
      muted: !!u.isMuted,
      deafened: !!u.isDeafened,
      ...profileOf(u.userId),
    })),
  ];
  const channelName = store.dmOtherUserId ? profileOf(store.dmOtherUserId).name : store.currentChannelName || '';
  return {
    channelName,
    selfId: self.userId,
    participants,
    muted: !!self.isMuted,
    deafened: !!self.isDeafened,
    speakLocked: !!store.speakLocked,
    deafenLocked: !!store.deafenLocked,
    encrypted: !!store.isEncrypted,
    reconnecting: store.connectionState === 'reconnecting',
    startedAt: store.callStartTime ? new Date(store.callStartTime).getTime() : null,
    labels: {
      mute: t('voice.mute'),
      unmute: t('voice.unmute'),
      deafen: t('voice.deafen'),
      undeafen: t('voice.undeafen'),
      backToApp: t('voice.floatingDock.backToApp'),
      leave: t('voice.leave'),
      participants: t('voice.participants'),
      inCall: t('voice.inCallCount', { count: participants.length }, participants.length),
      dragHint: t('voice.floatingDock.dragHint'),
      reconnecting: t('voice.reconnecting'),
    },
    html: htmlSnapshot(),
  };
}

let unlisteners: Array<() => void> = [];
let stopStateWatch: WatchStopHandle | null = null;
let stopCallWatch: WatchStopHandle | null = null;
let htmlObserver: MutationObserver | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

async function pushState(): Promise<void> {
  if (!floatingDockActive.value || !deps) return;
  await emitTo(DOCK_WINDOW, DOCK_STATE_EVENT, buildDockState(deps));
}

function schedulePush(): void {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushState().catch((err) => debug.warn('[floatingDock] state push failed:', err));
  }, PUSH_INTERVAL_MS);
}

async function focusMainWindow(): Promise<void> {
  await invoke('float_dock_focus_main');
}

export function handleDockCommand(command: DockCommand): void {
  const store = useUnifiedVoiceChannelStore();
  switch (command.type) {
    case 'mute':
      void store.toggleMute();
      return;
    case 'deafen':
      void store.toggleDeafen();
      return;
    case 'leave':
      void store.leaveVoiceChannel();
      return;
    case 'expand':
    case 'redock':
      void closeFloatingDock();
      if (command.type === 'expand') void focusMainWindow().catch(() => {});
      commandHandlers.forEach((handler) => handler(command));
      return;
  }
}

async function startSync(): Promise<void> {
  deps ??= await loadDeps();
  const loaded = deps;
  unlisteners.push(await listen<DockCommand>(DOCK_COMMAND_EVENT, (e) => handleDockCommand(e.payload)));
  unlisteners.push(await listen(DOCK_READY_EVENT, () => { schedulePush(); }));
  const store = useUnifiedVoiceChannelStore();
  stopStateWatch = watch(() => buildDockState(loaded), schedulePush, { deep: true });
  stopCallWatch = watch(() => store.isConnected, (connected) => {
    if (!connected) void closeFloatingDock();
  });
  htmlObserver = new MutationObserver(schedulePush);
  htmlObserver.observe(document.documentElement, { attributes: true });
  schedulePush();
}

function stopSync(): void {
  unlisteners.forEach((fn) => fn());
  unlisteners = [];
  stopStateWatch?.();
  stopStateWatch = null;
  stopCallWatch?.();
  stopCallWatch = null;
  htmlObserver?.disconnect();
  htmlObserver = null;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
}

/** Screen position, logical px, of a point in the main window's client px (outside the viewport too). */
export async function screenPointFromClient(client: Point): Promise<Point> {
  const win = getCurrentWindow();
  const [inner, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
  const zoom = nativeZoomFactor();
  return { x: inner.x / scale + client.x * zoom, y: inner.y / scale + client.y * zoom };
}

/** Client px of a point given in logical px from the main window's content origin. */
export function clientPointFromLogical(p: Point): Point {
  const zoom = nativeZoomFactor();
  return { x: p.x / zoom, y: p.y / zoom };
}

/** Tears the dock off into its own window, top-left at `at` (logical screen px). */
export async function floatDock(at: Point): Promise<boolean> {
  if (!floatingDockSupported() || floatingDockActive.value) return false;
  try {
      await invoke('float_dock_open', { x: Math.round(at.x), y: Math.round(at.y) });
  } catch (err) {
    debug.warn('[floatingDock] could not open the dock window:', err);
    return false;
  }
  floatingDockActive.value = true;
  await startSync();
  return true;
}

export async function closeFloatingDock(): Promise<void> {
  if (!floatingDockActive.value) return;
  floatingDockActive.value = false;
  stopSync();
  try {
      await invoke('float_dock_close');
  } catch (err) {
    debug.warn('[floatingDock] could not close the dock window:', err);
  }
}
