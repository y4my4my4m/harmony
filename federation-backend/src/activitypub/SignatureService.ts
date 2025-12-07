import crypto from 'crypto';
import { getSupabaseClient } from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';

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
    let { data: keyData, error: keyError } = await supabase
      .from('user_private_keys')
      .select('private_key')
      .eq('user_id', userId)
      .single();

    // If no keys exist, generate them on-demand (lazy generation)
    if (keyError || !keyData || !keyData.private_key) {
      logger.info(`🔐 No keys found for user ${userId}, generating on-demand...`);
      
      try {
        const keys = await this.generateKeyPair();
        
        // Store private key
        await supabase
          .from('user_private_keys')
          .upsert({
            user_id: userId,
            private_key: keys.privateKey,
            created_at: new Date().toISOString()
          });
        
        // Update profile with public key
        await supabase
          .from('profiles')
          .update({ public_key: keys.publicKey })
          .eq('id', userId);
        
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
  static async verifySignature(
    signature: string,
    headers: Record<string, string>,
    method: string,
    path: string,
    body?: any
  ): Promise<{ verified: boolean; actorUrl?: string; error?: string }> {
    try {
      // Parse signature header
      const signatureParts = signature.split(',').reduce((acc, part) => {
        const [key, ...valueParts] = part.split('=');
        const value = valueParts.join('=').replace(/"/g, '');
        acc[key.trim()] = value;
        return acc;
      }, {} as Record<string, string>);

      const { keyId, headers: signedHeaders, signature: sig } = signatureParts;

      if (!keyId || !signedHeaders || !sig) {
        logger.warn('Missing signature components');
        return { verified: false, error: 'Missing signature components' };
      }

      // Extract actor URL from keyId (e.g., https://example.com/users/alice#main-key -> https://example.com/users/alice)
      const actorUrl = keyId.split('#')[0];

      // Fetch actor's public key from their server
      const publicKey = await this.fetchActorPublicKey(actorUrl);

      if (!publicKey) {
        logger.warn(`Could not fetch public key for ${actorUrl}`);
        return { verified: false, actorUrl, error: 'Could not fetch public key' };
      }

      // Verify Digest header if present and body is provided
      const digestHeader = headers['digest'] || headers['Digest'];
      if (digestHeader && body) {
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
          const value = headers[headerName.toLowerCase()] || headers[headerName];
          if (value) {
            signingParts.push(`${headerName}: ${value}`);
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

      logger.debug(`Signature verification for ${actorUrl}: ${verified}`);

      return { verified, actorUrl };
    } catch (error) {
      logger.error('Signature verification error:', error);
      return { verified: false, error: String(error) };
    }
  }

  /**
   * Verify that the actor in the activity matches the signing key's owner
   * This prevents an attacker from signing an activity on behalf of another user
   */
  static verifyActorMatch(activityActor: string, signingActorUrl: string): boolean {
    // Normalize URLs for comparison (remove trailing slashes, etc.)
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

    if (actorNormalized !== signingNormalized) {
      logger.warn(`Actor mismatch: activity.actor=${activityActor}, signing key owner=${signingActorUrl}`);
      return false;
    }

    return true;
  }

  /**
   * Fetch actor's public key from their server
   * First checks local database (profiles table), then cache, then remote fetch
   */
  private static async fetchActorPublicKey(actorUrl: string): Promise<string | null> {
    const supabase = getSupabaseClient();
    
    // First, check if we have this actor in our profiles table
    const { data: profile } = await supabase
      .from('profiles')
      .select('public_key')
      .eq('federated_id', actorUrl)
      .maybeSingle();
    
    if (profile?.public_key) {
      logger.debug(`Using cached public key from profiles table for ${actorUrl}`);
      return profile.public_key;
    }
    
    // Second, check actor cache table
    const { data: cachedActor } = await supabase
      .from('ap_actor_cache')
      .select('actor_data, cache_expires_at')
      .eq('ap_id', actorUrl)
      .gt('cache_expires_at', new Date().toISOString())
      .maybeSingle();
    
    if (cachedActor?.actor_data) {
      const actor = cachedActor.actor_data;
      if (actor.publicKey?.publicKeyPem) {
        logger.debug(`Using cached actor data for ${actorUrl}`);
        return actor.publicKey.publicKeyPem;
      }
    }
    
    // Finally, fetch from remote server
    try {
      const response = await fetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch actor: ${response.status} for ${actorUrl}`);
        // If we have a cached actor that's expired, try using it anyway
        if (cachedActor?.actor_data?.publicKey?.publicKeyPem) {
          logger.warn(`Using expired cached public key for ${actorUrl}`);
          return cachedActor.actor_data.publicKey.publicKeyPem;
        }
        return null;
      }

      const actor = await response.json();

      if (actor.publicKey && actor.publicKey.publicKeyPem) {
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
        
        return actor.publicKey.publicKeyPem;
      }

      logger.warn(`Actor ${actorUrl} does not have publicKey`);
      return null;
    } catch (error) {
      logger.error(`Error fetching actor public key for ${actorUrl}:`, error);
      // If we have a cached actor that's expired, try using it anyway
      if (cachedActor?.actor_data?.publicKey?.publicKeyPem) {
        logger.warn(`Using expired cached public key for ${actorUrl} due to fetch error`);
        return cachedActor.actor_data.publicKey.publicKeyPem;
      }
      return null;
    }
  }

  /**
   * Create digest header for request body
   */
  static createDigest(body: any): string {
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    const hash = crypto.createHash('sha256').update(bodyString).digest('base64');
    return `SHA-256=${hash}`;
  }
}

