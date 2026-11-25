/**
 * The instance's name, everywhere the backend states it: NodeInfo metadata.nodeName, the instance
 * actor's name, the invite, widget and Drive link pages, oEmbed provider_name, /health and
 * /instance-info. instance_config.instance_name (the admin panel's), else INSTANCE_NAME, else the
 * domain. Blank values count as absent.
 */

import config from '../config/index.js';
import { logger } from './logger.js';

/** Lifetime of a name cachedInstanceName() holds; the same bound as DOCUMENT_CACHE_TTL_MS. */
export const INSTANCE_NAME_TTL_MS = 30_000;

/** instance_config values are jsonb; a JSON-encoded string inside one is decoded. */
function configString(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value.startsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded === 'string') return decoded.trim();
    } catch {
      // Not JSON: the value itself.
    }
  }
  return value.trim();
}

export function resolveInstanceName(stored: unknown): string {
  return configString(stored) || (config.INSTANCE_NAME ?? '').trim() || config.INSTANCE_DOMAIN;
}

/** `read` is false when the lookup failed; `name` is then the fallback. Never rejects. */
async function lookup(supabase: any): Promise<{ name: string; read: boolean }> {
  try {
    const { data, error } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'instance_name')
      .maybeSingle();
    if (!error) return { name: resolveInstanceName(data?.config_value), read: true };
    logger.warn(`instance_name lookup failed: ${error.message}`);
  } catch (err) {
    logger.warn(`instance_name lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { name: resolveInstanceName(undefined), read: false };
}

export async function instanceName(supabase: any): Promise<string> {
  return (await lookup(supabase)).name;
}

let held: { name: string; until: number } | null = null;
let inFlight: Promise<string> | null = null;

/**
 * instanceName() held for INSTANCE_NAME_TTL_MS, one lookup shared by concurrent callers. A failed
 * lookup answers the fallback and is not held.
 */
export function cachedInstanceName(supabase: any): Promise<string> {
  if (held && Date.now() < held.until) return Promise.resolve(held.name);
  if (inFlight) return inFlight;
  const pending: Promise<string> = lookup(supabase).then(({ name, read }) => {
    // A lookup begun before clearInstanceNameCache() is not held.
    if (inFlight === pending) {
      inFlight = null;
      if (read) held = { name, until: Date.now() + INSTANCE_NAME_TTL_MS };
    }
    return name;
  });
  inFlight = pending;
  return pending;
}

export function clearInstanceNameCache(): void {
  held = null;
  inFlight = null;
}
