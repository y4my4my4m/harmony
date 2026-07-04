import crypto from 'crypto';
import { getSupabaseClient } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { safeFetch } from '../utils/ssrfProtection.js';

// ---------------------------------------------------------------------------
// In-memory cache for parsed public keys.
//
// `fetchActorPublicKey` already has a multi-tier persistent cache (profiles
// table → ap_actor_cache table → remote HTTP fetch). But every inbound
// signature still pays at least one DB roundtrip per verify. For a single
// federation event with N inbox deliveries (each verified independently)
// that's N roundtrips just to fetch the same N strings.
//
// This LRU sits in front of the DB caches and stores raw PEM strings keyed
// by actorUrl. TTL is 1 hour, matching `ap_actor_cache.cache_expires_at` so
// invalidation semantics are consistent.
// ---------------------------------------------------------------------------
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

// Exported for tests / admin endpoints that may want to wipe the cache.
export const __publicKeyCache = {
  size: () => publicKeyCache.size,
  clear: () => publicKeyCache.clear(),
  invalidate: invalidatePublicKey,
};

export class SignatureService {
  /**
   * Generate RSA key pair for a user
   */
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
   * Sign an HTTP request for ActivityPub federation
   */
  static async signRequest(
    targetUrl: string,
    method: string,
    body: any | null,
    userId: string
  ): Promise<{ headers: Record<string, string>; digest?: string }> {
    const supabase = getSupabaseClient();

    // Get user profile
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('username, domain')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      throw new AppError(500, 'User not found');
    }

    // Get user's private key from user_private_keys table
    const initialKeyLookup = await supabase
      .from('user_private_keys')
      .select('private_key')
      .eq('user_id', userId)
      .single();
    const keyError = initialKeyLookup.error;
    let keyData = initialKeyLookup.data;

