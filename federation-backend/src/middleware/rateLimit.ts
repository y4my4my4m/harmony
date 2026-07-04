import { Request, Response, NextFunction } from 'express';
import config from '../config/index.js';
import { redis } from '../services/RedisService.js';

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
    keyGenerator = (req: Request) => req.ip || 'unknown',
  } = options;

  const windowSeconds = Math.ceil(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction) => {
    const rawKey = `${name}:${keyGenerator(req)}`;
    const redisKey = `rl:${rawKey}`;

    let count: number;
    let remaining: number;
    let resetMs: number;

    if (redis.ready) {
      const result = await redis.rateLimit(redisKey, maxRequests, windowSeconds);
      count = maxRequests - result.remaining;
      remaining = result.remaining;
      resetMs = result.resetMs;

      if (!result.allowed) {
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + resetMs) / 1000));
        res.setHeader('Retry-After', Math.ceil(resetMs / 1000));
        return res.status(429).json({
          error: 'Too Many Requests',
          message,
          retryAfter: Math.ceil(resetMs / 1000),
        });
      }
    } else {
      const now = Date.now();
      let entry = memoryStore.get(rawKey);

      if (!entry || entry.resetTime < now) {
        entry = { count: 1, resetTime: now + windowMs };
        memoryStore.set(rawKey, entry);
      } else {
        entry.count++;
      }

      count = entry.count;
      remaining = Math.max(0, maxRequests - count);
      resetMs = entry.resetTime - now;

      if (count > maxRequests) {
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));
        res.setHeader('Retry-After', Math.ceil(resetMs / 1000));
        return res.status(429).json({
          error: 'Too Many Requests',
          message,
          retryAfter: Math.ceil(resetMs / 1000),
        });
      }
    }

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + resetMs) / 1000));
    return next();
  };
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
    return `ip:${req.ip || 'unknown'}`;
  },
});

// Aggregate cap per source IP; the per-instance limiter below is the primary
// defense against a single noisy peer.
export const inboxLimiter = createRateLimiter({
  name: 'inbox',
  windowMs: 60 * 1000,
  maxRequests: 120,
  message: 'Too many inbox activities, please slow down.',
});

// Keyed by the sending actor's domain so instances behind shared IPs (CDN,
// NAT) don't drain each other's budget, and one hostile instance can't use
// the whole IP allowance. Falls back to IP when the actor is missing.
export function instanceKeyFromRequest(req: Request): string {
  const actor = req.body?.actor;
  const actorUrl = typeof actor === 'string' ? actor : actor?.id;
  if (typeof actorUrl === 'string') {
    try {
      return new URL(actorUrl).hostname.toLowerCase();
    } catch {
      // fall through to IP
    }
  }
  return `ip:${req.ip || 'unknown'}`;
}

export const instanceInboxLimiter = createRateLimiter({
  name: 'inbox-instance',
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Too many inbox activities from this instance, please slow down.',
  keyGenerator: instanceKeyFromRequest,
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
    return `ip:${req.ip || 'unknown'}`;
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
