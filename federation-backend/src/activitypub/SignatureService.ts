import crypto from 'crypto';
import { getSupabaseClient } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { safeFetch } from '../utils/ssrfProtection.js';

// In-memory LRU of PEM public keys, keyed by actorUrl.
//
// Sits in front of `fetchActorPublicKey`'s persistent tiers (profiles table →
// ap_actor_cache table → remote HTTP fetch), each of which costs a DB
// roundtrip per verify. A federation event with N inbox deliveries verifies
// each delivery independently.
//
// TTL is 1 hour, matching `ap_actor_cache.cache_expires_at`.
interface CachedKey {
  pem: string;
  expiresAt: number;
}

const PUBLIC_KEY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const PUBLIC_KEY_CACHE_MAX = 5_000;
const publicKeyCache = new Map<string, CachedKey>();

function getCachedPublicKey(actorUrl: string): string | null {
  const hit = publicKeyCache.get(actorUrl);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    publicKeyCache.delete(actorUrl);
    return null;
  }
  // LRU touch: re-insert moves the key to the end of the Map iteration order.
  publicKeyCache.delete(actorUrl);
  publicKeyCache.set(actorUrl, hit);
  return hit.pem;
}

function setCachedPublicKey(actorUrl: string, pem: string): void {
  if (publicKeyCache.size >= PUBLIC_KEY_CACHE_MAX) {
    // Drop the oldest (first iterated) entry. JS Map preserves insertion order.
    const oldestKey = publicKeyCache.keys().next().value;
    if (oldestKey !== undefined) publicKeyCache.delete(oldestKey);
  }
  publicKeyCache.set(actorUrl, { pem, expiresAt: Date.now() + PUBLIC_KEY_CACHE_TTL_MS });
}

function invalidatePublicKey(actorUrl: string): void {
  publicKeyCache.delete(actorUrl);
}

// Exported for tests and admin endpoints that wipe the cache.
export const __publicKeyCache = {
  size: () => publicKeyCache.size,
  clear: () => publicKeyCache.clear(),
  invalidate: invalidatePublicKey,
};

