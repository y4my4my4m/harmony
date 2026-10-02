/**
 * Instance actor: the Application actor that speaks for the instance rather than
 * a user. Forwarded reports (Flag) are signed with its key, as Mastodon signs
 * them with Account.representative and Misskey with its instance.actor user.
 *
 * Served at https://<domain>/users/instance.actor, Misskey's name for it.
 * Usernames match ^[a-zA-Z0-9_]+$, so no account can take the path, and the
 * reverse proxies already route /users/* to this backend. preferredUsername is
 * instance.actor; WebFinger answers acct:instance.actor@<domain>, which
 * Mastodon's FetchRemoteActorService requires to loop back to the actor id.
 *
 * The key pair is public.instance_actor_keys, generated on first use.
 */

import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { SignatureService } from './SignatureService.js';

export const INSTANCE_ACTOR_USERNAME = 'instance.actor';

export interface InstanceActorKeys {
  publicKey: string;
  privateKey: string;
}

export function instanceActorUrl(): string {
  return `https://${config.INSTANCE_DOMAIN}/users/${INSTANCE_ACTOR_USERNAME}`;
}

export function instanceActorKeyId(): string {
  return `${instanceActorUrl()}#main-key`;
}

export function isInstanceActorUsername(username: string | undefined | null): boolean {
  return typeof username === 'string' && username.toLowerCase() === INSTANCE_ACTOR_USERNAME;
}

let cachedKeys: InstanceActorKeys | null = null;
let pendingKeys: Promise<InstanceActorKeys> | null = null;

async function readKeys(): Promise<InstanceActorKeys | null> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('instance_actor_keys')
    .select('public_key, private_key')
    .eq('id', true)
    .maybeSingle();
  if (error) {
    throw new Error(`instance actor key unavailable: ${error.message}`);
  }
  return data ? { publicKey: data.public_key, privateKey: data.private_key } : null;
}

async function loadOrCreateKeys(): Promise<InstanceActorKeys> {
  const existing = await readKeys();
  if (existing) return existing;

  // Concurrent first uses race on the single row; ignoreDuplicates keeps the
  // first writer's pair and every caller reads that one back.
  const generated = await SignatureService.generateKeyPair();
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('instance_actor_keys')
    .upsert(
      { id: true, public_key: generated.publicKey, private_key: generated.privateKey },
      { onConflict: 'id', ignoreDuplicates: true },
    );
  if (error) {
    throw new Error(`instance actor key not stored: ${error.message}`);
  }
  const stored = await readKeys();
  if (!stored) {
    throw new Error('instance actor key missing after insert');
  }
  logger.info('Generated the instance actor key pair');
  return stored;
}

export async function getInstanceActorKeys(): Promise<InstanceActorKeys> {
  if (cachedKeys) return cachedKeys;
  if (!pendingKeys) {
    pendingKeys = loadOrCreateKeys()
      .then((keys) => {
        cachedKeys = keys;
        return keys;
      })
      .finally(() => {
        pendingKeys = null;
      });
  }
  return pendingKeys;
}

export function __resetInstanceActorKeyCache(): void {
  cachedKeys = null;
  pendingKeys = null;
}

/** HTTP signature headers for a request made as the instance actor. */
export async function signAsInstanceActor(
  targetUrl: string,
  method: string,
  body: unknown,
): Promise<{ headers: Record<string, string>; digest?: string }> {
  const { privateKey } = await getInstanceActorKeys();
  return SignatureService.signWithKey(targetUrl, method, body, instanceActorKeyId(), privateKey);
}

export function instanceActorDocument(publicKeyPem: string): Record<string, unknown> {
  const id = instanceActorUrl();
  const base = `https://${config.INSTANCE_DOMAIN}`;
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
    id,
    type: 'Application',
    preferredUsername: INSTANCE_ACTOR_USERNAME,
    name: config.INSTANCE_NAME,
    summary: `Instance actor of ${config.INSTANCE_DOMAIN}`,
    url: `${base}/`,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    endpoints: { sharedInbox: `${base}/inbox` },
    manuallyApprovesFollowers: true,
    discoverable: false,
    publicKey: {
      id: instanceActorKeyId(),
      owner: id,
      publicKeyPem,
    },
  };
}

const router = Router();

router.get(
  `/users/${INSTANCE_ACTOR_USERNAME}`,
  asyncHandler(async (_req: Request, res: Response) => {
    const { publicKey } = await getInstanceActorKeys();
    res.setHeader('Content-Type', 'application/activity+json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(instanceActorDocument(publicKey));
  }),
);

router.get(
  `/users/${INSTANCE_ACTOR_USERNAME}/outbox`,
  (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/activity+json');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${instanceActorUrl()}/outbox`,
      type: 'OrderedCollection',
      totalItems: 0,
      orderedItems: [],
    });
  },
);

export default router;
