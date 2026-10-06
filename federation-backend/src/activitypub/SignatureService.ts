import crypto from 'crypto';
import { deletedActorByProfile } from './deletedActors.js';
import { getSupabaseClient } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import { safeFetch, type SafeFetchOptions } from '../utils/ssrfProtection.js';
import { actorOwnsKeys, readApDocument, sameUrl } from '../utils/apOrigin.js';
import { noteDocumentSoftware } from './instanceSoftware.js';
import { contentDigestMatches, coversRequest, parseMessageSignature, signatureBase, verifyRsaV15Sha256 } from './messageSignatures.js';

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

// keyId → owning actor URL, for keyIds that are not `<actor>#fragment`.
// GoToSocial keyIds are `<actor>/main-key`; dereferencing one returns an
// actor stub whose `id` is the owner.
const KEY_OWNER_CACHE_MAX = 5_000;
const keyOwnerCache = new Map<string, string>();

function setKeyOwner(keyId: string, owner: string): void {
  if (keyOwnerCache.size >= KEY_OWNER_CACHE_MAX) {
    const oldest = keyOwnerCache.keys().next().value;
    if (oldest !== undefined) keyOwnerCache.delete(oldest);
  }
  keyOwnerCache.set(keyId, owner);
}

/** PEM of the first publicKey object owned by the actor. */
function ownedPublicKeyPem(actor: any): string | null {
  const keys = Array.isArray(actor?.publicKey) ? actor.publicKey : [actor?.publicKey];
  const key = keys.find((k: any) => k && typeof k === 'object' && k.owner === actor.id
    && typeof k.publicKeyPem === 'string' && k.publicKeyPem);
  return key?.publicKeyPem ?? null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

// Exported for tests and admin endpoints that wipe the cache.
export const __publicKeyCache = {
  size: () => publicKeyCache.size,
  clear: () => {
    publicKeyCache.clear();
    keyOwnerCache.clear();
  },
  invalidate: invalidatePublicKey,
};

export interface SignedApFetchOptions extends SafeFetchOptions {
  /** Local profile id whose key signs the request. */
  signAs?: string;
}

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
      .select('username, domain, deleted_at')
      .eq('id', userId)
      .single();

    if (userError || !user) {
      throw new AppError(500, 'User not found');
    }

    // A deleted account signs with the key and keyId it had, held in deleted_actors until
    // key_purge_after. No key is generated for it.
    if (user.deleted_at) {
      const tombstone = await deletedActorByProfile(userId);
      if (!tombstone?.private_key) {
        throw new AppError(410, 'Actor deleted');
      }
      return this.signWithKey(targetUrl, method, body, `${tombstone.actor_uri}#main-key`, tombstone.private_key);
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
    
    const keyId = `https://${user.domain}/users/${user.username}#main-key`;
    const signed = this.signWithKey(targetUrl, method, body, keyId, keyData.private_key);
    logger.debug(`Signed request to ${targetUrl}`);
    return signed;
  }

  /**
   * draft-cavage signature over (request-target), host, date and, for a POST or
   * PUT body, digest, with the given key. Misskey requires (request-target) in
   * the signed list, and header insertion order is significant to it.
   */
  static signWithKey(
    targetUrl: string,
    method: string,
    body: any | null,
    keyId: string,
    privateKey: string
  ): { headers: Record<string, string>; digest?: string } {
    const url = new URL(targetUrl);
    const date = new Date().toUTCString();
    const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search}`;

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
      const value = headers[header.charAt(0).toUpperCase() + header.slice(1)];
      if (value) {
        signingParts.push(`${header}: ${value}`);
      }
    });

    const signature = crypto.createSign('SHA256').update(signingParts.join('\n')).sign(privateKey, 'base64');

    headers['Signature'] = [
      `keyId="${keyId}"`,
      'algorithm="rsa-sha256"',
      `headers="${signedHeaders.join(' ')}"`,
      `signature="${signature}"`,
    ].join(',');

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
   * Verify an inbound HTTP signature: RFC 9421 when a Signature-Input header
   * is present (verifyMessageSignature), draft-cavage otherwise.
   *
   * draft-cavage: the key owner is resolved from keyId and its public key
   * fetched, the signing string is rebuilt from the signed header list, and
   * the signature is checked against it. A body additionally requires a
   * signature-covered Digest header.
   *
   * @param scheme Scheme the request reached this instance by (Express
   *   `req.protocol`), part of an RFC 9421 `@target-uri`.
   */
  static async verifySignature(
    signature: string,
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: any,
    scheme = 'https',
  ): Promise<{ verified: boolean; actorUrl?: string; error?: string }> {
    const signatureInput = headers['signature-input'];
    if (typeof signatureInput === 'string' && signatureInput) {
      return this.verifyMessageSignature(signatureInput, signature, headers, method, path, body, scheme);
    }
    try {
      const signatureParts = this.parseSignatureHeader(signature);

      const { keyId, headers: signedHeaders, signature: sig } = signatureParts;

      if (!keyId || !signedHeaders || !sig) {
        logger.warn('Missing signature components');
        return { verified: false, error: 'Missing signature components' };
      }

      // Replay window (BUGS.md H18): Date must be present and covered by the
      // signature, and within ±5 minutes. An unsigned Date can be rewritten
      // on a captured request. Mastodon applies the same requirement
      // (verify_signature_strength!); `(created)` is not supported here.
      const signedHeaderList = signedHeaders.toLowerCase().split(/\s+/).filter(Boolean);
      if (!signedHeaderList.includes('date')) {
        return { verified: false, error: 'Date header not included in signed headers' };
      }
      const dateHeader = headers['date'] || headers['Date'];
      if (!dateHeader) {
        return { verified: false, error: 'Missing Date header' };
      }
      const requestTime = Date.parse(dateHeader);
      const MAX_SKEW_MS = 5 * 60 * 1000;
      if (Number.isNaN(requestTime)) {
        return { verified: false, error: 'Unparseable Date header' };
      }
      if (Math.abs(Date.now() - requestTime) > MAX_SKEW_MS) {
        logger.warn(`Request Date outside allowed skew: ${dateHeader}`);
        return { verified: false, error: 'Request Date outside allowed clock skew (possible replay)' };
      }

      const actorUrl = await this.resolveKeyOwner(keyId);
      if (!actorUrl) {
        logger.warn(`Could not resolve owner of key ${keyId}`);
        return { verified: false, error: 'Could not resolve key owner' };
      }

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
   * RFC 9421 verification of an inbound request, in the profile
   * messageSignatures.ts accepts. Freshness, the request target and body
   * integrity are required as for draft-cavage: `created` within ±5 minutes,
   * `@method` and the target covered, a body covered by a matching
   * Content-Digest.
   */
  private static async verifyMessageSignature(
    signatureInput: string,
    signature: string,
    headers: Record<string, string>,
    method: string,
    path: string,
    body: any,
    scheme: string,
  ): Promise<{ verified: boolean; actorUrl?: string; error?: string }> {
    try {
      const sig = parseMessageSignature(signatureInput, signature ?? '');
      if ('error' in sig) return { verified: false, error: sig.error };

      if (sig.alg !== null && sig.alg !== 'rsa-v1_5-sha256') {
        return { verified: false, error: `Unsupported signature algorithm ${sig.alg}` };
      }
      if (!coversRequest(sig, path)) {
        return { verified: false, error: 'Signature does not cover the method and target' };
      }
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - sig.created) > 5 * 60) {
        return { verified: false, error: 'Signature created outside allowed clock skew (possible replay)' };
      }
      if (sig.expires !== null && sig.expires < now) {
        return { verified: false, error: 'Signature expired' };
      }

      const hasBody = body !== undefined && body !== null
        && !(Buffer.isBuffer(body) && body.length === 0) && body !== '';
      if (hasBody) {
        const digest = headers['content-digest'];
        if (!sig.components.includes('content-digest') || typeof digest !== 'string') {
          return { verified: false, error: 'Content-Digest not covered by the signature' };
        }
        const bytes = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
        if (!contentDigestMatches(digest, bytes)) {
          return { verified: false, error: 'Content-Digest mismatch - body may have been tampered' };
        }
      }

      const base = signatureBase(sig, { method, scheme, target: path, headers });
      if (typeof base !== 'string') return { verified: false, error: base.error };

      const actorUrl = await this.resolveKeyOwner(sig.keyId);
      if (!actorUrl) return { verified: false, error: 'Could not resolve key owner' };
      const publicKey = await this.fetchActorPublicKey(actorUrl);
      if (!publicKey) return { verified: false, actorUrl, error: 'Could not fetch public key' };

      if (verifyRsaV15Sha256(base, sig.signature, publicKey)) return { verified: true, actorUrl };

      // One retry against a freshly fetched key; covers remote key rotation.
      const fresh = await this.fetchActorPublicKey(actorUrl, true);
      if (fresh && fresh !== publicKey && verifyRsaV15Sha256(base, sig.signature, fresh)) {
        return { verified: true, actorUrl };
      }
      return { verified: false, actorUrl, error: 'Signature does not verify' };
    } catch (error) {
      logger.error('RFC 9421 signature verification error:', error);
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
   * Actor URL owning `keyId`. A `<actor>#fragment` keyId names its owner. Any
   * other keyId is dereferenced once: the document is the actor itself
   * (`id === keyId`), a Key naming its `owner`, or an actor stub listing the
   * keyId under `publicKey` (GoToSocial `<actor>/main-key`). The owner must
   * be on the keyId's host.
   */
  private static async resolveKeyOwner(keyId: string): Promise<string | null> {
    const hashAt = keyId.indexOf('#');
    if (hashAt >= 0) return keyId.slice(0, hashAt);

    const cached = keyOwnerCache.get(keyId);
    if (cached) return cached;

    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', keyId)
      .maybeSingle();
    if (profile) {
      setKeyOwner(keyId, keyId);
      return keyId;
    }

    try {
      const response = await this.signedApFetch(keyId, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
        timeoutMs: 10_000,
      });
      const fetched = await readApDocument(response, keyId);
      if (!fetched || !sameUrl(fetched.finalUrl, keyId)) {
        logger.warn(`Key document fetch failed: ${response.status} ${response.headers.get('content-type') ?? ''} for ${keyId}`);
        return null;
      }
      const doc = fetched.doc;

      let owner: string | null = null;
      if (doc?.id === keyId) {
        owner = typeof doc.owner === 'string' ? doc.owner : keyId;
      } else if (typeof doc?.id === 'string') {
        const keys = Array.isArray(doc.publicKey) ? doc.publicKey : [doc.publicKey];
        if (keys.some((k: any) => k?.id === keyId)) owner = doc.id;
      }

      if (!owner || hostOf(owner) === null || hostOf(owner) !== hostOf(keyId)) {
        logger.warn(`Key ${keyId} has no owner on its own host`);
        return null;
      }
      setKeyOwner(keyId, owner);
      return owner;
    } catch (error) {
      logger.warn(`Error resolving owner of key ${keyId}:`, error);
      return null;
    }
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
    
    // Tier 3: remote fetch, signed: a remote in secure mode serves its
    // actors only to signed GETs. safeFetch performs URL+DNS validation,
    // manual redirect re-validation, and the timeout. BUGS.md H15.
    try {
      const response = await this.signedApFetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
        timeoutMs: 10_000,
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

      // The key comes only from the document served at actorUrl whose id is
      // actorUrl and whose key names it as owner.
      const fetched = await readApDocument(response, actorUrl);
      const actor = fetched && sameUrl(fetched.doc?.id, actorUrl) && sameUrl(fetched.finalUrl, actorUrl)
        && actorOwnsKeys(fetched.doc) ? fetched.doc : null;
      if (!actor) {
        logger.warn(`Actor document for ${actorUrl} is not served at its own id with an owned key`);
        return null;
      }

      const publicKeyPem = ownedPublicKeyPem(actor);
      if (publicKeyPem) {
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
        
        noteDocumentSoftware(actorUrl, actor);

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
   * GET signed with a draft-cavage HTTP signature over (request-target), host
   * and date, as Mastodon, Misskey, Pleroma and GoToSocial sign theirs.
   * Remotes in authorized fetch / secure mode refuse unsigned GETs (Mastodon
   * and GoToSocial with 401, some with 400).
   *
   * With `signAs`, that local user's key signs and a signing failure throws:
   * a read on a member's behalf is never sent unsigned or under another key.
   * Without it the instance actor signs, as Mastodon signs with
   * Account.representative and Misskey with instance.actor; the request goes
   * unsigned only when the instance actor key cannot be read.
   *
   * A 401 or 403 is returned as received: the remote refused this instance,
   * and an unsigned retry would only bypass that refusal. Each redirect hop
   * is signed for its own target.
   *
   * `options` is forwarded to `safeFetch`; the signature headers
   * (`Host`/`Date`/`Signature`) are applied over the caller's.
   */
  static async signedApFetch(url: string, options: SignedApFetchOptions = {}): Promise<Response> {
    const { timeoutMs = 10_000, headers: callerHeaders, signal, maxRedirects, maxBodyBytes, signAs } = options;

    const headers: Record<string, string> = {
      'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json',
      ...(callerHeaders as Record<string, string> | undefined),
    };

    let sign: (target: string) => Promise<Record<string, string>>;
    if (signAs) {
      // signRequest generates and stores a key pair for a profile without
      // one; a remote profile's published key would be replaced.
      const { data: signer } = await getSupabaseClient()
        .from('profiles')
        .select('is_local')
        .eq('id', signAs)
        .maybeSingle();
      if (signer?.is_local !== true) {
        throw new AppError(500, `Cannot sign as ${signAs}: not a local profile`);
      }
      sign = async (target) => (await this.signRequest(target, 'GET', null, signAs)).headers;
    } else {
      sign = async (target) => {
        try {
          const { signAsInstanceActor } = await import('./InstanceActor.js');
          return (await signAsInstanceActor(target, 'GET', null)).headers;
        } catch (err) {
          logger.warn(`Instance actor cannot sign the GET of ${target}; sending it unsigned: ${err}`);
          return {};
        }
      };
    }

    Object.assign(headers, await sign(url));

    return safeFetch(url, {
      headers,
      timeoutMs,
      redirectHeaders: sign,
      ...(signal !== undefined ? { signal } : {}),
      ...(maxRedirects !== undefined ? { maxRedirects } : {}),
      ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
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

