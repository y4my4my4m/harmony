/**
 * Instance invitations (migration 20261105980001_instance_invites.sql).
 *
 *   GET    /                      registration mode, email delivery, link lifetime, invitations
 *   POST   /  { email, send? }    a new invitation: a single-use link, or GoTrue emails it
 *   POST   /:userId/link          a new link for an open invitation; the one before stops working
 *   DELETE /:userId               withdraws an open invitation by deleting its unused auth user
 *
 * Instance admins only: a token GoTrue accepts at the account's assurance level, whose local
 * profile is an admin and not suspended. GoTrue's admin API makes the invited user and its token
 * (generate_link type invite; /invite when GoTrue emails it). The link handed out is
 * APP_URL/reset-password?invite=1&token_hash=…&type=…, the same as `harmony admin invite`, not
 * GoTrue's action_link: a GET of /auth/v1/verify spends the token, and link previews and mail
 * scanners GET every link they see. The page redeems the token with a POST when the person
 * submits a password. Errors answer { error: <code> }.
 */

import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { createStrictKeyedLimit } from '../middleware/rateLimit.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireInstanceAdmin, tokenAal, type InstanceAdmin } from '../utils/instanceAdmin.js';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

const router = Router();

// Invitations made, links re-issued and invitations revoked, per admin.
const writeLimit = createStrictKeyedLimit({
  name: 'admin-invites',
  windowMs: 60 * 60 * 1000,
  maxRequests: 60,
  message: 'Too many invitation changes; try again later.',
});