export class SignatureService {
  static async generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
    return new Promise((resolve, reject) => {
      crypto.generateKeyPair(
        'rsa',
        {
          modulusLength: 2048,
          publicKeyEncoding: {
            type: 'spki',
            format: 'pem',
          },
          privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem',
          },
        },
        (err, publicKey, privateKey) => {
          if (err) reject(err);
          else resolve({ publicKey, privateKey });
        }
      );
    });
  }

  /**
   * Attach draft-cavage HTTP Signature headers to an outbound ActivityPub
   * request. Signs (request-target), host, date, and digest when a body is
   * present.
   */
  static async signRequest(
    targetUrl: string,
    method: string,
    body: any | null,
    userId: string
  ): Promise<{ headers: Record<string, string>; digest?: string }> {
    const supabase = getSupabaseClient();

    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('username, domain')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      throw new AppError(500, 'User not found');
    }

    const initialKeyLookup = await supabase
      .from('user_private_keys')
      .select('private_key')
      .eq('user_id', userId)
      .single();
    const keyError = initialKeyLookup.error;
    let keyData = initialKeyLookup.data;

    // Keys are generated on first use, not at signup.
    if (keyError || !keyData || !keyData.private_key) {
      logger.info(`No keys found for user ${userId}, generating on-demand...`);
      
      try {
        const keys = await this.generateKeyPair();
        
        const { error: privateKeyError } = await supabase
          .from('user_private_keys')
          .upsert({
            user_id: userId,
            private_key: keys.privateKey,
          });
        
        if (privateKeyError) {
          logger.error(`Failed to store private key for user ${userId}:`, privateKeyError);
          throw new AppError(500, 'Failed to store private key');
        }
        
        const { error: publicKeyError } = await supabase
          .from('profiles')
          .update({ public_key: keys.publicKey })
          .eq('id', userId);
        
        if (publicKeyError) {
          logger.error(`Failed to store public key for user ${userId}:`, publicKeyError);
          throw new AppError(500, 'Failed to store public key');
        }
        
        logger.info(`Generated keys on-demand for user ${userId}`);
        keyData = { private_key: keys.privateKey };
      } catch (genError) {
        logger.error(`Failed to generate keys for user ${userId}:`, genError);
        throw new AppError(500, 'Failed to generate user keys');
      }
    }
    
    const privateKey = keyData.private_key;

    const url = new URL(targetUrl);
    const date = new Date().toUTCString();
    const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search}`;
    
    // Header insertion order is significant for Misskey.
    const headers: Record<string, string> = {
      'Host': url.host,
      'Date': date,
    };

    let digest: string | undefined;

    if (body && (method === 'POST' || method === 'PUT')) {
      const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
      const hash = crypto.createHash('sha256').update(bodyString).digest('base64');
      digest = `SHA-256=${hash}`;
      headers['Digest'] = digest;
    }

    const signedHeaders = ['(request-target)', 'host', 'date'];
    if (digest) {
      signedHeaders.push('digest');
    }
    
    const signingParts = [`(request-target): ${requestTarget}`];
    signedHeaders.slice(1).forEach(header => {
      if (headers[header.charAt(0).toUpperCase() + header.slice(1)]) {
        signingParts.push(`${header}: ${headers[header.charAt(0).toUpperCase() + header.slice(1)]}`);
      }
    });
    
    const signingString = signingParts.join('\n');

    const sign = crypto.createSign('SHA256');
    sign.update(signingString);
    sign.end();

    const signature = sign.sign(privateKey, 'base64');

    // Misskey requires (request-target) in the signed header list.
    const keyId = `https://${user.domain}/users/${user.username}#main-key`;
    const signatureHeader = [
      `keyId="${keyId}"`,
      'algorithm="rsa-sha256"',
      `headers="${signedHeaders.join(' ')}"`,
      `signature="${signature}"`,
    ].join(',');

    headers['Signature'] = signatureHeader;

    logger.debug(`Signed request to ${targetUrl}`);

    return { headers, digest };
  }

  /**
   * Parse a Signature header (draft-cavage / RFC 9421 legacy form) into its
   * parameters. Quoted values may legally contain commas and `=` (keyId is a
   * URI, signature is base64); a naive split(',') corrupts those.
   */
  static parseSignatureHeader(signature: string): Record<string, string> {
    const parts: Record<string, string> = {};
    const paramRe = /([A-Za-z0-9]+)\s*=\s*(?:"([^"]*)"|([^,]*))/g;
    let m: RegExpExecArray | null;
    while ((m = paramRe.exec(signature)) !== null) {
      parts[m[1]] = m[2] !== undefined ? m[2] : (m[3] ?? '').trim();
    }
    return parts;
  }

  /**
   * Verify an inbound HTTP signature.
   *
   * The actor URL is the keyId with its fragment removed; its public key is
   * fetched over HTTPS, the signing string is rebuilt from the signed header
   * list, and the signature is checked against it. A body additionally
   * requires a signature-covered Digest header.
   */
  static async verifySignature(
    signature: string,
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: any
  ): Promise<{ verified: boolean; actorUrl?: string; error?: string }> {
    try {
      const signatureParts = this.parseSignatureHeader(signature);

      const { keyId, headers: signedHeaders, signature: sig } = signatureParts;

      if (!keyId || !signedHeaders || !sig) {
        logger.warn('Missing signature components');
        return { verified: false, error: 'Missing signature components' };
      }

      // Replay window (BUGS.md H18). Mastodon-compatible implementations
      // always sign Date; when present, reject outside ±5 minutes of clock
      // skew. Absent this check a captured signed request stays valid forever.
      const dateHeader = headers['date'] || headers['Date'];
      if (dateHeader) {
        const requestTime = Date.parse(dateHeader);
        const MAX_SKEW_MS = 5 * 60 * 1000;
        if (Number.isNaN(requestTime)) {
          return { verified: false, error: 'Unparseable Date header' };
        }
        if (Math.abs(Date.now() - requestTime) > MAX_SKEW_MS) {
          logger.warn(`Request Date outside allowed skew: ${dateHeader}`);
          return { verified: false, error: 'Request Date outside allowed clock skew (possible replay)' };
        }
      }

      // keyId minus fragment: https://host/users/alice#main-key -> https://host/users/alice
      const actorUrl = keyId.split('#')[0];

      const publicKey = await this.fetchActorPublicKey(actorUrl);

      if (!publicKey) {
        logger.warn(`Could not fetch public key for ${actorUrl}`);
        return { verified: false, actorUrl, error: 'Could not fetch public key' };
      }

      // Body integrity (BUGS.md H19). A request with a body requires a Digest
      // header listed in the signed headers, then verified. Otherwise the
      // signature authenticates headers only and the body can be swapped.
      const digestHeader = headers['digest'] || headers['Digest'];
      if (body) {
        if (!digestHeader) {
          logger.warn(`Missing Digest header on signed request with body from ${actorUrl}`);
          return { verified: false, actorUrl, error: 'Missing Digest header - body not covered by signature' };
        }
        if (!signedHeaders.toLowerCase().split(' ').includes('digest')) {
          logger.warn(`Digest header not covered by signature from ${actorUrl}`);
          return { verified: false, actorUrl, error: 'Digest header not included in signed headers' };
        }
        const expectedDigest = this.createDigest(body);
        if (digestHeader !== expectedDigest) {
          logger.warn(`Digest mismatch for ${actorUrl}: expected ${expectedDigest}, got ${digestHeader}`);
          return { verified: false, actorUrl, error: 'Digest mismatch - body may have been tampered' };
        }
        logger.debug(`Digest verified for ${actorUrl}`);
      }

      // Rebuild the signing string; (request-target) is synthetic.
      const headerList = signedHeaders.split(' ');
      const requestTarget = `${method.toLowerCase()} ${path}`;
      
      const signingParts: string[] = [];
      
      for (const headerName of headerList) {
        if (headerName === '(request-target)') {
          signingParts.push(`(request-target): ${requestTarget}`);
        } else {
          // Express lowercases header names; accept either spelling.
          const value = headers[headerName.toLowerCase()] || headers[headerName];
          if (value) {
            // HTTP Signature spec: signing string uses lowercase header names.
            signingParts.push(`${headerName.toLowerCase()}: ${value}`);
          } else {
            logger.warn(`Missing header in signature verification: ${headerName}`);
          }
        }
      }
      
      const signingString = signingParts.join('\n');

      const verify = crypto.createVerify('SHA256');
      verify.update(signingString);
      verify.end();

      const verified = verify.verify(publicKey, sig, 'base64');

      // One retry against a freshly fetched key; covers remote key rotation.
      if (!verified) {
        logger.info(`Signature verification failed for ${actorUrl}, attempting key refresh...`);
        logger.debug(`Signed headers: ${signedHeaders}`);
        logger.debug(`Signing string:\n${signingString}`);
        logger.debug(`Public key (first 100 chars): ${publicKey.substring(0, 100)}...`);
        
        const freshPublicKey = await this.fetchActorPublicKey(actorUrl, true);
        
        if (freshPublicKey && freshPublicKey !== publicKey) {
          logger.info(`Got different public key for ${actorUrl}, retrying verification...`);
          
          const retryVerify = crypto.createVerify('SHA256');
          retryVerify.update(signingString);
          retryVerify.end();
          
          const retryVerified = retryVerify.verify(freshPublicKey, sig, 'base64');
          
          if (retryVerified) {
            logger.info(`Signature verified after key refresh for ${actorUrl}`);
            return { verified: true, actorUrl };
          } else {
            logger.warn(`Signature still invalid after key refresh for ${actorUrl}`);
          }
        } else if (freshPublicKey === publicKey) {
          logger.debug(`Public key unchanged for ${actorUrl}, no retry needed`);
        } else {
          logger.warn(`Could not fetch fresh public key for ${actorUrl}`);
        }
      }
      
      logger.debug(`Signature verification for ${actorUrl}: ${verified}`);

      return { verified, actorUrl };
    } catch (error) {
      logger.error('Signature verification error:', error);
      return { verified: false, error: String(error) };
    }
  }

  /**
   * Verify that the actor in the activity matches the signing key's owner.
   *
   * Two modes:
   *
   * - Strict (default): `activity.actor` must equal the signing key owner URL
   *   after normalization. Applies to `Person`-actor activities (user inbox:
   *   Create Note, Like, Follow, Update Person, Delete Note). Same-domain
   *   delegation here would let any user on a remote host forge activities for
   *   any other user on that host. BUGS.md item C1.
   *
   * - Group delegation (`allowSameDomainDelegation = true`): activities on
   *   behalf of a `Group`/`Service` actor are conventionally signed by an
   *   authorized member on the same domain (Lemmy `c/<community>` announcements
   *   signed by `u/<moderator>`), so any signer on the same host is accepted.
   *   Server inbox only.
   *
   * @param activityActor URL of the `activity.actor` from the inbox payload.
   * @param signingActorUrl URL resolved from the signature `keyId`.
   * @param allowSameDomainDelegation `true` only for the Group/Service (server)
   *   inbox. Defaults to `false`.
   */
  static verifyActorMatch(
    activityActor: string,
    signingActorUrl: string,
    allowSameDomainDelegation = false,
  ): boolean {
    const normalizeUrl = (url: string) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
      } catch {
        return url.replace(/\/$/, '');
      }
    };

    const actorNormalized = normalizeUrl(activityActor);
    const signingNormalized = normalizeUrl(signingActorUrl);

    if (actorNormalized === signingNormalized) {
      return true;
    }

    // Same-domain delegation is opt-in (Group/Service inbox only).
    if (allowSameDomainDelegation) {
      try {
        const actorHost = new URL(activityActor).host;
        const signerHost = new URL(signingActorUrl).host;
        if (actorHost && actorHost === signerHost) {
          logger.info(
            `Actor mismatch allowed (Group same-domain delegation): activity.actor=${activityActor}, signer=${signingActorUrl}`,
          );
          return true;
        }
      } catch {
        // fall through to rejection
      }
    }

    logger.warn(
      `Actor mismatch (delegation=${allowSameDomainDelegation}): activity.actor=${activityActor}, signing key owner=${signingActorUrl}`,
    );
    return false;
  }

  /**
   * Resolve an actor's public key. Tier order: in-memory LRU, profiles table,
   * ap_actor_cache, remote fetch.
   * @param forceRefresh Skip every cache tier and fetch from the remote server.
   */
  private static async fetchActorPublicKey(actorUrl: string, forceRefresh = false): Promise<string | null> {
    const supabase = getSupabaseClient();
    
    // Declared here to stay in scope for the expired-cache fallback below.
    let cachedActorData: any = null;
    
    if (!forceRefresh) {
      // Tier 0: in-memory LRU. Skips two DB roundtrips on a warm cache.
      const memHit = getCachedPublicKey(actorUrl);
      if (memHit) {
        return memHit;
      }
      
      // Tier 1: profiles.public_key.
      const { data: profile } = await supabase
        .from('profiles')
        .select('public_key')
        .eq('federated_id', actorUrl)
        .maybeSingle();
      
      if (profile?.public_key) {
        logger.debug(`Using cached public key from profiles table for ${actorUrl}`);
        setCachedPublicKey(actorUrl, profile.public_key);
        return profile.public_key;
      }
      
      // Tier 2: ap_actor_cache. Expired rows are kept for the fallback below.
      const { data: cachedActor } = await supabase
        .from('ap_actor_cache')
        .select('actor_data, cache_expires_at')
        .eq('ap_id', actorUrl)
        .maybeSingle();
      
      cachedActorData = cachedActor?.actor_data;
      
      if (cachedActor?.cache_expires_at && new Date(cachedActor.cache_expires_at) > new Date()) {
        if (cachedActorData?.publicKey?.publicKeyPem) {
          logger.debug(`Using cached actor data for ${actorUrl}`);
          setCachedPublicKey(actorUrl, cachedActorData.publicKey.publicKeyPem);
          return cachedActorData.publicKey.publicKeyPem;
        }
      }
    } else {
      logger.info(`Force refreshing public key for ${actorUrl}`);
      // Drop the in-memory entry, otherwise the refresh returns the stale key.
      invalidatePublicKey(actorUrl);
    }
    
    // Tier 3: remote fetch. safeFetch performs URL+DNS validation, manual
    // redirect re-validation, and a 10s timeout. BUGS.md H15.
    try {
      const response = await safeFetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch actor: ${response.status} for ${actorUrl}`);
        // Fall back to the cached key even when expired.
        if (cachedActorData?.publicKey?.publicKeyPem) {
          logger.warn(`Using expired cached public key for ${actorUrl}`);
          return cachedActorData.publicKey.publicKeyPem;
        }
        return null;
      }

      const actor = await response.json();

      if (actor.publicKey && actor.publicKey.publicKeyPem) {
        const publicKeyPem = actor.publicKey.publicKeyPem;
        setCachedPublicKey(actorUrl, publicKeyPem);
        
        try {
          const { error: profileUpdateError } = await supabase
            .from('profiles')
            .update({ 
              public_key: publicKeyPem,
              updated_at: new Date().toISOString()
            })
            .eq('federated_id', actorUrl);
          
          if (profileUpdateError) {
            logger.debug(`Could not update profile public key for ${actorUrl}:`, profileUpdateError);
          } else {
            logger.info(`Updated public key in profiles table for ${actorUrl}`);
          }
        } catch (profileError) {
          logger.debug('Failed to update profile public key:', profileError);
        }
        
        try {
          const actorUrlObj = new URL(actorUrl);
          await supabase
            .from('ap_actor_cache')
            .upsert({
              ap_id: actorUrl,
              domain: actorUrlObj.hostname,
              username: actor.preferredUsername || actorUrlObj.pathname.split('/').pop() || 'unknown',
              actor_data: actor,
              last_fetched_at: new Date().toISOString(),
              cache_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
              is_reachable: true,
              fetch_attempts: 0,
            }, {
              onConflict: 'ap_id',
            });
        } catch (cacheError) {
          logger.debug('Failed to cache actor data:', cacheError);
          // Non-fatal.
        }
        
        return publicKeyPem;
      }

      logger.warn(`Actor ${actorUrl} does not have publicKey`);
      return null;
    } catch (error) {
      logger.error(`Error fetching actor public key for ${actorUrl}:`, error);
      // Fall back to the cached key even when expired.
      if (cachedActorData?.publicKey?.publicKeyPem) {
        logger.warn(`Using expired cached public key for ${actorUrl} due to fetch error`);
        return cachedActorData.publicKey.publicKeyPem;
      }
      return null;
    }
  }

  /**
   * Signed GET for an ActivityPub object, for remotes running authorized
   * fetch / secure mode. Signs with any local user's key; falls back to an
   * unsigned fetch when no local user exists.
   */
  static async signedApFetch(url: string, timeoutMs = 8000): Promise<Response> {
    const supabase = getSupabaseClient();

    const { data: signer } = await supabase
      .from('user_private_keys')
      .select('user_id')
      .limit(1)
      .maybeSingle();

    let signingUserId = signer?.user_id;

    // No stored keys: signRequest generates a pair for the first local user.
    if (!signingUserId) {
      const { data: firstUser } = await supabase
        .from('profiles')
        .select('id')
        .eq('is_local', true)
        .limit(1)
        .maybeSingle();
      signingUserId = firstUser?.id;
    }

    const headers: Record<string, string> = {
      'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json',
    };

    if (signingUserId) {
      try {
        const signed = await this.signRequest(url, 'GET', null, signingUserId);
        Object.assign(headers, signed.headers);
      } catch (err) {
        logger.debug(`Could not sign AP GET request, proceeding unsigned: ${err}`);
      }
    }

    // safeFetch enforces URL+DNS validation per hop, follows manual redirects
    // with re-validation (max 3 hops), and bounds each attempt with timeoutMs.
    return safeFetch(url, {
      headers,
      timeoutMs,
    });
  }

  /** Digest header value: `SHA-256=<base64 sha256 of the body bytes>`. */
  static createDigest(body: any): string {
    // Buffer is hashed as raw bytes; objects are JSON-serialized first.
    const data = Buffer.isBuffer(body) ? body
      : typeof body === 'string' ? body
      : JSON.stringify(body);
    const hash = crypto.createHash('sha256').update(data).digest('base64');
    return `SHA-256=${hash}`;
  }
}

