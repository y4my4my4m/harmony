/**
 * Channel webhooks: POST /webhooks/channels/<id>/<token> and /webhooks/channels/<id>/<token>/github.
 *
 * The plain route takes a Discord execute-webhook body (channelWebhookPayload.ts) as JSON or
 * form-encoded, at most PLAIN_BODY_LIMIT. The /github route takes GitHub deliveries, JSON or
 * form-encoded `payload=`, at most GITHUB_BODY_LIMIT, and posts the events githubEvents.ts
 * formats; any other event is answered 204 without a database call. Multipart bodies (file
 * uploads) are refused.
 *
 * The token is hashed with SHA-256 here; public.execute_channel_webhook (service_role) checks
 * the hash, builds the message and inserts it as the webhook's bot.
 *
 * Responses, Discord's where Discord has one:
 *   204  posted; with ?wait=true, 200 and the message as a Discord message object
 *   400  malformed or empty body, text past the instance limit, invalid username or avatar
 *   401  malformed, unknown, inactive or wrong id or token, all alike
 *   403  encrypted, remote or non-text channel; AutoMod blocked or dropped the message
 *   413  body over the route's limit
 *   415  multipart body
 *   429  rate limited; 503 when the limiter store cannot count
 *
 * Limits: per webhook and token 5 per 2 s and 30 per minute; per channel 10 per 2 s and 60 per
 * minute across its webhooks, checked from the second request of a webhook and token (the
 * channel is known after the first); per client address, 30 failed authentications stop its
 * requests for the rest of the minute; link-preview enrichment for 20 messages per minute per
 * channel. A limiter store that cannot count refuses the request.
 *
 * Mounted ahead of the app-wide body parsers and request log (server.ts): the path holds the
 * token, and the routes set their own body limits.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { getSupabaseClient } from '../../config/supabase.js';
import { logger } from '../../utils/logger.js';
import { clientIp, createFailureLimit, createStrictKeyedLimit } from '../../middleware/rateLimit.js';
import {
  SUPPRESS_EMBEDS,
  parseExecutePayload,
  type WebhookError,
  type WebhookMessage,
} from './channelWebhookPayload.js';
import { formatGithubEvent } from './githubEvents.js';

export const PLAIN_BODY_LIMIT = '64kb';
export const GITHUB_BODY_LIMIT = '1mb';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 32 random bytes as lowercase hex (create_channel_webhook). */
const TOKEN_RE = /^[0-9a-f]{64}$/;

const RATE_LIMITED = 'You are being rate limited.';
const webhookBurst = createStrictKeyedLimit({ name: 'channel-webhook-burst', windowMs: 2_000, maxRequests: 5, message: RATE_LIMITED });
const webhookMinute = createStrictKeyedLimit({ name: 'channel-webhook-minute', windowMs: 60_000, maxRequests: 30, message: RATE_LIMITED });
const channelBurst = createStrictKeyedLimit({ name: 'channel-webhook-channel-burst', windowMs: 2_000, maxRequests: 10, message: RATE_LIMITED });
const channelMinute = createStrictKeyedLimit({ name: 'channel-webhook-channel-minute', windowMs: 60_000, maxRequests: 60, message: RATE_LIMITED });
const previewQuota = createStrictKeyedLimit({ name: 'channel-webhook-previews', windowMs: 60_000, maxRequests: 20, message: RATE_LIMITED });
const authFailures = createFailureLimit({
  name: 'channel-webhook-auth',
  windowMs: 60_000,
  maxFailures: 30,
  message: 'Too many invalid webhook requests from this address.',
});

/** Webhook and token hash prefix to channel, learned from the first post. Webhooks never move. */
const channelByKey = new Map<string, string>();
const CHANNEL_CACHE_MAX = 10_000;

function rememberChannel(key: string, channelId: string): void {
  if (channelByKey.size >= CHANNEL_CACHE_MAX) {
    const oldest = channelByKey.keys().next().value;
    if (oldest !== undefined) channelByKey.delete(oldest);
  }
  channelByKey.set(key, channelId);
}

