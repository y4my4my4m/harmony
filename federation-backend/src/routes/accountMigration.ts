/**
 * Account migration for the signed-in account (migration 20261010900001_account_migration.sql).
 *
 *   POST   /aliases       { handle }            add an alias
 *   DELETE /aliases       { uri }               remove an alias
 *   POST   /move/preview  { handle }            the target as it stands now
 *   POST   /move          { handle, password }  move to the target
 *   POST   /move/cancel                         drop the redirect
 *
 * A remote handle resolves as /lookup-user does (WebFinger, authoritative fetch, key
 * ownership, account confirmation, upsert), always fetched now. The RPCs run with the
 * caller's token, so begin_account_move judges the request's own session for the step-up.
 * Errors answer { error: <code> } with the RPC's code where there is one.
 */

import { Router, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { accountMigrationLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { resolveRemoteAccount } from '../activitypub/ActorService.js';
import { localActorUri } from '../activitypub/accountMigration.js';
import { parseAlsoKnownAs, parseMovedTo } from '../activitypub/converters/fromActivityPub.js';
import { bearerToken } from '../utils/sessionAssurance.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

/** RPC outcomes of begin_account_move answered with 4xx; the rest are 500. */
const MOVE_ERRORS: Record<string, number> = {
  mfa_required: 403,
  password_required: 403,
  invalid_password: 403,
  reauthentication_required: 403,
  account_suspended: 403,
  already_moved: 409,
  target_is_self: 422,
  target_not_found: 404,
  target_suspended: 422,
  target_moved: 422,
  alias_missing: 422,
};

export interface AccountHandle {
  username: string;
  /** Lowercased; null for a bare local username. */
  domain: string | null;
}

/** `user`, `user@host` or `@user@host`. */
export function parseAccountHandle(raw: unknown): AccountHandle | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().replace(/^@/, '').split('@');
  if (parts.length > 2) return null;
  const [username, domain] = parts;
  if (!username || username.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(username)) return null;
  if (domain !== undefined && !/^[a-z0-9.-]+(:\d+)?$/i.test(domain)) return null;
  return { username, domain: domain ? domain.toLowerCase() : null };
}

export interface ResolvedAccount {
  profile: any;
  /** Actor URI as aliases and movedTo name it. */
  uri: string;
  /** Document as fetched now; null for a local account. */
  actor: any | null;
}

type Resolution = { ok: true; account: ResolvedAccount } | { ok: false; status: number; error: string };

async function resolveAccount(handle: AccountHandle): Promise<Resolution> {
  if (!handle.domain || handle.domain === config.INSTANCE_DOMAIN.toLowerCase()) {
    const { data: profile } = await getSupabaseClient()
      .from('profiles')
      .select('*')
      .eq('username', handle.username)
      .eq('is_local', true)
      .is('deleted_at', null)
      .maybeSingle();
    if (!profile) return { ok: false, status: 404, error: 'account_not_found' };
    return { ok: true, account: { profile, uri: profile.federated_id || localActorUri(profile.username), actor: null } };
  }

  const resolved = await resolveRemoteAccount(handle.username, handle.domain);
  if (!resolved.ok) {
    return { ok: false, status: resolved.status === 404 ? 404 : 502, error: 'account_not_found' };
  }
  return { ok: true, account: { profile: resolved.user, uri: resolved.actor.id, actor: resolved.actor } };
}

/** The target's aliases and movedTo: from the fetched document for a remote account. */
export function targetState(account: ResolvedAccount): { aliases: string[]; movedTo: string | null } {
  if (account.actor) {
    return { aliases: parseAlsoKnownAs(account.actor.alsoKnownAs), movedTo: parseMovedTo(account.actor.movedTo) };
  }
  return {
    aliases: Array.isArray(account.profile.also_known_as) ? account.profile.also_known_as : [],
    movedTo: account.profile.moved_to_uri ?? null,
  };
}

function publicAccount(account: ResolvedAccount): Record<string, unknown> {
  const p = account.profile;
  return {
    id: p.id,
    username: p.username,
    domain: p.domain,
    is_local: p.is_local,
    display_name: p.display_name,
    avatar_url: p.avatar_url,
    uri: account.uri,
    locked: p.manually_approves_followers === true,
  };
}

interface Caller {
  client: SupabaseClient;
  profile: { id: string; username: string; federated_id: string | null; also_known_as: string[] | null; moved_to_uri: string | null };
  uri: string;
}

async function caller(req: Request, res: Response): Promise<Caller | null> {
  const token = bearerToken(req.headers.authorization);
  const { profileId } = req as AuthenticatedRequest;
  if (!token || !profileId) {
    res.status(401).json({ error: 'not_authenticated' });
    return null;
  }
  const { data: profile } = await getSupabaseClient()
    .from('profiles')
    .select('id, username, federated_id, also_known_as, moved_to_uri, is_local, deleted_at')
    .eq('id', profileId)
    .maybeSingle();
  if (!profile || profile.is_local !== true || profile.deleted_at) {
    res.status(403).json({ error: 'not_a_local_account' });
    return null;
  }
  return {
    client: getSupabaseClientWithAuth(token),
    profile,
    uri: profile.federated_id || localActorUri(profile.username),
  };
}

/** PostgREST error of an RPC as an HTTP answer; PT429 carries retry_after. */
function rpcFailure(res: Response, error: { code?: string; message?: string; details?: string }): Response {
  const code = error.code ?? '';
  const message = error.message ?? '';
  if (code === 'PT429') {
    const retryAfter = Number(/retry_after=(\d+)/.exec(error.details ?? '')?.[1]) || undefined;
    return res.status(429).json({ error: message || 'rate_limited', retry_after: retryAfter });
  }
  if (code === 'PT403' || message === 'insufficient_aal') return res.status(403).json({ error: 'insufficient_aal' });
  if (code === 'PT401') return res.status(401).json({ error: 'session_revoked' });
  logger.error(`Account migration RPC failed: ${code} ${message}`);
  return res.status(500).json({ error: 'internal_error' });
}

async function saveAliases(res: Response, me: Caller, uris: string[], extra: Record<string, unknown> = {}): Promise<Response> {
  const { data, error } = await me.client.rpc('set_my_account_aliases', { p_uris: uris });
  if (error) return rpcFailure(res, error);
  if (data?.error) return res.status(422).json(data);
  return res.json({ success: true, aliases: data?.aliases ?? uris, ...extra });
}

router.post('/aliases', accountMigrationLimiter, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const handle = parseAccountHandle(req.body?.handle);
  if (!handle) return res.status(400).json({ error: 'invalid_handle' });
  const me = await caller(req, res);
  if (!me) return;

  const resolved = await resolveAccount(handle);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  if (resolved.account.uri === me.uri) return res.status(422).json({ error: 'alias_is_self' });

  const account = publicAccount(resolved.account);
  const current = me.profile.also_known_as ?? [];
  if (current.includes(resolved.account.uri)) {
    return res.json({ success: true, aliases: current, account });
  }
  return saveAliases(res, me, [...current, resolved.account.uri], { account });
}));

