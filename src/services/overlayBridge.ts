import { isTauriRuntime } from '@/services/instanceConfig';
import { userDataService } from '@/services/userDataService';
import { getAvatarUrl } from '@/utils/avatarUtils';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { debug } from '@/utils/debug';

const isAndroid = /Android/i.test(navigator.userAgent);
const KEY = 'harmony.gameOverlay';
let timer: ReturnType<typeof setInterval> | null = null;

function desktop(): boolean {
  return isTauriRuntime() && !isAndroid;
}

export function isOverlayEnabled(): boolean {
  return localStorage.getItem(KEY) === '1';
}

async function emitRoster(): Promise<void> {
  const { emit } = await import('@tauri-apps/api/event');
  const store = useUnifiedVoiceChannelStore();
  const roster = (store.allUsers || []).map((u: any) => {
    const p = userDataService.getUserProfile(u.userId);
    return {
      userId: u.userId,
      name: p?.display_name || p?.username || 'User',
      avatar: getAvatarUrl(p?.avatar_url) || '/default_avatar.webp',
      speaking: !!u.isSpeaking,
      muted: !!u.isMuted,
    };
  });
  await emit('overlay://roster', roster);
}

async function open(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('overlay_open');
  if (!timer) timer = setInterval(() => { emitRoster().catch(() => {}); }, 500);
  emitRoster().catch(() => {});
}

async function close(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('overlay_close');
}

// call on voice join/leave; opens the overlay only when the setting is on
export function syncOverlayForCall(inCall: boolean): void {
  if (!desktop()) return;
  const wanted = inCall && isOverlayEnabled();
  (wanted ? open() : close()).catch(err => debug.warn('⚠️ [overlayBridge]', err));
}

export async function setOverlayEnabled(on: boolean): Promise<void> {
  localStorage.setItem(KEY, on ? '1' : '0');
  if (!desktop()) return;
  const store = useUnifiedVoiceChannelStore();
  syncOverlayForCall(on && !!store.isConnected);
}