const UNAUTHORIZED: WebhookError = { status: 401, body: { message: 'Invalid Webhook Token', code: 50027 } };
const AUTOMOD: WebhookError = { status: 403, body: { message: "Blocked by the server's AutoMod", code: 'AUTOMOD_BLOCKED' } };

function send(res: Response, error: WebhookError): void {
  res.status(error.status).json(error.body);
}

/** The text after "CODE: " in a database error, or the whole message. */
function detail(message: string): string {
  const i = message.indexOf(': ');
  return i >= 0 ? message.slice(i + 2) : message;
}

export function rpcFailure(error: { message?: string }): WebhookError {
  const message = error.message ?? '';
  if (message.startsWith('WEBHOOK_UNAUTHORIZED')) return UNAUTHORIZED;
  if (message.startsWith('WEBHOOK_CHANNEL_ENCRYPTED')) {
    return { status: 403, body: { message: 'This channel is end-to-end encrypted; webhooks cannot post to it', code: 'CHANNEL_ENCRYPTED' } };
  }
  if (message.startsWith('WEBHOOK_CHANNEL_UNSUPPORTED')) {
    return { status: 403, body: { message: detail(message), code: 'CHANNEL_UNSUPPORTED' } };
  }
  if (message.startsWith('WEBHOOK_EMPTY_MESSAGE')) {
    return { status: 400, body: { message: 'Cannot send an empty message', code: 50006 } };
  }
  if (message.startsWith('WEBHOOK_CONTENT_TOO_LONG') || message.startsWith('WEBHOOK_INVALID_')) {
    return { status: 400, body: { message: detail(message), code: 50035 } };
  }
  if (message.includes('AUTOMOD_BLOCKED')) return AUTOMOD;
  logger.error(`channel webhook: execute_channel_webhook failed: ${message}`);
  return { status: 500, body: { message: 'Internal error' } };
}

interface PostedMessage {
  id: string;
  channel_id: string;
  created_at: string;
  name: string;
  avatar_url: string | null;
  content: Array<{ type: string; preview?: boolean }>;
}

/** Discord's message object, for ?wait=true. */
function discordMessage(webhookId: string, posted: PostedMessage, message: WebhookMessage) {
  return {
    id: posted.id,
    type: 0,
    channel_id: posted.channel_id,
    webhook_id: webhookId,
    content: message.content,
    author: { id: webhookId, username: posted.name, avatar: null, discriminator: '0000', bot: true },
    timestamp: posted.created_at,
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    flags: message.suppressEmbeds ? SUPPRESS_EMBEDS : 0,
  };
}

function enrichLinkPreviews(posted: PostedMessage): void {
  import('../../listeners/DatabaseListener.js')
    .then(({ enrichMessageLinkPreviews }) => enrichMessageLinkPreviews({ id: posted.id, content: posted.content, metadata: {} }))
    .catch((err) => logger.warn(`channel webhook: link previews for ${posted.id} failed: ${err?.message ?? err}`));
}

