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
  if (getStoredInstance()) return false;
  // dev builds with baked env use the vite proxy, no picker needed
  return import.meta.env.PROD || !import.meta.env.VITE_SUPABASE_URL;
}

// prefixes the selected instance origin; unchanged when none stored (web/dev proxy)
export function apiUrl(path: string): string {
  const stored = getStoredInstance();
  return stored ? `${stored.origin}${path}` : path;
}

function normalizeOrigin(input: string): string {
  let value = input.trim();
  if (!value) throw new Error('Enter an instance domain');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  return url.origin;
}

export async function fetchInstanceInfo(domainOrUrl: string): Promise<InstanceConfig> {
  const origin = normalizeOrigin(domainOrUrl);

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
