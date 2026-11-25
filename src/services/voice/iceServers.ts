/**
 * ICE servers of a peer-to-peer call: the instance's (voice_ice_servers,
 * 20261124100002_voice_ice_servers.sql), else DEFAULT_ICE_SERVERS.
 */

import { supabase } from '@/supabase';
import { hasCapability } from '@/services/instanceCapabilities';
import { debug } from '@/utils/debug';

/** STUN servers of an instance that names none, and of an instance older than voice_ice_servers. No TURN. */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = Object.freeze([
  Object.freeze({ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }),
]);

/** voice_ice_servers' answer. stun null: DEFAULT_ICE_SERVERS. */
export interface InstanceIceServers {
  stun: string[] | null;
  turn: { urls: string[]; username: string; credential: string } | null;
}

const STUN_URL = /^stuns?:\S+$/i;
const TURN_URL = /^turns?:\S+$/i;

export function isStunUrl(url: string): boolean {
  return STUN_URL.test(url.trim());
}

export function isTurnUrl(url: string): boolean {
  return TURN_URL.test(url.trim());
}

function strings(value: unknown, valid: (url: string) => boolean): string[] {
  return Array.isArray(value) ? value.filter((u): u is string => typeof u === 'string' && valid(u)) : [];
}

function stunServers(stun: unknown): RTCIceServer[] {
  if (!Array.isArray(stun)) return [...DEFAULT_ICE_SERVERS];
  const urls = strings(stun, isStunUrl);
  return urls.length > 0 ? [{ urls }] : [];
}

/** RTCPeerConnection's iceServers for an answer of voice_ice_servers; null or malformed reads as unset. */
export function toIceServers(answer: unknown): RTCIceServer[] {
  const a = (answer && typeof answer === 'object' ? answer : {}) as Partial<Record<keyof InstanceIceServers, unknown>>;
  const servers = stunServers(a.stun);
  const turn = a.turn as Partial<InstanceIceServers['turn']> | null | undefined;
  if (turn && typeof turn === 'object') {
    const urls = strings(turn.urls, isTurnUrl);
    if (urls.length > 0 && typeof turn.username === 'string' && typeof turn.credential === 'string') {
      servers.push({ urls, username: turn.username, credential: turn.credential });
    }
  }
  return servers;
}

/** The instance's ICE servers for this account; DEFAULT_ICE_SERVERS when the request fails. */
export async function loadIceServers(): Promise<RTCIceServer[]> {
  if (!hasCapability('signal-relay')) return [...DEFAULT_ICE_SERVERS];
  try {
    const { data, error } = await supabase.rpc('voice_ice_servers');
    if (error) throw error;
    return toIceServers(data);
  } catch (error) {
    debug.warn('[P2P] ICE servers unread, using the defaults:', error);
    return [...DEFAULT_ICE_SERVERS];
  }
}
