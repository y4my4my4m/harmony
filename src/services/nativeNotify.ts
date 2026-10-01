import { isTauriRuntime, getStoredInstance } from '@/services/instanceConfig';
import { debug } from '@/utils/debug';

let permissionChecked = false;
let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (permissionChecked) return permissionGranted;
  permissionChecked = true;
  try {
    const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
    permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      permissionGranted = (await requestPermission()) === 'granted';
    }
  } catch (error) {
    debug.warn('[nativeNotify] permission check failed:', error);
    permissionGranted = false;
  }
  return permissionGranted;
}

// avatar must be a local file for the OS notification icon (desktop); download once per notif
async function cacheAvatar(url?: string | null): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { writeFile, mkdir, BaseDirectory } = await import('@tauri-apps/plugin-fs');
    const { appCacheDir, join } = await import('@tauri-apps/api/path');
    await mkdir('notif', { baseDir: BaseDirectory.AppCache, recursive: true }).catch(() => {});
    const rel = 'notif/avatar.png';
    await writeFile(rel, bytes, { baseDir: BaseDirectory.AppCache });
    return await join(await appCacheDir(), rel);
  } catch (error) {
    debug.warn('[nativeNotify] avatar cache failed:', error);
    return undefined;
  }
}

// OS notifications can't render custom emoji images; strip the shortcodes
// entirely (unicode emoji are plain chars and pass through untouched)
function stripCustomEmojis(text: string): string {
  return text
    .replace(/<a?:[a-z0-9_+-]+:\d+>/gi, '')
    .replace(/:[a-z0-9_+-]{2,}:/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const isAndroid = /Android/i.test(navigator.userAgent);
let localId = 1;

// local-user mentions don't need the @domain suffix; remote ones keep it
function localizeMentions(text: string): string {
  const stored = getStoredInstance();
  if (!stored) return text;
  let host: string;
  try {
    host = new URL(stored.origin).host;
  } catch {
    return text;
  }
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(@[a-z0-9_.-]+)@${esc}`, 'gi'), '$1');
}

/** Routing fields of a notification row, as the Android plugin and push payloads carry them. */
export interface NativeNotifyTarget {
  id: string;
  type: string;
  /** App path the notification opens. */
  url?: string;
  conversation_id?: string;
  server_id?: string;
  channel_id?: string;
  thread_id?: string;
  message_id?: string;
  post_id?: string;
}

export async function nativeNotify(opts: {
  title: string;
  sender: string;
  conversationTitle: string;
  message: string;
  avatarUrl?: string | null;
  largeIconUrl?: string | null;
  /** The notification row. Without it the Android notification opens the app's start page. */
  target?: NativeNotifyTarget;
}): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  if (!(await ensurePermission())) return false;

  const sender = stripCustomEmojis(opts.sender);
  const conversationTitle = stripCustomEmojis(opts.conversationTitle);
  const message = localizeMentions(stripCustomEmojis(opts.message));

  try {
    // Android: the push plugin renders it exactly as a pushed one, keyed by the row id, so a
    // push for the same row alerts once, a tap opens the target and a read elsewhere cancels it.
    if (isAndroid) {
      const { showNativeNotification } = await import('@/services/androidPush');
      const target = opts.target ?? { id: `local-${localId++}`, type: 'test' };
      await showNativeNotification({
        ...target,
        title: stripCustomEmojis(opts.title),
        body: message,
        sender,
        conv: conversationTitle,
        avatar: opts.avatarUrl ?? '',
        icon: opts.largeIconUrl ?? opts.avatarUrl ?? '',
      });
      return true;
    }

    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    const icon = await cacheAvatar(opts.largeIconUrl ?? opts.avatarUrl);
    const title = conversationTitle ? `${sender} · ${conversationTitle}` : sender || stripCustomEmojis(opts.title);
    sendNotification({ title, body: message, icon });
    return true;
  } catch (error) {
    debug.warn('[nativeNotify] send failed:', error);
    return false;
  }
}
