/** Admin settings of the ICE servers of peer-to-peer calls (20261124100002_voice_ice_servers.sql). */

import { supabase } from '@/supabase';
import { adminService } from '@/services/AdminService';
import { isStunUrl, isTurnUrl } from './iceServers';

export interface IceServerSettings {
  /** The app's list (DEFAULT_ICE_SERVERS) rather than stunUrls. */
  stunDefault: boolean;
  stunUrls: string[];
  turnUrls: string[];
  turnAuth: 'secret' | 'password';
  turnUsername: string;
  /** A secret or password is stored. Its value is never put in the form. */
  secretSet: boolean;
}

const KEYS = {
  stun: 'voice_stun_urls',
  turn: 'voice_turn_urls',
  auth: 'voice_turn_auth',
  username: 'voice_turn_username',
  secret: 'voice_turn_secret',
} as const;

function urls(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((u): u is string => typeof u === 'string') : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** One URL per line, blanks dropped. */
export function parseUrlLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** The lines that are no STUN URL, or no TURN URL. */
export function invalidUrls(lines: string[], kind: 'stun' | 'turn'): string[] {
  const valid = kind === 'stun' ? isStunUrl : isTurnUrl;
  return lines.filter((line) => !valid(line));
}

export async function loadIceServerSettings(): Promise<IceServerSettings> {
  const { data, error } = await supabase
    .from('instance_config')
    .select('config_key, config_value')
    .in('config_key', Object.values(KEYS));
  if (error) throw error;
  const stored = new Map((data ?? []).map((row) => [row.config_key, row.config_value as unknown]));
  const stun = stored.get(KEYS.stun);
  return {
    stunDefault: !Array.isArray(stun),
    stunUrls: urls(stun),
    turnUrls: urls(stored.get(KEYS.turn)),
    turnAuth: text(stored.get(KEYS.auth)) === 'password' ? 'password' : 'secret',
    turnUsername: text(stored.get(KEYS.username)),
    secretSet: text(stored.get(KEYS.secret)) !== '',
  };
}

/**
 * Writes only what differs from `saved`, and the secret only when `secret` is non-empty: a value
 * another admin stored meanwhile stays.
 */
export async function saveIceServerSettings(
  next: IceServerSettings,
  saved: IceServerSettings,
  secret: string,
  adminId: string,
): Promise<void> {
  const changes: Record<string, unknown> = {};
  const nextStun = next.stunDefault ? 'default' : next.stunUrls;
  const savedStun = saved.stunDefault ? 'default' : saved.stunUrls;
  if (JSON.stringify(nextStun) !== JSON.stringify(savedStun)) changes[KEYS.stun] = nextStun;
  if (JSON.stringify(next.turnUrls) !== JSON.stringify(saved.turnUrls)) changes[KEYS.turn] = next.turnUrls;
  if (next.turnAuth !== saved.turnAuth) changes[KEYS.auth] = next.turnAuth;
  if (next.turnUsername.trim() !== saved.turnUsername) changes[KEYS.username] = next.turnUsername.trim();
  if (secret.trim() !== '') changes[KEYS.secret] = secret.trim();
  await adminService.setInstanceConfigs(changes, adminId);
}
