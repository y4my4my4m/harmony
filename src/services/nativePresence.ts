import { isTauriRuntime } from '@/services/instanceConfig';
import { userDataService } from '@/services/userDataService';
import { debug } from '@/utils/debug';
import type { CustomUserStatus } from '@/types/chat';

const isAndroid = /Android/i.test(navigator.userAgent);
const KEY = 'harmony.richPresence';

type Activity = { name: string; kind: string } | null;

let unlisten: (() => void) | null = null;
// the status we auto-applied; only auto-clear our own, never a manual status
let autoApplied: string | null = null;

function desktop(): boolean {
  return isTauriRuntime() && !isAndroid;
}

export function isRichPresenceEnabled(): boolean {
  return localStorage.getItem(KEY) === '1';
}

async function apply(activity: Activity): Promise<void> {
  try {
    if (activity) {
      const status: CustomUserStatus = {
        text: activity.name,
        type: activity.kind === 'streaming' ? 'streaming' : 'playing',
        details: activity.name,
      };
      await userDataService.setCustomStatus(status);
      autoApplied = activity.name;
    } else if (autoApplied) {
      await userDataService.clearCustomStatus();
      autoApplied = null;
    }
  } catch (error) {
    debug.warn('⚠️ [nativePresence] status update failed:', error);
  }
}

export async function startRichPresence(): Promise<void> {
  if (!desktop() || unlisten) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen<Activity>('presence://game', (e) => {
      if (isRichPresenceEnabled()) apply(e.payload ?? null);
    });
    await invoke('presence_start');
  } catch (error) {
    debug.warn('⚠️ [nativePresence] start failed:', error);
  }
}

export async function stopRichPresence(): Promise<void> {
  if (!desktop()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('presence_stop');
  } catch { /* ignore */ }
  if (unlisten) { unlisten(); unlisten = null; }
  await apply(null);
}

export async function setRichPresenceEnabled(on: boolean): Promise<void> {
  localStorage.setItem(KEY, on ? '1' : '0');
  if (on) await startRichPresence();
  else await stopRichPresence();
}

// call once on app boot
export function initRichPresence(): void {
  if (desktop() && isRichPresenceEnabled()) startRichPresence();
}
