/**
 * Push relay: a Web Push service (RFC 8030) in front of FCM, for the Android app this
 * instance's Firebase project built.
 *
 * An FCM token reaches only a sender holding the service account of the app's Firebase
 * project. Instances without it register the app's relay endpoint as an ordinary UnifiedPush
 * subscription, `https://<relay>/push/relay/fcm/<token>`, with keys the app generated, and send
 * encrypted Web Push to it as to any distributor. The relay forwards the ciphertext unread as
 * the FCM data field `wp` (base64url); the app decrypts it with its UnifiedPush key manager.
 *
 *   POST /push/relay/fcm/:token
 *     Content-Encoding: aes128gcm (RFC 8291), body at most MAX_BODY_BYTES
 *     Authorization: vapid t=<ES256 JWT>, k=<P-256 public key> (RFC 8292); aud is this
 *       instance's origin, exp within a day. Senders are counted by k.
 *     TTL, Urgency (high: FCM priority HIGH), Topic (FCM collapse_key)
 *   201 forwarded; 404 relay off or not a token; 410 FCM no longer knows the token;
 *   413 too large for one FCM message; 415 not aes128gcm; 401 no valid VAPID; 429 limits.
 *
 * FCM caps a data message at 4096 bytes of keys and values: "wp" and 4080 base64url
 * characters, 3060 bytes of ciphertext.
 */

import { Router, type Request, type Response } from 'express';
import { createHash, createPublicKey, verify as verifySignature } from 'crypto';
import config from '../config/index.js';
import { PushNotificationService } from '../services/PushNotificationService.js';
import { isValidFcmToken } from '../services/pushPolicy.js';
import { pushRelaySenderLimit, pushRelayTokenLimit } from '../middleware/rateLimit.js';
import { logger } from '../utils/logger.js';

export const MAX_BODY_BYTES = 3060;
/** RFC 8030 TTL: FCM keeps a message at most 28 days. */
const MAX_TTL_SECONDS = 28 * 24 * 3600;
/** RFC 8292: a JWT valid for at most a day. */
const MAX_VAPID_LIFETIME_S = 24 * 3600;

const router = Router();

const base64url = (input: Buffer): string =>
  input.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function fromBase64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** `vapid t=…, k=…` parameters; null for any other scheme. */
export function parseVapidAuthorization(header: string | undefined): { t: string; k: string } | null {
  const match = /^vapid\s+(.+)$/i.exec((header || '').trim());
  if (!match) return null;
  const params = new Map<string, string>();
  for (const part of match[1].split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) params.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const t = params.get('t');
  const k = params.get('k');
  return t && k ? { t, k } : null;
}

/**
 * Verifies a VAPID JWT against its uncompressed P-256 key `k`. The reason names the first
 * failed check; null when every check passes.
 */
export function vapidProblem(t: string, k: string, audience: string, nowS: number): string | null {
  const key = fromBase64url(k);
  if (!key || key.length !== 65 || key[0] !== 0x04) return 'k is not an uncompressed P-256 key';
  const parts = t.split('.');
  if (parts.length !== 3) return 'malformed JWT';
  let header: { alg?: string; typ?: string };
  let claims: { aud?: string; exp?: number; sub?: string };
  try {
    header = JSON.parse(fromBase64url(parts[0])?.toString('utf8') ?? '');
    claims = JSON.parse(fromBase64url(parts[1])?.toString('utf8') ?? '');
  } catch {
    return 'malformed JWT';
  }
  if (header.alg !== 'ES256') return 'alg is not ES256';
  if (claims.aud !== audience) return 'aud is not this relay';
  if (typeof claims.exp !== 'number' || claims.exp <= nowS) return 'expired';
  if (claims.exp > nowS + MAX_VAPID_LIFETIME_S) return 'exp further than a day';
  const signature = fromBase64url(parts[2]);
  if (!signature || signature.length !== 64) return 'malformed signature';
  try {
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: base64url(key.subarray(1, 33)), y: base64url(key.subarray(33, 65)) },
      format: 'jwk',
    });
    const ok = verifySignature('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    return ok ? null : 'bad signature';
  } catch {
    return 'bad key';
  }
}

const relayOrigin = (): string => `https://${config.INSTANCE_DOMAIN}`;

/**
 * The body as sent. express.raw refuses it: body-parser answers 415 to any Content-Encoding it
 * cannot inflate, and Web Push is always aes128gcm. Null past `limit` bytes.
 */
function readBody(req: Request, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) over = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);

router.post(
  '/fcm/:token',
  async (req: Request, res: Response): Promise<void> => {
    const fcm = PushNotificationService.getFcmSender();
    const token = req.params.token;
    if (!config.PUSH_RELAY_ENABLED || !fcm.isConfigured() || !isValidFcmToken(token)) {
      res.status(404).end();
      return;
    }
    if (String(req.headers['content-encoding'] || '').toLowerCase() !== 'aes128gcm') {
      res.status(415).json({ error: 'Content-Encoding must be aes128gcm' });
      return;
    }
    const vapid = parseVapidAuthorization(req.headers.authorization);
    const problem = vapid ? vapidProblem(vapid.t, vapid.k, relayOrigin(), Math.floor(Date.now() / 1000)) : 'no VAPID authorization';
    if (problem) {
      res.status(401).json({ error: `VAPID: ${problem}` });
      return;
    }
    if (!(await pushRelaySenderLimit(res, digest(vapid!.k)))) return;
    if (!(await pushRelayTokenLimit(res, digest(token)))) return;

    const body = await readBody(req, MAX_BODY_BYTES).catch(() => Buffer.alloc(0));
    if (body && body.length === 0) {
      res.status(400).json({ error: 'empty message' });
      return;
    }
    if (!body) {
      res.status(413).json({ error: `message larger than ${MAX_BODY_BYTES} bytes` });
      return;
    }

    const ttl = Number.parseInt(String(req.headers.ttl ?? '0'), 10);
    const topic = String(req.headers.topic ?? '');
    const result = await fcm.send(token, { wp: base64url(body) }, {
      priority: String(req.headers.urgency ?? '').toLowerCase() === 'high' ? 'high' : 'normal',
      ttlSeconds: Number.isFinite(ttl) ? Math.min(Math.max(ttl, 0), MAX_TTL_SECONDS) : 0,
      ...(/^[A-Za-z0-9_-]{1,32}$/.test(topic) ? { collapseKey: topic } : {}),
    });
    if (result.ok) {
      res.status(201).end();
      return;
    }
    if (result.prune) {
      res.status(410).json({ error: 'the device is no longer registered' });
      return;
    }
    if (result.status === 429) {
      res.setHeader('Retry-After', '60');
      res.status(429).json({ error: 'FCM quota exceeded' });
      return;
    }
    logger.warn(`Push relay to FCM failed (${result.status}): ${result.reason}`);
    res.status(502).json({ error: 'FCM did not accept the message' });
  },
);

export default router;
