/**
 * Public funding feed (GET /funding/public) and the Harmony project's feed as this instance's
 * clients see it (GET /funding/project).
 *
 * Every instance publishes its own funding: links, goal and progress, supporter count, and the
 * approved supporter messages when the admin shows them publicly. An anonymous message has no
 * name; no message carries a profile id. Each self-hosted instance reads the project's feed
 * (config.PROJECT_FUNDING_URL) server-side, so its users' addresses never reach the project:
 * through safeFetch (public addresses only, https, 5 s, 64 KiB), cached 30 minutes, served
 * stale for up to 7 days when the project is unreachable, else PROJECT_FUNDING_FALLBACK. The
 * feed is untrusted: every field is re-validated and an invalid entry is dropped.
 */

import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { safeFetch } from '../utils/ssrfProtection.js';
import { cleanText, textProblem, SUPPORTER_MESSAGE_MAX } from './supporterMessageText.js';

export const FEED_VERSION = 1;

/** src/services/FundingService.ts FUNDING_PLATFORMS. */
const PLATFORMS = new Set([
  'ko-fi', 'patreon', 'github-sponsors', 'liberapay', 'open-collective', 'paypal', 'buymeacoffee',
  'stripe', 'custom',
]);

const MAX_LINKS = 8;
const MAX_MESSAGES = 12;
const LABEL_MAX = 40;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 200;
const URL_MAX = 2048;

export interface PublicFundingLink {
  platform: string;
  url: string;
  label: string;
}

export interface PublicFundingMessage {
  id: string;
  body: string;
  /** Null for an anonymous message. */
  name: string | null;
  at: string;
}

export interface PublicFundingGoal {
  amount: number;
  currency: string;
  period: 'monthly' | 'all';
  raised: number;
  /** End of the monthly period, ISO 8601 UTC; null for all time. */
  periodEnd: string | null;
  description: string | null;
}

export interface PublicFunding {
  version: number;
  instance: string;
  enabled: boolean;
  goal: PublicFundingGoal | null;
  supporters: number;
  links: PublicFundingLink[];
  messages: PublicFundingMessage[];
}

export interface ProjectFundingResult {
  /** upstream: fetched within the cache time; stale: an older copy; fallback: the built-in links. */
  source: 'upstream' | 'stale' | 'fallback';
  fetchedAt: string | null;
  funding: PublicFunding;
}

/** Served when the project's feed has never been read or is older than STALE_MS. */
export const PROJECT_FUNDING_FALLBACK: PublicFunding = {
  version: FEED_VERSION,
  instance: 'har.mony.lol',
  enabled: true,
  goal: null,
  supporters: 0,
  links: [{ platform: 'custom', url: 'https://mony.lol/', label: 'Harmony' }],
  messages: [],
};

export const FRESH_MS = 30 * 60 * 1000;
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;
/** After a failed read, the next one waits this long; requests meanwhile get the cached copy. */
export const RETRY_MS = 5 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 5000;
export const FETCH_MAX_BYTES = 64 * 1024;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The project's own instance: PROJECT_INSTANCE, or with 'auto' the feed URL's host is ours. */
export function isProjectInstance(
  cfg: { PROJECT_INSTANCE: string; PROJECT_FUNDING_URL: string; INSTANCE_DOMAIN: string } = config,
): boolean {
  if (cfg.PROJECT_INSTANCE === 'true') return true;
  if (cfg.PROJECT_INSTANCE === 'false') return false;
  return hostOf(cfg.PROJECT_FUNDING_URL) === cfg.INSTANCE_DOMAIN.toLowerCase();
}

function finiteAtLeastZero(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** https with a host and no credentials, at most URL_MAX characters; else null. */
function cleanLinkUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
  return url.href;
}

function cleanLink(raw: unknown): PublicFundingLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const url = cleanLinkUrl(r.url);
  if (!url) return null;
  const platform = typeof r.platform === 'string' ? r.platform.toLowerCase().replace(/\s+/g, '-') : '';
  const label = typeof r.label === 'string' ? cleanText(r.label, LABEL_MAX) ?? '' : '';
  return { platform: PLATFORMS.has(platform) ? platform : 'custom', url, label };
}

function cleanMessage(raw: unknown): PublicFundingMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[0-9a-f-]{1,64}$/i.test(r.id)) return null;
  if (textProblem(r.body, SUPPORTER_MESSAGE_MAX) !== null) return null;
  const at = isoDate(r.at);
  if (!at) return null;
  let name: string | null = null;
  if (r.name !== null && r.name !== undefined) {
    name = cleanText(r.name, NAME_MAX);
    if (name === null) return null;
  }
  return { id: r.id, body: r.body as string, name, at };
}

function cleanGoal(raw: unknown): PublicFundingGoal | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const amount = finiteAtLeastZero(r.amount);
  const raised = finiteAtLeastZero(r.raised);
  if (amount === null || amount === 0 || raised === null) return null;
  if (typeof r.currency !== 'string' || !/^[A-Z]{3}$/.test(r.currency)) return null;
  const period = r.period === 'all' ? 'all' : r.period === 'monthly' ? 'monthly' : null;
  if (!period) return null;
  const periodEnd = r.periodEnd == null ? null : isoDate(r.periodEnd);
  const description = typeof r.description === 'string' ? cleanText(r.description, DESCRIPTION_MAX) : null;
  return { amount, currency: r.currency, period, raised, periodEnd, description };
}