const readLimit = createStrictKeyedLimit({
  name: 'admin-invites-read',
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Too many invitation reads; try again later.',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** RFC 5321 caps a path at 256 octets, the address within it at 254. */
const EMAIL = /^[^@\s<>()[\]\\,;:"]+@[^@\s<>()[\]\\,;:"]+\.[^@\s<>()[\]\\,;:".]+$/;

export function parseInviteEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL.test(email)) return null;
  return email;
}

/** GoTrue sends email: an SMTP host other than the upstream stack's supabase-mail placeholder. */
export function mailConfigured(host: string = config.GOTRUE_SMTP_HOST): boolean {
  const value = host.trim();
  return value !== '' && value !== 'supabase-mail';
}

/** The password page in invitation mode; `harmony admin invite` links to the same page. */
export function inviteRedirect(): string {
  return `${config.APP_URL ?? `https://${config.INSTANCE_DOMAIN}`}/reset-password?invite=1`;
}

export type InviteLinkType = 'invite' | 'recovery';

/** The password page naming the token: GoTrue's hashed_token, redeemed by verifyOtp({ token_hash, type }). */
export function inviteLink(hashedToken: string, type: InviteLinkType): string {
  const url = new URL(inviteRedirect());
  url.searchParams.set('token_hash', hashedToken);
  url.searchParams.set('type', type);
  return url.toString();
}

/** When a link made at sentAt stops working; null without a time. */
export function linkExpiry(sentAt: string | null | undefined, lifetimeSeconds = config.GOTRUE_MAILER_OTP_EXP): string | null {
  if (!sentAt) return null;
  const at = Date.parse(sentAt);
  return Number.isNaN(at) ? null : new Date(at + lifetimeSeconds * 1000).toISOString();
}

type Admin = InstanceAdmin;

const instanceAdmin = requireInstanceAdmin;

export { tokenAal };

interface InviteRow {
  id: string | null;
  email: string;
  auth_user_id: string;
  source: 'admin' | 'cli' | 'other';
  delivery: 'link' | 'email' | null;
  invited_by_username: string | null;
  created_at: string;
  links_issued: number;
  link_sent_at: string | null;
  accepted_at: string | null;
  account_username: string | null;
  revoked_at: string | null;
  revoked_by_username: string | null;
  status: 'pending' | 'accepted' | 'revoked' | 'removed';
}

export function presentInvite(row: InviteRow, now = Date.now()) {
  const expiresAt = row.status === 'pending' ? linkExpiry(row.link_sent_at) : null;
  return {
    ...row,
    expires_at: expiresAt,
    expired: expiresAt !== null && Date.parse(expiresAt) <= now,
  };
}

interface AccountRow {
  auth_user_id: string;
  email: string;
  invited: boolean;
  accepted: boolean;
  has_profile: boolean;
  invite_id: string | null;
  revoked: boolean;
}

/** GoTrue's sign-up switch: 'open', 'closed', or 'unknown' when /settings does not answer. */
async function signupMode(): Promise<'open' | 'closed' | 'unknown'> {
  try {
    const res = await fetch(`${config.SUPABASE_URL}/auth/v1/settings`, {
      headers: { apikey: config.SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as { disable_signup?: unknown };
    if (typeof body.disable_signup !== 'boolean') return 'unknown';
    return body.disable_signup ? 'closed' : 'open';
  } catch {
    return 'unknown';
  }
}

/** instance_config.open_registration, which NodeInfo announces; true when absent. */
async function advertisedOpen(): Promise<boolean> {
  const { data } = await getSupabaseClient()
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'open_registration')
    .maybeSingle();
  const value = data?.config_value;
  return !(value === false || value === 'false');
}

interface GoTrueError {
  status?: number;
  code?: string;
  message?: string;
}

/** Answers a GoTrue admin API failure; 'exists' names the code for an address already confirmed. */
function gotrueFailure(res: Response, error: GoTrueError, exists: 'account_exists' | 'invite_accepted') {
  if (error.code === 'email_exists' || error.code === 'user_already_exists') {
    return res.status(409).json({ error: exists });
  }
  if (error.code === 'email_address_invalid' || error.code === 'validation_failed') {
    return res.status(400).json({ error: 'invalid_email' });
  }
  if (error.status === 429 || error.code === 'over_email_send_rate_limit') {
    return res.status(429).json({ error: 'auth_rate_limited' });
  }
  logger.error('Admin invites: GoTrue refused:', error);
  return res.status(502).json({ error: 'auth_failed', detail: String(error.message ?? '').slice(0, 200) });
}

async function record(
  authUserId: string, email: string, delivery: 'link' | 'email', action: 'create' | 'reissue', admin: Admin,
): Promise<string | null> {
  const { data, error } = await getSupabaseClient().rpc('admin_record_instance_invite', {
    p_auth_user_id: authUserId,
    p_email: email,
    p_delivery: delivery,
    p_action: action,
    p_admin_id: admin.profileId,
  });
  if (error) {
    logger.error('Admin invites: recording the invitation failed:', error);
    return null;
  }
  return typeof data === 'string' ? data : null;
}

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const admin = await instanceAdmin(req, res);
  if (!admin || !(await readLimit.take(res, admin.profileId))) return;

  const [signup, advertised, list] = await Promise.all([
    signupMode(),
    advertisedOpen(),
    getSupabaseClient().rpc('admin_instance_invites', { p_limit: 200 }),
  ]);
  if (list.error) {
    logger.error('Admin invites: listing failed:', list.error);
    res.status(500).json({ error: 'list_failed' });
    return;
  }
  res.json({
    registration: { signup, advertised_open: advertised },
    email_available: mailConfigured(),
    link_lifetime_seconds: config.GOTRUE_MAILER_OTP_EXP,
    invites: ((list.data ?? []) as InviteRow[]).map((row) => presentInvite(row)),
  });
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const admin = await instanceAdmin(req, res);
  if (!admin) return;
  const email = parseInviteEmail(req.body?.email);
  if (!email) {
    res.status(400).json({ error: 'invalid_email' });
    return;
  }
  const send = req.body?.send ?? false;
  if (typeof send !== 'boolean') {
    res.status(400).json({ error: 'invalid_send' });
    return;
  }
  if (send && !mailConfigured()) {
    res.status(409).json({ error: 'email_unavailable' });
    return;
  }
  if (!(await writeLimit.take(res, admin.profileId))) return;

  const supabase = getSupabaseClient();
  const { data: accounts, error: lookupError } = await supabase.rpc('admin_instance_invite_account', { p_email: email });
  if (lookupError) {
    logger.error('Admin invites: account lookup failed:', lookupError);
    res.status(500).json({ error: 'internal_error' });
    return;
  }
  const rows = (accounts ?? []) as AccountRow[];
  if (rows.some((a) => a.accepted || a.has_profile || !a.invited)) {
    res.status(409).json({ error: 'account_exists' });
    return;
  }
  if (rows.length > 0) {
    res.status(409).json({ error: 'invite_pending', auth_user_id: rows[0].auth_user_id });
    return;
  }

  const redirectTo = inviteRedirect();
  let user: { id: string; confirmation_sent_at?: string } | null = null;
  let link: string | null = null;
  if (send) {
    const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (error || !data?.user) {
      gotrueFailure(res, error ?? {}, 'account_exists');
      return;
    }
    user = data.user;
  } else {
    const { data, error } = await supabase.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
    if (error || !data?.user || !data.properties?.hashed_token) {
      gotrueFailure(res, error ?? {}, 'account_exists');
      return;
    }
    user = data.user;
    link = inviteLink(data.properties.hashed_token, 'invite');
  }

  const delivery = send ? 'email' : 'link';
  const id = await record(user.id, email, delivery, 'create', admin);
  const sentAt = user.confirmation_sent_at ?? new Date().toISOString();
  res.status(201).json({
    invite: { id, auth_user_id: user.id, email, delivery, recorded: id !== null },
    link,
    expires_at: linkExpiry(sentAt),
  });
}));