/** GitHub's form-encoded deliveries carry the JSON in `payload`. undefined when it does not parse. */
function githubPayload(req: Request): unknown {
  if (!req.is('application/x-www-form-urlencoded')) return req.body;
  const raw = (req.body as Record<string, unknown> | undefined)?.payload;
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function execute(req: Request, res: Response, source: 'discord' | 'github'): Promise<void> {
  const ip = clientIp(req);
  if (!(await authFailures.admit(res, ip))) return;

  const { webhookId, token } = req.params;
  if (!UUID_RE.test(webhookId) || !TOKEN_RE.test(token)) {
    await authFailures.record(ip);
    send(res, UNAUTHORIZED);
    return;
  }

  let message: WebhookMessage;
  if (source === 'github') {
    const payload = githubPayload(req);
    if (payload === undefined) {
      send(res, { status: 400, body: { message: 'The request body contains invalid JSON.', code: 50109 } });
      return;
    }
    const content = formatGithubEvent(req.get('x-github-event'), payload);
    if (!content) {
      res.status(204).end();
      return;
    }
    message = { content, suppressEmbeds: false };
  } else {
    const parsed = parseExecutePayload(req.body);
    if (!parsed.ok) {
      send(res, parsed.error);
      return;
    }
    message = parsed.message;
  }

  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const key = `${webhookId}:${tokenHash.slice(0, 16)}`;
  if (!(await webhookBurst.take(res, key)) || !(await webhookMinute.take(res, key))) return;
  const knownChannel = channelByKey.get(key);
  if (knownChannel && (!(await channelBurst.take(res, knownChannel)) || !(await channelMinute.take(res, knownChannel)))) return;

  const { data, error } = await getSupabaseClient().rpc('execute_channel_webhook', {
    p_webhook_id: webhookId,
    p_token_hash: tokenHash,
    p_content: message.content,
    p_username: message.username ?? null,
    p_avatar_url: message.avatarUrl ?? null,
    p_suppress_embeds: message.suppressEmbeds,
  });
  if (error) {
    const failure = rpcFailure(error);
    if (failure === UNAUTHORIZED) await authFailures.record(ip);
    send(res, failure);
    return;
  }
  if (!data) {
    send(res, AUTOMOD);
    return;
  }

  const posted = data as PostedMessage;
  if (!knownChannel) {
    rememberChannel(key, posted.channel_id);
    await channelBurst.tryTake(posted.channel_id);
    await channelMinute.tryTake(posted.channel_id);
  }
  if (!message.suppressEmbeds
      && Array.isArray(posted.content)
      && posted.content.some((part) => part.type === 'url' && part.preview === true)
      && (await previewQuota.tryTake(posted.channel_id))) {
    enrichLinkPreviews(posted);
  }

  const wait = req.query.wait;
  if (wait === 'true' || wait === '1') {
    res.status(200).json(discordMessage(webhookId, posted, message));
    return;
  }
  res.status(204).end();
}

function refuseMultipart(req: Request, res: Response, next: NextFunction): void {
  if (req.is('multipart/*')) {
    send(res, { status: 415, body: { message: 'Attachments are not accepted; send JSON or a form-encoded body', code: 0 } });
    return;
  }
  next();
}

function bodyParsers(limit: string) {
  return [
    express.json({ limit, type: ['application/json', 'application/*+json'] }),
    express.urlencoded({ limit, extended: false }),
  ];
}

const router = Router();

router.post('/:webhookId/:token', refuseMultipart, ...bodyParsers(PLAIN_BODY_LIMIT), (req, res, next) => {
  execute(req, res, 'discord').catch(next);
});
router.post('/:webhookId/:token/github', refuseMultipart, ...bodyParsers(GITHUB_BODY_LIMIT), (req, res, next) => {
  execute(req, res, 'github').catch(next);
});
router.all(['/:webhookId/:token', '/:webhookId/:token/github'], (_req, res) => {
  res.setHeader('Allow', 'POST');
  send(res, { status: 405, body: { message: '405: Method Not Allowed', code: 0 } });
});
router.use((_req, res) => {
  send(res, { status: 404, body: { message: '404: Not Found', code: 0 } });
});

// Body-parser failures carry `type`; nothing here logs the URL, which holds the token.
router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.type === 'entity.too.large') {
    send(res, { status: 413, body: { message: 'Request entity too large', code: 40005 } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    send(res, { status: 400, body: { message: 'The request body contains invalid JSON.', code: 50109 } });
    return;
  }
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    send(res, { status: err.status, body: { message: err.message || 'Bad request', code: 0 } });
    return;
  }
  logger.error(`channel webhook: ${err?.message ?? err}`);
  send(res, { status: 500, body: { message: 'Internal error' } });
});

export default router;
