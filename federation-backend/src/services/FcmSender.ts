/**
 * Firebase Cloud Messaging HTTP v1 client.
 *
 * Authenticates as a service account with the OAuth 2.0 JWT bearer grant (RFC 7523): an
 * RS256 assertion signed with the account's private key is exchanged at token_uri for an
 * access token, cached until 60 s before it expires. firebase-admin is not used; this is the
 * part of it the backend needs, without its dependency tree.
 *
 * Messages are data-only, so the app decides what to display and can cancel it later.
 */

import { createSign } from 'crypto';
import { readFileSync } from 'fs';

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

export type FcmPriority = 'high' | 'normal';

export interface FcmSendOptions {
  priority: FcmPriority;
  ttlSeconds: number;
  collapseKey?: string;
}

export type FcmSendResult =
  | { ok: true }
  | { ok: false; prune: boolean; reason: string; status: number };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const ASSERTION_LIFETIME_S = 3600;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Raw JSON or its base64; null when absent or not a service account. */
export function parseServiceAccount(raw: string | undefined | null): ServiceAccount | null {
  const text = (raw || '').trim();
  if (!text) return null;
  const candidates = text.startsWith('{') ? [text] : [Buffer.from(text, 'base64').toString('utf8'), text];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        typeof parsed?.project_id === 'string' && parsed.project_id &&
        typeof parsed?.client_email === 'string' && parsed.client_email &&
        typeof parsed?.private_key === 'string' && parsed.private_key.includes('PRIVATE KEY')
      ) {
        return {
          project_id: parsed.project_id,
          client_email: parsed.client_email,
          private_key: parsed.private_key,
          private_key_id: typeof parsed.private_key_id === 'string' ? parsed.private_key_id : undefined,
          token_uri: typeof parsed.token_uri === 'string' ? parsed.token_uri : undefined,
        };
      }
    } catch {
      // Not JSON in this encoding.
    }
  }
  return null;
}

/** FCM_SERVICE_ACCOUNT_JSON wins over FCM_SERVICE_ACCOUNT_FILE. */
export function loadServiceAccount(env: { json?: string; file?: string }): ServiceAccount | null {
  const inline = parseServiceAccount(env.json);
  if (inline) return inline;
  if (!env.file) return null;
  try {
    return parseServiceAccount(readFileSync(env.file, 'utf8'));
  } catch {
    return null;
  }
}

/** Signed JWT assertion for the token endpoint. nowS is seconds since the epoch. */
export function buildAssertion(account: ServiceAccount, nowS: number): string {
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (account.private_key_id) header.kid = account.private_key_id;
  const claims = {
    iss: account.client_email,
    scope: FCM_SCOPE,
    aud: account.token_uri || DEFAULT_TOKEN_URI,
    iat: nowS,
    exp: nowS + ASSERTION_LIFETIME_S,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
  return `${unsigned}.${base64url(signature)}`;
}

interface FcmErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: Array<{ '@type'?: string; errorCode?: string; fieldViolations?: Array<{ field?: string }> }>;
  };
}

/**
 * Whether an error response means the token itself is dead. UNREGISTERED and
 * SENDER_ID_MISMATCH always do. INVALID_ARGUMENT also covers malformed payloads, so it
 * counts only when no field violation names anything but the token.
 */
export function classifyFcmError(status: number, body: FcmErrorBody | null): { prune: boolean; reason: string } {
  const error = body?.error;
  const details = error?.details ?? [];
  const errorCode = details.find((d) => d['@type']?.endsWith('google.firebase.fcm.v1.FcmError'))?.errorCode
    ?? error?.status
    ?? `HTTP_${status}`;
  const violations = details.flatMap((d) => d.fieldViolations ?? []);
  const tokenOnly = violations.every((v) => v.field === 'message.token');

  const prune = errorCode === 'UNREGISTERED'
    || errorCode === 'SENDER_ID_MISMATCH'
    || (errorCode === 'INVALID_ARGUMENT' && tokenOnly);
  return { prune, reason: error?.message ? `${errorCode}: ${error.message}` : errorCode };
}

export class FcmSender {
  private readonly account: ServiceAccount | null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(opts: { account: ServiceAccount | null; fetchImpl?: FetchLike; now?: () => number }) {
    this.account = opts.account;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  isConfigured(): boolean {
    return this.account !== null;
  }

  projectId(): string | null {
    return this.account?.project_id ?? null;
  }

  /** Access token for the FCM scope; concurrent callers share one exchange. */
  async accessToken(forceRefresh = false): Promise<string> {
    if (!this.account) throw new Error('FCM is not configured');
    if (!forceRefresh && this.cached && this.cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
      return this.cached.token;
    }
    if (this.pending) return this.pending;

    const account = this.account;
    this.pending = (async () => {
      const assertion = buildAssertion(account, Math.floor(this.now() / 1000));
      const response = await this.fetchImpl(account.token_uri || DEFAULT_TOKEN_URI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
      if (!response.ok || !body.access_token) {
        throw new Error(`FCM token exchange failed: ${response.status} ${body.error ?? ''}`.trim());
      }
      const lifetimeMs = (Number(body.expires_in) || 3600) * 1000;
      this.cached = { token: body.access_token, expiresAt: this.now() + lifetimeMs };
      return body.access_token;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Sends one data message. A 401 refreshes the access token and retries once. */
  async send(token: string, data: Record<string, string>, options: FcmSendOptions): Promise<FcmSendResult> {
    if (!this.account) return { ok: false, prune: false, reason: 'FCM is not configured', status: 0 };
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`;
    const message = {
      message: {
        token,
        data,
        android: {
          priority: options.priority === 'high' ? 'HIGH' : 'NORMAL',
          ttl: `${Math.max(0, Math.floor(options.ttlSeconds))}s`,
          ...(options.collapseKey ? { collapse_key: options.collapseKey } : {}),
        },
      },
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      let accessToken: string;
      try {
        accessToken = await this.accessToken(attempt > 0);
      } catch (error) {
        return { ok: false, prune: false, reason: error instanceof Error ? error.message : String(error), status: 0 };
      }

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        return { ok: false, prune: false, reason: error instanceof Error ? error.message : String(error), status: 0 };
      }

      if (response.ok) return { ok: true };
      if (response.status === 401 && attempt === 0) {
        this.cached = null;
        continue;
      }
      const body = await response.json().catch(() => null) as FcmErrorBody | null;
      return { ok: false, status: response.status, ...classifyFcmError(response.status, body) };
    }
    return { ok: false, prune: false, reason: 'FCM rejected the refreshed access token', status: 401 };
  }
}
