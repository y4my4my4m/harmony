/**
 * The caller of an instance-admin route: a token GoTrue accepts at the account's assurance level,
 * whose local profile is an admin and not suspended. Answers 401 not_authenticated, 403
 * insufficient_aal, 403 admin_required or 500 internal_error itself and returns null.
 */

import type { Request, Response } from 'express';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { bearerToken } from './sessionAssurance.js';
import { logger } from './logger.js';

export interface InstanceAdmin {
  profileId: string;
}

/** The `aal` claim of a JWT GoTrue has already verified; null when absent or unreadable. */
export function tokenAal(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload?.aal === 'string' ? payload.aal : null;
  } catch {
    return null;
  }
}

export async function requireInstanceAdmin(req: Request, res: Response): Promise<InstanceAdmin | null> {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ error: 'not_authenticated' });
    return null;
  }
  const { data, error } = await getSupabaseClientWithAuth(token).auth.getUser();
  if (error || !data?.user) {
    res.status(401).json({ error: 'not_authenticated' });
    return null;
  }
  // GoTrue's /user answers aal1 tokens too (the client lists factors mid-challenge); the
  // service-role calls after this bypass the PostgREST pre-request, so the claim is checked here.
  const verifiedFactor = (data.user.factors ?? []).some((f: { status?: string }) => f.status === 'verified');
  if (verifiedFactor && tokenAal(token) !== 'aal2') {
    res.status(403).json({ error: 'insufficient_aal' });
    return null;
  }
  const { data: profile, error: profileError } = await getSupabaseClient()
    .from('profiles')
    .select('id, is_admin, is_suspended')
    .eq('auth_user_id', data.user.id)
    .eq('is_local', true)
    .maybeSingle();
  if (profileError) {
    logger.error('Instance admin check: reading the caller failed:', profileError);
    res.status(500).json({ error: 'internal_error' });
    return null;
  }
  if (!profile?.is_admin || profile.is_suspended) {
    res.status(403).json({ error: 'admin_required' });
    return null;
  }
  return { profileId: profile.id };
}
