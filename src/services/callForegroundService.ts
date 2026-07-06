import { isTauriRuntime } from '@/services/instanceConfig';
import { debug } from '@/utils/debug';

const isAndroid = /Android/i.test(navigator.userAgent);
let active = false;

// Android only: keep a mic foreground service running for the call's lifetime so
// audio survives the app being backgrounded. No-op elsewhere.
export async function setCallServiceActive(on: boolean): Promise<void> {
  if (!isTauriRuntime() || !isAndroid) return;
  if (on === active) return;
  active = on;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('android_call_service', { start: on });
  } catch (error) {
    debug.warn('⚠️ [callForegroundService] toggle failed:', error);
  }
}
