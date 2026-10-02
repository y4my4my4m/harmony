import { Request, Response, NextFunction } from 'express';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { bearerToken, meetsAssurance } from '../utils/sessionAssurance.js';

/**
 * Local profile id behind a `Bearer <Supabase access token>` header; null when
 * the header is absent, the token is invalid or below the account's assurance
 * level, or the account has no local profile.
 */
export async function localProfileIdFromBearer(authHeader: string | undefined): Promise<string | null> {
  const token = bearerToken(authHeader);
  if (!token) return null;
  try {
    const supabase = getSupabaseClient();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user || !meetsAssurance(user, token)) return null;

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .eq('is_local', true)
      .maybeSingle();
    return profile?.id ?? null;
  } catch (error) {
    logger.warn('Bearer token verification failed:', error);
    return null;
  }
}

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email?: string;
    [key: string]: unknown;
  };
  profileId?: string;
}

/**
 * Middleware that verifies a Supabase JWT and attaches the user to req.user.
 * Also resolves profile_id from the profiles table.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);

  try {
    const supabase = getSupabaseClientWithAuth(token);
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    (req as AuthenticatedRequest).user = user as unknown as AuthenticatedRequest['user'];

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    if (profile) {
      (req as AuthenticatedRequest).profileId = profile.id;
    }

    return next();
  } catch (error) {
    logger.error('Auth verification failed:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}
