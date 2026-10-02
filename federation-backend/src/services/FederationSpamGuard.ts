/**
 * Inbound mention and DM spam heuristics (instance_config 'antispam', written by
 * update_instance_antispam_settings in 20261005100001_server_automod.sql).
 *
 * A Create that mentions or DMs local users is suspicious when either holds:
 *   mass_mention     it carries at least federation_max_mentions distinct Mention tags
 *   new stranger     the remote account is younger than federation_new_actor_days
 *                    (ActivityPub `published`, else the date this instance first saw it),
 *                    no local user follows it, and no targeted user follows it, is
 *                    followed by it, or shares a conversation with it
 * federation_spam_mode decides what a suspicious Create does:
 *   off      nothing
 *   flag     delivered; a suspicious_activity row is recorded
 *   hold     not delivered; the activity is stored for an admin to release
 *   reject   not delivered; recorded without the activity
 * Released activities are reprocessed by the 'release-held-activity' job with the
 * guard skipped.
 */
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

export type SpamMode = 'off' | 'flag' | 'hold' | 'reject';

export interface FederationSpamConfig {
  federation_spam_mode: SpamMode;
  federation_max_mentions: number;
  federation_new_actor_days: number;
}

export interface SpamInput {
  activity: any;
  object: any;
  authorId: string;
  authorUri: string;
  kind: 'federation_mention' | 'federation_dm';
  /** Local profiles the object mentions or addresses. */
  targetIds: string[];
}

export interface SpamVerdict {
  /** 'flag' delivers like 'allow'. */
  action: 'allow' | 'flag' | 'hold' | 'reject';
  reasons: string[];
}

const DEFAULTS: FederationSpamConfig = {
  federation_spam_mode: 'flag',
  federation_max_mentions: 15,
  federation_new_actor_days: 7,
};

const CONFIG_TTL_MS = 60_000;
let cached: { at: number; value: FederationSpamConfig } | null = null;

function intOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

export function parseSpamConfig(raw: unknown): FederationSpamConfig {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode = v.federation_spam_mode;
  return {
    federation_spam_mode: mode === 'off' || mode === 'flag' || mode === 'hold' || mode === 'reject'
      ? mode
      : DEFAULTS.federation_spam_mode,
    federation_max_mentions: Math.max(2, intOr(v.federation_max_mentions, DEFAULTS.federation_max_mentions)),
    federation_new_actor_days: Math.max(0, intOr(v.federation_new_actor_days, DEFAULTS.federation_new_actor_days)),
  };
}

export async function getSpamConfig(now = Date.now()): Promise<FederationSpamConfig> {
  if (cached && now - cached.at < CONFIG_TTL_MS) return cached.value;
  const { data, error } = await getSupabaseClient()
    .from('instance_config')
    .select('config_value')
    .eq('config_key', 'antispam')
    .maybeSingle();
  if (error) {
    logger.warn('Anti-spam config unavailable, using defaults:', error.message);
  }
  const value = parseSpamConfig(data?.config_value);
  cached = { at: now, value };
  return value;
}

export function resetSpamConfigCache(): void {
  cached = null;
}

/** Distinct Mention hrefs (or names) in an AS2 object's tag list. */
export function countMentions(object: any): number {
  const tags = Array.isArray(object?.tag) ? object.tag : object?.tag ? [object.tag] : [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag?.type !== 'Mention') continue;
    const key = typeof tag.href === 'string' ? tag.href : typeof tag.name === 'string' ? tag.name : null;
    if (key) seen.add(key.toLowerCase());
  }
  return seen.size;
}

function textSummary(object: any): string | null {
  const html = typeof object?.content === 'string' ? object.content : '';
  const text = html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 500) : null;
}

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function actorAgeMs(authorId: string, now: number): Promise<{ ageMs: number | null; known: boolean }> {
  const { data } = await getSupabaseClient()
    .from('profiles')
    .select('created_at, federation_metadata')
    .eq('id', authorId)
    .maybeSingle();
  const published = (data?.federation_metadata as any)?.ap_published;
  const publishedMs = typeof published === 'string' ? Date.parse(published) : NaN;
  if (Number.isFinite(publishedMs)) return { ageMs: now - publishedMs, known: true };
  const firstSeen = data?.created_at ? Date.parse(data.created_at) : NaN;
  return { ageMs: Number.isFinite(firstSeen) ? now - firstSeen : null, known: false };
}

