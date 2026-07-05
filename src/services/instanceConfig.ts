// The native client is one binary for any instance, so it fetches Supabase
// config from /instance-info at runtime. Inert on web (falls back to env).

const STORAGE_KEY = 'harmony.instance';

export interface InstanceConfig {
  origin: string;
  name: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  version?: string;
}

export function isTauriRuntime(): boolean {
  const g = globalThis as any;
  return typeof g.__TAURI_INTERNALS__ !== 'undefined' || typeof g.__TAURI__ !== 'undefined';
}

export function getStoredInstance(): InstanceConfig | null {
  if (!isTauriRuntime()) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.origin || !parsed?.supabaseUrl || !parsed?.supabaseAnonKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setStoredInstance(config: InstanceConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearStoredInstance(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function needsInstanceSelection(): boolean {
  if (!isTauriRuntime()) return false;
  return !getStoredInstance();
}

// prefixes the selected instance origin; unchanged when none stored (web/dev proxy)
export function apiUrl(path: string): string {
  const stored = getStoredInstance();
  return stored ? `${stored.origin}${path}` : path;
}

// display domain for handles; VITE_DOMAIN is a build-time placeholder on native, so prefer the stored instance
export function getInstanceDomain(): string {
  const stored = getStoredInstance();
  if (stored) {
    try {
      return new URL(stored.origin).host;
    } catch {
      /* fall through */
    }
  }
  const baked = import.meta.env.VITE_DOMAIN as string | undefined;
  if (baked) return baked;
  if (typeof window !== 'undefined') {
    const host = window.location.host;
    if (host && !/^(localhost|127\.|tauri\.localhost)/i.test(host)) return host;
  }
  return 'your-instance';
}

function normalizeOrigin(input: string): string {
  let value = input.trim();
  if (!value) throw new Error('Enter an instance domain');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  return url.origin;
}

async function fetchInstanceInfoFrom(origin: string): Promise<InstanceConfig> {
  const response = await fetch(`${origin}/api/federation/instance-info`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Instance responded with ${response.status} — is this a Harmony instance?`);
  }
  const info = await response.json();
  if (!info?.supabaseUrl || !info?.supabaseAnonKey) {
    throw new Error('Instance did not return a usable configuration');
  }
  return {
    origin,
    name: info.name || new URL(origin).hostname,
    supabaseUrl: info.supabaseUrl,
    supabaseAnonKey: info.supabaseAnonKey,
    version: info.version,
  };
}

export async function fetchInstanceInfo(domainOrUrl: string): Promise<InstanceConfig> {
  const trimmed = domainOrUrl.trim();
  if (!trimmed) throw new Error('Enter an instance domain');

  const origins = /^https?:\/\//i.test(trimmed)
    ? [normalizeOrigin(trimmed)]
    : [normalizeOrigin(`https://${trimmed}`), normalizeOrigin(`http://${trimmed}`)];

  let lastError: unknown;
  for (const origin of origins) {
    try {
      return await fetchInstanceInfoFrom(origin);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith('Instance ')) throw error;
    }
  }
  const host = new URL(origins[0]).host;
  throw new Error(
    lastError instanceof Error && lastError.message.startsWith('Instance ')
      ? lastError.message
      : `Couldn't reach ${host}. Check the domain, or the instance may be too old to support native clients.`
  );
}
