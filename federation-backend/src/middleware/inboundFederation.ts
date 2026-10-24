import type { NextFunction, Request, Response } from 'express';
import { inboundAllowed } from '../services/FederationSwitches.js';
import { logger } from '../utils/logger.js';

/** Inbound federation off: every inbox POST answers 403 before its body or signature is read. */
export async function refuseInboxWhenInboundOff(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method !== 'POST' || (await inboundAllowed())) {
    next();
    return;
  }
  logger.info(`Inbound federation is off: ${req.originalUrl} refused`);
  res.status(403).json({ error: 'Federation is off on this instance' });
}