async function hasLocalFollower(authorId: string): Promise<boolean> {
  // Follows of a remote account are stored only when the follower is local.
  const { data } = await getSupabaseClient()
    .from('follows')
    .select('id')
    .eq('following_id', authorId)
    .eq('status', 'accepted')
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function hasRelationship(authorId: string, targetIds: string[]): Promise<boolean> {
  const supabase = getSupabaseClient();
  const { data: follows } = await supabase
    .from('follows')
    .select('id')
    .eq('status', 'accepted')
    .or(
      `and(follower_id.in.(${targetIds.join(',')}),following_id.eq.${authorId}),` +
      `and(follower_id.eq.${authorId},following_id.in.(${targetIds.join(',')}))`,
    )
    .limit(1);
  if ((follows?.length ?? 0) > 0) return true;

  const { data: authorConvs } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', authorId)
    .limit(200);
  const convIds = (authorConvs ?? []).map((r: any) => r.conversation_id).filter(Boolean);
  if (convIds.length === 0) return false;
  const { data: shared } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .in('conversation_id', convIds)
    .in('user_id', targetIds)
    .limit(1);
  return (shared?.length ?? 0) > 0;
}

/** The heuristic reasons for one Create; empty when it is not suspicious. */
export async function spamReasons(
  input: SpamInput,
  cfg: FederationSpamConfig,
  now = Date.now(),
): Promise<string[]> {
  const reasons: string[] = [];
  if (countMentions(input.object) >= cfg.federation_max_mentions) {
    reasons.push('mass_mention');
  }

  if (cfg.federation_new_actor_days > 0) {
    const { ageMs, known } = await actorAgeMs(input.authorId, now);
    const isNew = ageMs !== null && ageMs < cfg.federation_new_actor_days * 86_400_000;
    if (isNew) {
      const [followed, related] = await Promise.all([
        hasLocalFollower(input.authorId),
        hasRelationship(input.authorId, input.targetIds),
      ]);
      if (!followed && !related) {
        reasons.push('new_actor', 'no_followers', 'no_relationship');
        if (!known) reasons.push('unknown_age');
      }
    }
  }
  return reasons;
}

async function record(input: SpamInput, verdict: SpamVerdict): Promise<void> {
  const activityId = typeof input.activity?.id === 'string'
    ? input.activity.id
    : typeof input.object?.id === 'string' ? input.object.id : null;
  const row = {
    kind: input.kind,
    action: verdict.action === 'flag' ? 'flagged' : verdict.action === 'hold' ? 'held' : 'rejected',
    actor_id: input.authorId,
    actor_uri: input.authorUri,
    actor_domain: hostOf(input.authorUri),
    target_ids: input.targetIds.slice(0, 100),
    reasons: verdict.reasons,
    activity_id: activityId,
    activity: verdict.action === 'hold' ? input.activity : null,
    summary: textSummary(input.object),
  };
  // A redelivered activity keeps its first row.
  const { error } = await getSupabaseClient()
    .from('suspicious_activity')
    .upsert(row, { onConflict: 'activity_id', ignoreDuplicates: true });
  if (error) {
    logger.warn(`Failed to record suspicious activity ${activityId}:`, error.message);
  }
}

/**
 * Evaluates a Create addressed to local users and records it when suspicious.
 * Errors in the heuristics allow delivery: a broken check must not drop mail.
 */
export async function evaluateInboundCreate(input: SpamInput): Promise<SpamVerdict> {
  if (input.targetIds.length === 0) return { action: 'allow', reasons: [] };
  try {
    const cfg = await getSpamConfig();
    if (cfg.federation_spam_mode === 'off') return { action: 'allow', reasons: [] };
    const reasons = await spamReasons(input, cfg);
    if (reasons.length === 0) return { action: 'allow', reasons };
    const verdict: SpamVerdict = { action: cfg.federation_spam_mode, reasons };
    await record(input, verdict);
    logger.info(
      `Suspicious ${input.kind} from ${input.authorUri} (${reasons.join(', ')}): ${verdict.action}`,
    );
    return verdict;
  } catch (error) {
    logger.warn('Spam evaluation failed, delivering:', error);
    return { action: 'allow', reasons: [] };
  }
}
