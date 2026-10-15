/**
 * Group actor of a local server: https://<domain>/servers/<id>, key <actor>#main-key.
 *
 * Activities whose actor is the Group (Accept and Reject of a Join, channel Add/Update/Remove,
 * server Update, message Delete) are signed with the Group's own key: every inbox requires the
 * signing key's owner to equal activity.actor (InboxHandler, GroupService).
 *
 * The key pair is public.server_actor_keys, generated on first use. A remote server's local
 * copy has no key.
 */

import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { SignatureService } from './SignatureService.js';

export interface ServerActorKeys {
  publicKey: string;
  privateKey: string;
}

const KEY_CACHE_MAX = 1_000;
const keyCache = new Map<string, ServerActorKeys>();
const pending = new Map<string, Promise<ServerActorKeys>>();

export function serverActorUrl(serverId: string): string {
  return `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;
}

export function serverActorKeyId(serverId: string): string {
  return `${serverActorUrl(serverId)}#main-key`;
}

/** publicKey object of the Group actor document. */
export function serverActorPublicKey(serverId: string, publicKeyPem: string): Record<string, string> {
  return {
    id: serverActorKeyId(serverId),
    owner: serverActorUrl(serverId),
    publicKeyPem,
  };
}

async function readKeys(serverId: string): Promise<ServerActorKeys | null> {
  const { data, error } = await getSupabaseClient()
    .from('server_actor_keys')
    .select('public_key, private_key')
    .eq('server_id', serverId)
    .maybeSingle();
  if (error) throw new Error(`Group key of server ${serverId} unavailable: ${error.message}`);
  return data ? { publicKey: data.public_key, privateKey: data.private_key } : null;
}

async function loadOrCreateKeys(serverId: string): Promise<ServerActorKeys> {
  const existing = await readKeys(serverId);
  if (existing) return existing;

  const supabase = getSupabaseClient();
  const { data: server } = await supabase
    .from('servers')
    .select('id, is_local_server')
    .eq('id', serverId)
    .maybeSingle();
  if (!server || server.is_local_server === false) {
    throw new Error(`Server ${serverId} is not a local server; it has no Group key`);
  }

  // Concurrent first uses race on the primary key; ignoreDuplicates keeps the first writer's
  // pair and every caller reads that one back.
  const generated = await SignatureService.generateKeyPair();
  const { error } = await supabase
    .from('server_actor_keys')
    .upsert(
      { server_id: serverId, public_key: generated.publicKey, private_key: generated.privateKey },
      { onConflict: 'server_id', ignoreDuplicates: true },
    );
  if (error) throw new Error(`Group key of server ${serverId} not stored: ${error.message}`);

  const stored = await readKeys(serverId);
  if (!stored) throw new Error(`Group key of server ${serverId} missing after insert`);
  logger.info(`Generated the Group key pair of server ${serverId}`);
  return stored;
}

export async function getServerActorKeys(serverId: string): Promise<ServerActorKeys> {
  const cached = keyCache.get(serverId);
  if (cached) return cached;

  let inflight = pending.get(serverId);
  if (!inflight) {
    inflight = loadOrCreateKeys(serverId)
      .then((keys) => {
        if (keyCache.size >= KEY_CACHE_MAX) {
          const oldest = keyCache.keys().next().value;
          if (oldest !== undefined) keyCache.delete(oldest);
        }
        keyCache.set(serverId, keys);
        return keys;
      })
      .finally(() => pending.delete(serverId));
    pending.set(serverId, inflight);
  }
  return inflight;
}

export function __resetServerActorKeyCache(): void {
  keyCache.clear();
  pending.clear();
}

/** HTTP signature headers for a request made as the server's Group actor. */
export async function signAsServer(
  serverId: string,
  targetUrl: string,
  method: string,
  body: unknown,
): Promise<{ headers: Record<string, string>; digest?: string }> {
  const { privateKey } = await getServerActorKeys(serverId);
  return SignatureService.signWithKey(targetUrl, method, body, serverActorKeyId(serverId), privateKey);
}