    // If no keys exist, generate them on-demand (lazy generation)
    if (keyError || !keyData || !keyData.private_key) {
      logger.info(`🔐 No keys found for user ${userId}, generating on-demand...`);
      
      try {
        const keys = await this.generateKeyPair();
        
        // Store private key
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
        
        // Update profile with public key - THIS IS CRITICAL for signature verification
        const { error: publicKeyError } = await supabase
          .from('profiles')
          .update({ public_key: keys.publicKey })
          .eq('id', userId);
        
        if (publicKeyError) {
          logger.error(`Failed to store public key for user ${userId}:`, publicKeyError);
          throw new AppError(500, 'Failed to store public key');
        }
        
        logger.info(`✅ Generated keys on-demand for user ${userId}`);
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
    
    // Create headers object (order matters for Misskey!)
    const headers: Record<string, string> = {
      'Host': url.host,
      'Date': date,
    };

    let digest: string | undefined;

    // Add digest if there's a body
    if (body && (method === 'POST' || method === 'PUT')) {
      const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
      const hash = crypto.createHash('sha256').update(bodyString).digest('base64');
      digest = `SHA-256=${hash}`;
      headers['Digest'] = digest;
    }

    // Build signing string including (request-target) for Misskey
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

    // Sign the string
    const sign = crypto.createSign('SHA256');
    sign.update(signingString);
    sign.end();

    const signature = sign.sign(privateKey, 'base64');

    // Create signature header (must include (request-target) for Misskey)
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
   * Verify an incoming HTTP signature
   * 
   * Security model:
   * 1. Parse signature header to get keyId, signed headers, and signature
   * 2. Extract actor URL from keyId (e.g., https://remote.server/users/alice#main-key -> https://remote.server/users/alice)
   * 3. Fetch actor's public key from their server (over HTTPS)
   * 4. Rebuild the signing string from the signed headers
   * 5. Verify the signature matches using the public key
   * 6. Optionally verify the Digest header matches the body hash
   */
  /**
   * Parse a Signature header (draft-cavage / RFC 9421 legacy form) into its
   * parameters. Quoted values may legally contain commas and `=` (keyId is a
   * URI, signature is base64) - a naive split(',') corrupts those.
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

      // Replay-window check (BUGS.md H18): if the request carries a Date
      // header (Mastodon-compatible implementations always sign it), reject
      // requests outside a ±5 minute skew window. Without this, a captured
      // signed request stays valid forever.
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

      // Extract actor URL from keyId (e.g., https://example.com/users/alice#main-key -> https://example.com/users/alice)
      const actorUrl = keyId.split('#')[0];

      // Fetch actor's public key from their server
      const publicKey = await this.fetchActorPublicKey(actorUrl);

      if (!publicKey) {
        logger.warn(`Could not fetch public key for ${actorUrl}`);
        return { verified: false, actorUrl, error: 'Could not fetch public key' };
      }

      // Body integrity (BUGS.md H19): for requests WITH a body, require a
      // Digest header that is COVERED BY the signature, then verify it.
      // Otherwise the signature only authenticates headers and the body can
      // be swapped freely.
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
        logger.debug(`✅ Digest verified for ${actorUrl}`);
      }

      // Rebuild signing string (handle (request-target) specially)
      const headerList = signedHeaders.split(' ');
      const requestTarget = `${method.toLowerCase()} ${path}`;
      
      const signingParts: string[] = [];
      
      for (const headerName of headerList) {
        if (headerName === '(request-target)') {
          signingParts.push(`(request-target): ${requestTarget}`);
        } else {
          // Try both lowercase and capitalized versions
          // Express normalizes headers to lowercase
          const value = headers[headerName.toLowerCase()] || headers[headerName];
          if (value) {
            // Use the lowercase header name as per HTTP Signature spec
            // The signing string should use lowercase header names
            signingParts.push(`${headerName.toLowerCase()}: ${value}`);
          } else {
            logger.warn(`Missing header in signature verification: ${headerName}`);
          }
        }
      }
      
      const signingString = signingParts.join('\n');

      // Verify signature using the actor's public key
      const verify = crypto.createVerify('SHA256');
      verify.update(signingString);
      verify.end();

      const verified = verify.verify(publicKey, sig, 'base64');

      // If verification failed, try refreshing the public key and retry ONCE
      // This handles cases where the remote user regenerated their keys
      if (!verified) {
        logger.info(`⚠️ Signature verification failed for ${actorUrl}, attempting key refresh...`);
        logger.debug(`Signed headers: ${signedHeaders}`);
        logger.debug(`Signing string:\n${signingString}`);
        logger.debug(`Public key (first 100 chars): ${publicKey.substring(0, 100)}...`);
        
        // Try fetching a fresh public key from the remote server
        const freshPublicKey = await this.fetchActorPublicKey(actorUrl, true);
        
        if (freshPublicKey && freshPublicKey !== publicKey) {
          logger.info(`🔑 Got different public key for ${actorUrl}, retrying verification...`);
          
          // Retry verification with fresh key
          const retryVerify = crypto.createVerify('SHA256');
          retryVerify.update(signingString);
          retryVerify.end();
          
          const retryVerified = retryVerify.verify(freshPublicKey, sig, 'base64');
          
          if (retryVerified) {
            logger.info(`✅ Signature verified after key refresh for ${actorUrl}`);
            return { verified: true, actorUrl };
          } else {
            logger.warn(`❌ Signature still invalid after key refresh for ${actorUrl}`);
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
   * - **Strict (default)**: `activity.actor` must EXACTLY equal the signing
   *   key owner URL after normalization. Use this for `Person`-actor activities
   *   (user inbox: Create Note, Like, Follow, Update Person, Delete Note, ...).
   *   Allowing same-domain delegation here would let any compromised /
   *   legitimate user on a remote host forge activities for any other user on
   *   the same host (cross-user impersonation). See BUGS.md item C1.
   *
   * - **Group delegation** (`allowSameDomainDelegation = true`): when the
   *   activity is on behalf of a `Group`/`Service` actor that is conventionally
   *   acted upon by an authorized member on the same domain (e.g. Lemmy
   *   `c/<community>` announcements signed by `u/<moderator>`), accept any
   *   signer on the same host. Use this only for the server inbox.
   *
   * @param activityActor URL of the `activity.actor` from the inbox payload.
   * @param signingActorUrl URL resolved from the signature `keyId`.
   * @param allowSameDomainDelegation Set to `true` only when the inbox is
   *   semantically a Group/Service inbox (server inbox). Defaults to `false`.
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
   * Fetch actor's public key from their server
   * First checks local database (profiles table), then cache, then remote fetch
   * @param forceRefresh - If true, skip cache and fetch directly from remote
   */
  private static async fetchActorPublicKey(actorUrl: string, forceRefresh = false): Promise<string | null> {
    const supabase = getSupabaseClient();
    
    // Declare cachedActor outside the if block so it's in scope for fallback logic
    let cachedActorData: any = null;
    
    if (!forceRefresh) {
      // 0. In-memory LRU. Skips two DB roundtrips per verify on warm cache.
      const memHit = getCachedPublicKey(actorUrl);
      if (memHit) {
        return memHit;
      }
      
      // First, check if we have this actor in our profiles table
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
      
      // Second, check actor cache table (also check expired cache for fallback)
      const { data: cachedActor } = await supabase
        .from('ap_actor_cache')
        .select('actor_data, cache_expires_at')
        .eq('ap_id', actorUrl)
        .maybeSingle();
      
      // Store for potential fallback use
      cachedActorData = cachedActor?.actor_data;
      
      // Only use cache if not expired
      if (cachedActor?.cache_expires_at && new Date(cachedActor.cache_expires_at) > new Date()) {
        if (cachedActorData?.publicKey?.publicKeyPem) {
          logger.debug(`Using cached actor data for ${actorUrl}`);
          setCachedPublicKey(actorUrl, cachedActorData.publicKey.publicKeyPem);
          return cachedActorData.publicKey.publicKeyPem;
        }
      }
    } else {
      logger.info(`🔄 Force refreshing public key for ${actorUrl}`);
      // Invalidate stale in-memory entry so the refresh actually re-fetches.
      invalidatePublicKey(actorUrl);
    }
    
    // Finally, fetch from remote server.
    // safeFetch handles URL+DNS validation, manual redirect re-validation,
    // and the 10s timeout - supersedes the previous `validateExternalUrl` +
    // raw fetch + `AbortSignal.timeout` pattern. BUGS.md H15.
    try {
      const response = await safeFetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch actor: ${response.status} for ${actorUrl}`);
        // If we have a cached actor (even expired), try using it anyway
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
        
        // Update the profiles table with the fresh public key
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
            logger.info(`✅ Updated public key in profiles table for ${actorUrl}`);
          }
        } catch (profileError) {
          logger.debug('Failed to update profile public key:', profileError);
        }
        
        // Cache the actor data for future use
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
          // Non-fatal, continue
        }
        
        return publicKeyPem;
      }

      logger.warn(`Actor ${actorUrl} does not have publicKey`);
      return null;
    } catch (error) {
      logger.error(`Error fetching actor public key for ${actorUrl}:`, error);
      // If we have a cached actor (even expired), try using it anyway
      if (cachedActorData?.publicKey?.publicKeyPem) {
        logger.warn(`Using expired cached public key for ${actorUrl} due to fetch error`);
        return cachedActorData.publicKey.publicKeyPem;
      }
      return null;
    }
  }

  /**
   * Fetch an ActivityPub object with HTTP signature (for authorized fetch / secure mode).
   * Uses any local user's keys to sign the GET request.
   * Falls back to unsigned fetch if no local user is available.
   */
  static async signedApFetch(url: string, timeoutMs = 8000): Promise<Response> {
    const supabase = getSupabaseClient();

    // Find any local user that has a private key
    const { data: signer } = await supabase
      .from('user_private_keys')
      .select('user_id')
      .limit(1)
      .maybeSingle();

    let signingUserId = signer?.user_id;

    // If no keys exist yet, pick the first local user and let signRequest generate keys
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

  /**
   * Create digest header for request body
   */
  static createDigest(body: any): string {
    // Accept Buffer (raw bytes), string, or object
    const data = Buffer.isBuffer(body) ? body
      : typeof body === 'string' ? body
      : JSON.stringify(body);
    const hash = crypto.createHash('sha256').update(data).digest('base64');
    return `SHA-256=${hash}`;
  }
}

