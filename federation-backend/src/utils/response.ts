import { Response } from 'express';

/**
 * Standardized API response helpers.
 * Success responses include `{ success: true, ...data }`.
 * Error responses include `{ success: false, error: message }`.
 */

export function sendSuccess(res: Response, data: Record<string, unknown> = {}, status = 200) {
  return res.status(status).json({ success: true, ...data });
}

export function sendError(res: Response, error: string, status = 400, extra?: Record<string, unknown>) {
  return res.status(status).json({ success: false, error, ...extra });
}