router.post('/:userId/link', asyncHandler(async (req: Request, res: Response) => {
  const admin = await instanceAdmin(req, res);
  if (!admin) return;
  const userId = req.params.userId;
  if (!UUID.test(userId)) {
    res.status(400).json({ error: 'invalid_invite' });
    return;
  }
  if (!(await writeLimit.take(res, admin.profileId))) return;

  const supabase = getSupabaseClient();
  const { data: accounts, error: lookupError } = await supabase.rpc('admin_instance_invite_account', { p_auth_user_id: userId });
  if (lookupError) {
    logger.error('Admin invites: account lookup failed:', lookupError);
    res.status(500).json({ error: 'internal_error' });
    return;
  }
  const account = ((accounts ?? []) as AccountRow[])[0];
  if (!account || !account.invited) {
    res.status(404).json({ error: 'invite_not_found' });
    return;
  }
  if (account.accepted || account.has_profile) {
    res.status(409).json({ error: 'invite_accepted' });
    return;
  }

  const options = { redirectTo: inviteRedirect() };
  let type: InviteLinkType = 'invite';
  let { data, error } = await supabase.auth.admin.generateLink({ type, email: account.email, options });
  // GoTrue makes no invite token for a confirmed address (email_exists). Any GET of a
  // /auth/v1/verify invitation link confirms the address without a password; a recovery token
  // signs the person in on the same page.
  if (error?.code === 'email_exists' || error?.code === 'user_already_exists') {
    type = 'recovery';
    ({ data, error } = await supabase.auth.admin.generateLink({ type, email: account.email, options }));
  }
  if (error || !data?.user || !data.properties?.hashed_token) {
    gotrueFailure(res, error ?? {}, 'invite_accepted');
    return;
  }
  const id = await record(account.auth_user_id, account.email, 'link', 'reissue', admin);
  const sentAt = type === 'recovery' ? data.user.recovery_sent_at : data.user.confirmation_sent_at;
  res.json({
    invite: { id, auth_user_id: account.auth_user_id, email: account.email, delivery: 'link', recorded: id !== null },
    link: inviteLink(data.properties.hashed_token, type),
    expires_at: linkExpiry(sentAt ?? new Date().toISOString()),
  });
}));

const REVOKE_ANSWERS: Record<string, { status: number; error?: string }> = {
  revoked: { status: 200 },
  accepted: { status: 409, error: 'invite_accepted' },
  not_invited: { status: 409, error: 'not_an_invite' },
  not_found: { status: 404, error: 'invite_not_found' },
};

router.delete('/:userId', asyncHandler(async (req: Request, res: Response) => {
  const admin = await instanceAdmin(req, res);
  if (!admin) return;
  const userId = req.params.userId;
  if (!UUID.test(userId)) {
    res.status(400).json({ error: 'invalid_invite' });
    return;
  }
  if (!(await writeLimit.take(res, admin.profileId))) return;

  const { data, error } = await getSupabaseClient().rpc('admin_revoke_instance_invite', {
    p_auth_user_id: userId,
    p_admin_id: admin.profileId,
  });
  const answer = typeof data === 'string' ? REVOKE_ANSWERS[data] : undefined;
  if (error || !answer) {
    logger.error('Admin invites: revoke failed:', error ?? data);
    res.status(500).json({ error: 'internal_error' });
    return;
  }
  if (answer.error) {
    res.status(answer.status).json({ error: answer.error });
    return;
  }
  res.json({ revoked: true });
}));

export default router;