/**
 * A feed from another instance, every field re-validated: links https only, known platform or
 * 'custom'; messages, names, labels and the description by the supporter message text rules;
 * at most MAX_LINKS links and MAX_MESSAGES messages. Null when it is not a feed at all.
 */
export function sanitizeFeed(raw: unknown): PublicFunding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== FEED_VERSION) return null;
  const instance = typeof r.instance === 'string' && /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(r.instance)
    ? r.instance.toLowerCase()
    : null;
  if (!instance) return null;
  const enabled = r.enabled === true;
  const links = Array.isArray(r.links)
    ? r.links.slice(0, MAX_LINKS * 4).map(cleanLink).filter((l): l is PublicFundingLink => !!l).slice(0, MAX_LINKS)
    : [];
  const messages = Array.isArray(r.messages)
    ? r.messages.slice(0, MAX_MESSAGES * 4).map(cleanMessage).filter((m): m is PublicFundingMessage => !!m).slice(0, MAX_MESSAGES)
    : [];
  const supporters = finiteAtLeastZero(r.supporters);
  return {
    version: FEED_VERSION,
    instance,
    enabled,
    goal: enabled ? cleanGoal(r.goal) : null,
    supporters: supporters === null ? 0 : Math.floor(supporters),
    links: enabled ? links : [],
    messages: enabled ? messages : [],
  };
}

/** public.get_funding_summary() as service_role reads it. */
export interface FundingSummaryRow {
  enabled?: boolean;
  goal_amount?: number | string | null;
  goal_currency?: string | null;
  funding_period?: string | null;
  goal_description?: string | null;
  funding_links?: unknown;
  displayed_amount?: number | string | null;
  period_end?: string | null;
  supporter_count?: number | null;
  supporter_messages_enabled?: boolean;
  supporter_messages_public?: boolean;
  messages?: Array<{ id: string; body: string; anonymous: boolean; name: string | null; at: string }>;
}

/** This instance's feed from its summary, through the same validation a reader applies. */
export function buildFeed(summary: FundingSummaryRow | null, domain: string): PublicFunding {
  if (!summary?.enabled) {
    return { version: FEED_VERSION, instance: domain, enabled: false, goal: null, supporters: 0, links: [], messages: [] };
  }
  const goalAmount = finiteAtLeastZero(summary.goal_amount);
  const showMessages = summary.supporter_messages_enabled === true && summary.supporter_messages_public === true;
  const feed = sanitizeFeed({
    version: FEED_VERSION,
    instance: domain,
    enabled: true,
    goal: goalAmount ? {
      amount: goalAmount,
      currency: summary.goal_currency ?? 'USD',
      period: summary.funding_period === 'all' ? 'all' : 'monthly',
      raised: finiteAtLeastZero(summary.displayed_amount) ?? 0,
      periodEnd: summary.period_end ?? null,
      description: summary.goal_description ?? null,
    } : null,
    supporters: summary.supporter_count ?? 0,
    links: Array.isArray(summary.funding_links) ? summary.funding_links : [],
    messages: showMessages
      ? (summary.messages ?? []).map((m) => ({ id: m.id, body: m.body, name: m.anonymous ? null : m.name, at: m.at }))
      : [],
  });
  return feed ?? { version: FEED_VERSION, instance: domain, enabled: false, goal: null, supporters: 0, links: [], messages: [] };
}

export async function readOwnFeed(): Promise<PublicFunding> {
  const { data, error } = await getSupabaseClient().rpc('get_funding_summary');
  if (error) throw new Error(`get_funding_summary failed: ${error.message}`);
  return buildFeed((data as FundingSummaryRow | null) ?? null, config.INSTANCE_DOMAIN);
}

type Fetcher = (url: string) => Promise<unknown>;

async function fetchFeed(url: string): Promise<unknown> {
  const res = await safeFetch(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBodyBytes: FETCH_MAX_BYTES,
    maxRedirects: 2,
    headers: { Accept: 'application/json' },
  });
  if (res.status !== 200) {
    try { await res.body?.cancel(); } catch { /* drained */ }
    throw new Error(`status ${res.status}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    try { await res.body?.cancel(); } catch { /* drained */ }
    throw new Error(`content-type ${type || 'none'}`);
  }
  return JSON.parse(await res.text());
}

/** The project's feed with its cache. One read at a time; callers during a read share it. */
export class ProjectFundingCache {
  private copy: { funding: PublicFunding; at: number } | null = null;
  private failedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string = config.PROJECT_FUNDING_URL,
    private readonly fetcher: Fetcher = fetchFeed,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<ProjectFundingResult> {
    const now = this.now();
    const fresh = this.copy && now - this.copy.at < FRESH_MS;
    if (!fresh && now - this.failedAt >= RETRY_MS) {
      this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
      await this.inflight;
    }
    return this.result();
  }

  private result(): ProjectFundingResult {
    const now = this.now();
    if (this.copy && now - this.copy.at < STALE_MS) {
      return {
        source: now - this.copy.at < FRESH_MS ? 'upstream' : 'stale',
        fetchedAt: new Date(this.copy.at).toISOString(),
        funding: this.copy.funding,
      };
    }
    return { source: 'fallback', fetchedAt: null, funding: PROJECT_FUNDING_FALLBACK };
  }

  private async refresh(): Promise<void> {
    try {
      const funding = sanitizeFeed(await this.fetcher(this.url));
      if (!funding) throw new Error('not a funding feed');
      this.copy = { funding, at: this.now() };
      this.failedAt = 0;
    } catch (err) {
      this.failedAt = this.now();
      logger.warn(`project funding: ${this.url} unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
