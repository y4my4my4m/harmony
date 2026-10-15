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

// A detected activity is a lease: it expires LEASE_MINUTES after it was last renewed, so it
// lapses on its own when this app quits, crashes or sleeps. Renewed every RENEW_MS.
export const LEASE_MINUTES = 3;
export const RENEW_MS = 60_000;
let current: Activity = null;
let renewTimer: ReturnType<typeof setInterval> | null = null;

function stopRenewing(): void {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
}

function desktop(): boolean {
  return isTauriRuntime() && !isAndroid;
}

export function isRichPresenceEnabled(): boolean {
  return localStorage.getItem(KEY) === '1';
}

async function write(activity: NonNullable<Activity>): Promise<void> {
  const status: CustomUserStatus = {
    text: activity.name,
    type: activity.kind === 'streaming' ? 'streaming' : 'playing',
    details: activity.name,
    expiresAt: new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString(),
  };
  await userDataService.setCustomStatus(status, LEASE_MINUTES);
}

export async function apply(activity: Activity): Promise<void> {
  try {
    current = activity;
    if (activity) {
      await write(activity);
      autoApplied = activity.name;
      if (!renewTimer) {
        renewTimer = setInterval(() => {
          // A status set by hand since then is the user's; the lease is not renewed over it.
          if (!current || userDataService.getCustomStatus()?.text !== autoApplied) {
            stopRenewing();
            return;
          }
          write(current).catch((error) => debug.warn('[nativePresence] lease renewal failed:', error));
        }, RENEW_MS);
      }
    } else {
      stopRenewing();
      if (autoApplied) {
        await userDataService.clearCustomStatus();
        autoApplied = null;
      }
    }
  } catch (error) {
    debug.warn('[nativePresence] status update failed:', error);
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
    debug.warn('[nativePresence] start failed:', error);
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
