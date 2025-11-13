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
    const { data: keyData, error: keyError } = await supabase
      .from('user_private_keys')
      .select('private_key')
      .eq('user_id', userId)
      .single();

    if (keyError || !keyData || !keyData.private_key) {
      logger.error(`Failed to get private key for user ${userId}:`, keyError);
      throw new AppError(500, 'User private key not found');
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
   */
  static async verifySignature(
    signature: string,
    headers: Record<string, string>,
    method: string,
    path: string
  ): Promise<{ verified: boolean; actorUrl?: string }> {
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
        return { verified: false };
      }

      // Extract actor URL from keyId
      const actorUrl = keyId.split('#')[0];

      // Fetch actor's public key
      const publicKey = await this.fetchActorPublicKey(actorUrl);

      if (!publicKey) {
        logger.warn(`Could not fetch public key for ${actorUrl}`);
        return { verified: false };
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

      // Verify signature
      const verify = crypto.createVerify('SHA256');
      verify.update(signingString);
      verify.end();

      const verified = verify.verify(publicKey, sig, 'base64');

      logger.debug(`Signature verification for ${actorUrl}: ${verified}`);

      return { verified, actorUrl };
    } catch (error) {
      logger.error('Signature verification error:', error);
      return { verified: false };
    }
  }

  /**
   * Fetch actor's public key from their server
   */
  private static async fetchActorPublicKey(actorUrl: string): Promise<string | null> {
    try {
      const response = await fetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch actor: ${response.status}`);
        return null;
      }

      const actor = await response.json();

      if (actor.publicKey && actor.publicKey.publicKeyPem) {
        return actor.publicKey.publicKeyPem;
      }

      logger.warn('Actor does not have publicKey');
      return null;
    } catch (error) {
      logger.error('Error fetching actor public key:', error);
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