router.delete('/aliases', accountMigrationLimiter, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const uri = req.body?.uri;
  if (typeof uri !== 'string' || !uri) return res.status(400).json({ error: 'invalid_alias' });
  const me = await caller(req, res);
  if (!me) return;
  return saveAliases(res, me, (me.profile.also_known_as ?? []).filter((alias) => alias !== uri));
}));

router.post('/move/preview', accountMigrationLimiter, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const handle = parseAccountHandle(req.body?.handle);
  if (!handle) return res.status(400).json({ error: 'invalid_handle' });
  const me = await caller(req, res);
  if (!me) return;

  const resolved = await resolveAccount(handle);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  const state = targetState(resolved.account);
  return res.json({
    target: publicAccount(resolved.account),
    is_self: resolved.account.profile.id === me.profile.id,
    alias_confirmed: state.aliases.includes(me.uri),
    target_moved: !!state.movedTo,
    alias_uri: me.uri,
  });
}));

router.post('/move', accountMigrationLimiter, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const handle = parseAccountHandle(req.body?.handle);
  if (!handle) return res.status(400).json({ error: 'invalid_handle' });
  const password = typeof req.body?.password === 'string' ? req.body.password : null;
  const me = await caller(req, res);
  if (!me) return;
  if (me.profile.moved_to_uri) return res.status(409).json({ error: 'already_moved' });

  const resolved = await resolveAccount(handle);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  if (resolved.account.profile.id === me.profile.id) return res.status(422).json({ error: 'target_is_self' });
  const state = targetState(resolved.account);
  if (state.movedTo) return res.status(422).json({ error: 'target_moved' });
  if (!state.aliases.includes(me.uri)) return res.status(422).json({ error: 'alias_missing', alias_uri: me.uri });

  const { data, error } = await me.client.rpc('begin_account_move', {
    p_target_profile_id: resolved.account.profile.id,
    p_password: password,
  });
  if (error) return rpcFailure(res, error);
  if (data?.error) {
    return res.status(MOVE_ERRORS[data.error] ?? 500).json({ error: data.error });
  }
  logger.info(`Account ${me.profile.username} moving to ${resolved.account.uri} (migration ${data?.migration_id})`);
  return res.json({ success: true, migration_id: data?.migration_id, target: publicAccount(resolved.account) });
}));

router.post('/move/cancel', accountMigrationLimiter, requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const me = await caller(req, res);
  if (!me) return;
  const { data, error } = await me.client.rpc('cancel_my_account_redirect');
  if (error) return rpcFailure(res, error);
  if (data?.error) return res.status(409).json({ error: data.error });
  return res.json({ success: true });
}));

export default router;
