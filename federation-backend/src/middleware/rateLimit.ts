/**
 * Rate Limiting Middleware
 * 
 * Simple in-memory rate limiting for API endpoints.
 * For production, consider using Redis-based rate limiting for distributed systems.
 */

import { Request, Response, NextFunction } from 'express';
import config from '../config/index.js';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory store for rate limiting
const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean up every minute

/**
 * Create a rate limiter middleware
 */
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
    keyGenerator = (req: Request) => req.ip || 'unknown'
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyGenerator(req);
    const now = Date.now();
    
    let entry = rateLimitStore.get(key);
    
    if (!entry || entry.resetTime < now) {
      // Create new entry or reset expired entry
      entry = {
        count: 1,
        resetTime: now + windowMs
      };
      rateLimitStore.set(key, entry);
    } else {
      entry.count++;
    }

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetTime / 1000));

    if (entry.count > maxRequests) {
      res.setHeader('Retry-After', Math.ceil((entry.resetTime - now) / 1000));
      return res.status(429).json({
        error: 'Too Many Requests',
        message,
        retryAfter: Math.ceil((entry.resetTime - now) / 1000)
      });
    }

    return next();
  };
}

/**
 * General API rate limiter
 * Uses configuration from environment variables
 */
export const apiLimiter = createRateLimiter({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  maxRequests: config.RATE_LIMIT_MAX_REQUESTS,
  message: 'Too many API requests, please try again later.'
});

/**
 * Stricter rate limiter for authentication endpoints
 */
export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 10,
  message: 'Too many authentication attempts, please try again later.'
});

/**
 * Push notification rate limiter.
 * Uses per-user key (Authorization header) so each authenticated user gets their own
 * bucket. Prevents 429 when multiple users or tabs share the same IP (e.g. behind nginx).
 * Unauthenticated routes (vapid-key, status) fall back to IP-based limiting.
 */
export const pushLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 200,   // Lenient: only POST/DELETE count (reads exempt). Abuse risk is low.
  message: 'Too many push notification requests, please try again later.',
  keyGenerator: (req: Request) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      // Per-user: same token = same user/session
      return `push:${auth.slice(0, 100)}`;
    }
    return `push:ip:${req.ip || 'unknown'}`;
  }
});

/**
 * Federation inbox rate limiter (per remote IP)
 */
export const inboxLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 120,
  message: 'Too many inbox activities, please slow down.'
});

/**
 * Link preview / proxy rate limiter (stricter — can be abused as HTTP proxy)
 */
export const linkPreviewLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30,
  message: 'Too many link preview requests, please try again later.'
});

/**
 * Server discovery / lookup / invite resolution rate limiter
 */
export const discoveryLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30,
  message: 'Too many discovery requests, please try again later.'
});

