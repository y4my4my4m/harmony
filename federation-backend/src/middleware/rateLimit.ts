import { Request, Response, NextFunction } from 'express';
import { isIP } from 'net';
import config from '../config/index.js';
import { redis } from '../services/RedisService.js';

/**
 * Client address for rate limiting. Behind a trusted proxy (Express `trust
 * proxy`, see server.ts) it is X-Real-IP, which nginx sets to $remote_addr on
 * every location proxied here; X-Forwarded-For is never read, since a client
 * prepends to it and nginx locations that do not set it pass it through. From
 * any other peer it is the socket address.
 */
export function clientIp(req: Request): string {
  const peer = req.socket?.remoteAddress ?? '';
  const trust = req.app?.get('trust proxy fn') as ((addr: string, i: number) => boolean) | undefined;
  if (peer && trust?.(peer, 0)) {
    const real = req.headers['x-real-ip'];
    const value = typeof real === 'string' ? real.trim() : '';
    if (value && isIP(value)) return value;
  }
  return peer || 'unknown';
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory fallback when Redis is unavailable
const memoryStore = new Map<string, RateLimitEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore.entries()) {
    if (entry.resetTime < now) {
      memoryStore.delete(key);
    }
  }
}, 60_000);

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

async function consume(rawKey: string, windowMs: number, maxRequests: number): Promise<RateLimitResult> {
  if (redis.ready) {
    const result = await redis.rateLimit(`rl:${rawKey}`, maxRequests, Math.ceil(windowMs / 1000));
    return { allowed: result.allowed, remaining: result.remaining, resetMs: result.resetMs };
  }

  const now = Date.now();
  let entry = memoryStore.get(rawKey);
  if (!entry || entry.resetTime < now) {
    entry = { count: 1, resetTime: now + windowMs };
    memoryStore.set(rawKey, entry);
  } else {
    entry.count++;
  }
  return {
    allowed: entry.count <= maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    resetMs: entry.resetTime - now,
  };
}

/** Sets the rate-limit headers; on refusal also sends 429. True when the request may proceed. */
function answer(res: Response, maxRequests: number, result: RateLimitResult, message: string): boolean {
  res.setHeader('X-RateLimit-Limit', maxRequests);
  res.setHeader('X-RateLimit-Remaining', result.allowed ? result.remaining : 0);
  res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + result.resetMs) / 1000));
  if (result.allowed) return true;
  res.setHeader('Retry-After', Math.ceil(result.resetMs / 1000));
  res.status(429).json({
    error: 'Too Many Requests',
    message,
    retryAfter: Math.ceil(result.resetMs / 1000),
  });
  return false;
}

function createRateLimiter(options: {
  // Distinct per limiter: without it, two default-keyed limiters (e.g. api and
  // inbox) share the same `rl:<ip>` bucket and steal each other's budget.
  name: string;
  windowMs: number;
  maxRequests: number;
  message?: string;
  keyGenerator?: (req: Request) => string;
}) {
  const {
    name,
    windowMs,
    maxRequests,
    message = 'Too many requests, please try again later.',
    keyGenerator = clientIp,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    const result = await consume(`${name}:${keyGenerator(req)}`, windowMs, maxRequests);
    if (answer(res, maxRequests, result, message)) next();
  };
}

/**
 * A limiter keyed by the caller rather than by the request, for keys known only
 * inside a handler. Returns false after sending 429.
 */
function createKeyedLimit(options: { name: string; windowMs: number; maxRequests: number; message: string }) {
  const { name, windowMs, maxRequests, message } = options;
  return async (res: Response, key: string): Promise<boolean> =>
    answer(res, maxRequests, await consume(`${name}:${key}`, windowMs, maxRequests), message);
}

export const apiLimiter = createRateLimiter({
  name: 'api',
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  maxRequests: config.RATE_LIMIT_MAX_REQUESTS,
  message: 'Too many API requests, please try again later.',
});

export const authLimiter = createRateLimiter({
  name: 'auth',
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  message: 'Too many authentication attempts, please try again later.',
});

export const pushLimiter = createRateLimiter({
  name: 'push',
  windowMs: 60 * 1000,
  maxRequests: 200,
  message: 'Too many push notification requests, please try again later.',
  keyGenerator: (req: Request) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      return auth.slice(0, 100);
    }
    return `ip:${clientIp(req)}`;
  },
});

// Aggregate cap per source IP, applied before signature verification; it bounds
// the key fetches an unauthenticated sender can cause.
export const inboxLimiter = createRateLimiter({
  name: 'inbox',
  windowMs: 60 * 1000,
  maxRequests: 120,
  message: 'Too many inbox activities, please slow down.',
});

/**
 * Per-instance inbox key: the verified signer's host. Instances behind shared
 * IPs (CDN, NAT) keep separate budgets, and a sender cannot charge its traffic
 * to another domain by naming it in the body. Without a verified signer
 * (REQUIRE_VALID_SIGNATURES=false) the key is the source IP.
 */
export function signerInstanceKey(verifiedSignerUrl: string | null | undefined, ip: string | undefined): string {
  if (verifiedSignerUrl) {
    try {
      return new URL(verifiedSignerUrl).hostname.toLowerCase();
    } catch {
      // fall through to IP
    }
  }
  return `ip:${ip || 'unknown'}`;
}

/** Applied after signature verification with signerInstanceKey(). */
export const instanceInboxLimit = createKeyedLimit({
  name: 'inbox-instance',
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Too many inbox activities from this instance, please slow down.',
});

export const linkPreviewLimiter = createRateLimiter({
  name: 'link-preview',
  windowMs: 60 * 1000,
  maxRequests: 30,
  message: 'Too many link preview requests, please try again later.',
});

// GIF proxy (Klipy). Keyed per-token so one noisy client can't exhaust the
// shared IP budget; debounced searches fire a few requests per second while
// typing, so the ceiling is generous.
export const gifLimiter = createRateLimiter({
  name: 'gif',
  windowMs: 60 * 1000,
  maxRequests: 120,
  message: 'Too many GIF requests, please slow down.',
  keyGenerator: (req: Request) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      return auth.slice(0, 100);
    }
    return `ip:${clientIp(req)}`;
  },
});

// Federated attachments: remote instances fetch on receipt, remote browsers on view.
export const mediaLimiter = createRateLimiter({
  name: 'media',
  windowMs: 60 * 1000,
  maxRequests: 600,
  message: 'Too many media requests, please slow down.',
});

// Account migration resolves remote accounts on every call; keyed by token so one
// account's attempts do not spend another's budget behind a shared address.
export const accountMigrationLimiter = createRateLimiter({
  name: 'account-migration',
  windowMs: 15 * 60 * 1000,
  maxRequests: 30,
  message: 'Too many account migration requests, please try again later.',
  keyGenerator: (req: Request) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      return auth.slice(0, 100);
    }
    return `ip:${clientIp(req)}`;
  },
});

export const discoveryLimiter = createRateLimiter({
  name: 'discovery',
  windowMs: 60 * 1000,
  maxRequests: 30,
  message: 'Too many discovery requests, please try again later.',
});

// Donation webhooks (Ko-fi, etc.): cadence is naturally low (one webhook per
// donation). 60/min is far more than any legitimate flow and prevents abuse
// if the webhook URL leaks.
export const webhookLimiter = createRateLimiter({
  name: 'webhook',
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Too many webhook requests, please try again later.',
});
