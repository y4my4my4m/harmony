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
  windowMs: number;
  maxRequests: number;
  message?: string;
  keyGenerator?: (req: Request) => string;
}) {
  const {
    windowMs,
    maxRequests,
    message = 'Too many requests, please try again later.',
    keyGenerator = (req: Request) => req.ip || 'unknown',
  } = options;

  const windowSeconds = Math.ceil(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction) => {
    const rawKey = keyGenerator(req);
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
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  maxRequests: config.RATE_LIMIT_MAX_REQUESTS,
  message: 'Too many API requests, please try again later.',
});

export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxRequests: 10,
  message: 'Too many authentication attempts, please try again later.',
});

export const pushLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 200,
  message: 'Too many push notification requests, please try again later.',
  keyGenerator: (req: Request) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      return `push:${auth.slice(0, 100)}`;
    }
    return `push:ip:${req.ip || 'unknown'}`;
  },
});

export const inboxLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120,
  message: 'Too many inbox activities, please slow down.',
});

export const linkPreviewLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  message: 'Too many link preview requests, please try again later.',
});

// GIF proxy (Klipy). Keyed per-token so one noisy client can't exhaust the
// shared IP budget; debounced searches fire a few requests per second while
// typing, so the ceiling is generous.
export const gifLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120,
  message: 'Too many GIF requests, please slow down.',
  keyGenerator: (req: Request) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      return `gif:${auth.slice(0, 100)}`;
    }
    return `gif:ip:${req.ip || 'unknown'}`;
  },
});

export const discoveryLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  message: 'Too many discovery requests, please try again later.',
});

// Donation webhooks (Ko-fi, etc.): cadence is naturally low (one webhook per
// donation). 60/min is far more than any legitimate flow and prevents abuse
// if the webhook URL leaks.
export const webhookLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Too many webhook requests, please try again later.',
});
