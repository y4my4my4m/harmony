/**
 * Server AutoMod, member timeouts and instance anti-spam (RPCs from
 * 20261005100001_server_automod.sql).
 *
 * Enforcement is in the database: a BEFORE trigger on messages drops a blocked
 * row (zero rows returned) or raises AUTOMOD_BLOCKED / MEMBER_TIMED_OUT /
 * ANTISPAM_*. Nothing here decides whether a message may be sent.
 */
import { supabase } from '@/supabase'
import { i18n } from '@/i18n'

export type AutoModRuleType =
  | 'keyword'
  | 'keyword_preset'
  | 'mention_spam'
  | 'message_flood'
  | 'duplicate_spam'
  | 'invites'
  | 'links'
  | 'new_member'

export type AutoModPreset = 'profanity' | 'sexual' | 'slurs'

export interface AutoModActions {
  block: boolean
  alert: boolean
  /** 0 = no timeout; at most 28 days. */
  timeout_seconds: number
  /** Shown to the author of a blocked message; at most 150 characters. */
  block_message: string | null
}

export interface AutoModRule {
  id?: string
  name: string
  rule_type: AutoModRuleType
  enabled: boolean
  config: Record<string, any>
  actions: AutoModActions
  exempt_role_ids: string[]
  /** Channel or category ids. */
  exempt_channel_ids: string[]
  position?: number
  updated_at?: string
}

export interface AutoModRaidSettings {
  enabled: boolean
  join_threshold: number
  window_seconds: number
  action: 'alert' | 'slowmode'
  slowmode_seconds: number
}

export interface AutoModRaidState {
  active: boolean
  since?: string
  lifted_at?: string
  slowmode_seconds?: number
  channels?: Record<string, number>
}

export interface AutoModSettings {
  enabled: boolean
  alert_channel_id: string | null
  exempt_bots: boolean
  raid_settings: AutoModRaidSettings
  raid_state: AutoModRaidState
  last_raid_at: string | null
  prompt_dismissed_at: string | null
  updated_at: string | null
}

export interface AutoModState {
  status: 'unconfigured' | 'enabled' | 'disabled'
  settings: AutoModSettings | null
  rules: AutoModRule[]
}

export interface AutoModEvent {
  id: string
  event_type: 'message' | 'edit' | 'raid'
  rule_id: string | null
  rule_name: string | null
  rule_type: string | null
  actions: string[]
  matched: string | null
  content_excerpt: string | null
  details: Record<string, any>
  hits: number
  created_at: string
  last_hit_at: string
  channel_id: string | null
  channel_name: string | null
  user_id: string | null
  username: string | null
  display_name: string | null
  avatar_url: string | null
  domain: string | null
  is_local: boolean | null
  bot_id: string | null
  bot_name: string | null
  timeout_until: string | null
}

export interface AutoModTimeout {
  user_id: string
  until: string
  reason: string | null
  source: 'moderator' | 'automod'
  created_at: string
  username: string
  display_name: string | null
  avatar_url: string | null
  domain: string | null
  is_local: boolean
}

export interface AutoModBlockNotice {
  rule_type: string | null
  rule_name: string | null
  event_type: 'message' | 'edit'
  message: string | null
  timeout_until: string | null
  at: string
}

export interface InstanceAntiSpamSettings {
  new_account_hours: number
  new_account_messages_per_minute: number
  new_account_posts_per_hour: number
  new_account_max_stranger_mentions: number
  new_account_block_links: boolean
  federation_spam_mode: 'off' | 'flag' | 'hold' | 'reject'
  federation_max_mentions: number
  federation_new_actor_days: number
}

export interface SuspiciousActivity {
  id: string
  created_at: string
  kind: 'federation_mention' | 'federation_dm'
  status: 'open' | 'released' | 'dismissed' | 'confirmed'
  action: 'flagged' | 'held' | 'rejected'
  actor_id: string | null
  actor_uri: string | null
  actor_domain: string | null
  actor_username: string | null
  actor_display_name: string | null
  actor_avatar_url: string | null
  actor_suspended: boolean | null
  target_ids: string[]
  targets: { id: string; username: string }[]
  reasons: string[]
  activity_id: string | null
  summary: string | null
  has_activity: boolean
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
}

/** Rule types the "Add rule" menu offers, in display order. */
export const AUTOMOD_RULE_TYPES: AutoModRuleType[] = [
  'keyword',
  'keyword_preset',
  'mention_spam',
  'message_flood',
  'duplicate_spam',
  'invites',
  'links',
  'new_member',
]

/** Defaults for a new rule of each type; the database fills the same values. */
export function defaultRuleConfig(type: AutoModRuleType): Record<string, any> {
  switch (type) {
    case 'keyword':
      return { keywords: [], regex_patterns: [], allow_list: [] }
    case 'keyword_preset':
      return { presets: ['slurs'], allow_list: [] }
    case 'mention_spam':
      return { max_mentions: 20, window_mentions: 50, window_seconds: 60, block_everyone_without_permission: false }
    case 'message_flood':
      return { max_messages: 10, window_seconds: 10 }
    case 'duplicate_spam':
      return { max_channels: 2, window_seconds: 300, min_length: 10 }
    case 'invites':
      return {}
    case 'links':
      return { mode: 'allow_list', domains: [] }
    case 'new_member':
      return {
        min_account_age_minutes: 1440,
        min_membership_minutes: 10,
        restrict_links: true,
        restrict_attachments: false,
        restrict_mentions: false,
      }
  }
}

export function newRule(type: AutoModRuleType, name: string): AutoModRule {
  return {
    name,
    rule_type: type,
    enabled: true,
    config: defaultRuleConfig(type),
    actions: { block: true, alert: true, timeout_seconds: 0, block_message: null },
    exempt_role_ids: [],
    exempt_channel_ids: [],
  }
}

/** Timeout lengths offered in the UI, Discord's set. */
export const TIMEOUT_CHOICES: number[] = [60, 300, 600, 3600, 86400, 604800]

function unwrap<T>(result: { data: any; error: any }): T {
  if (result.error) {
    throw new Error(cleanDbMessage(result.error.message || 'Request failed'))
  }
  return result.data as T
}

/** Strips the AUTOMOD_INVALID_RULE: style prefix the database puts on validation errors. */
export function cleanDbMessage(message: string): string {
  return message.replace(/^(AUTOMOD_INVALID_RULE|AUTOMOD_INVALID_SETTINGS|ANTISPAM_INVALID_SETTINGS):\s*/, '')
}

export async function getServerAutoMod(serverId: string): Promise<AutoModState> {
  return unwrap(await supabase.rpc('get_server_automod', { p_server_id: serverId }))
}

export async function enableAutoModPreset(serverId: string): Promise<AutoModState> {
  return unwrap(await supabase.rpc('enable_server_automod_preset', { p_server_id: serverId }))
}

export async function dismissAutoModPrompt(serverId: string): Promise<AutoModState> {
  return unwrap(await supabase.rpc('dismiss_server_automod_prompt', { p_server_id: serverId }))
}

export async function updateAutoModSettings(
  serverId: string,
  patch: Partial<Pick<AutoModSettings, 'enabled' | 'alert_channel_id' | 'exempt_bots' | 'raid_settings'>>,
): Promise<AutoModState> {
  return unwrap(await supabase.rpc('update_server_automod_settings', { p_server_id: serverId, p_settings: patch }))
}

export async function saveAutoModRule(serverId: string, rule: AutoModRule): Promise<AutoModState> {
  return unwrap(await supabase.rpc('upsert_server_automod_rule', { p_server_id: serverId, p_rule: rule }))
}

export async function deleteAutoModRule(ruleId: string): Promise<AutoModState> {
  return unwrap(await supabase.rpc('delete_server_automod_rule', { p_rule_id: ruleId }))
}

export async function getAutoModEvents(serverId: string, before?: string, limit = 50): Promise<AutoModEvent[]> {
  return unwrap(
    await supabase.rpc('get_server_automod_events', {
      p_server_id: serverId,
      p_limit: limit,
      p_before: before ?? null,
    }),
  )
}

export async function setRaidLockdown(serverId: string, active: boolean): Promise<AutoModState> {
  return unwrap(await supabase.rpc('set_server_raid_lockdown', { p_server_id: serverId, p_active: active }))
}

/** seconds = 0 lifts the timeout. */
export async function setMemberTimeout(
  serverId: string,
  userId: string,
  seconds: number,
  reason?: string,
): Promise<{ user_id: string; until: string | null }> {
  return unwrap(
    await supabase.rpc('set_server_member_timeout', {
      p_server_id: serverId,
      p_user_id: userId,
      p_seconds: seconds,
      p_reason: reason ?? null,
    }),
  )
}

export async function getMemberTimeouts(serverId: string): Promise<AutoModTimeout[]> {
  return unwrap(await supabase.rpc('get_server_member_timeouts', { p_server_id: serverId }))
}

export async function getInstanceAntiSpamSettings(): Promise<InstanceAntiSpamSettings> {
  return unwrap(await supabase.rpc('get_instance_antispam_settings'))
}

export async function updateInstanceAntiSpamSettings(
  patch: Partial<InstanceAntiSpamSettings>,
): Promise<InstanceAntiSpamSettings> {
  return unwrap(await supabase.rpc('update_instance_antispam_settings', { p_settings: patch }))
}

export async function getSuspiciousActivity(
  status: 'open' | 'all' | SuspiciousActivity['status'] = 'open',
  before?: string,
): Promise<SuspiciousActivity[]> {
  return unwrap(
    await supabase.rpc('get_suspicious_activity', { p_status: status, p_limit: 50, p_before: before ?? null }),
  )
}

export async function reviewSuspiciousActivity(
  id: string,
  decision: 'dismiss' | 'confirm' | 'release',
  note?: string,
): Promise<{ id: string; status: string }> {
  return unwrap(
    await supabase.rpc('review_suspicious_activity', { p_id: id, p_decision: decision, p_note: note ?? null }),
  )
}

// ---------------------------------------------------------------------------
// Rejections surfaced to the author
// ---------------------------------------------------------------------------

export type ModerationRejectionCode =
  | 'AUTOMOD_BLOCKED'
  | 'MEMBER_TIMED_OUT'
  | 'ANTISPAM_RATE_LIMITED'
  | 'ANTISPAM_LINKS_BLOCKED'
  | 'ANTISPAM_STRANGER_MENTIONS'
  | 'RULES_NOT_ACCEPTED'

export interface ModerationRejection {
  code: ModerationRejectionCode
  message: string
  details?: any
}

const REJECTION_PATTERN =
  /(AUTOMOD_BLOCKED|MEMBER_TIMED_OUT|ANTISPAM_RATE_LIMITED|ANTISPAM_LINKS_BLOCKED|ANTISPAM_STRANGER_MENTIONS|RULES_NOT_ACCEPTED)(?::([^\s"]+))?/

export function isModerationRejectionCode(code: string | null | undefined): boolean {
  return !!code && REJECTION_PATTERN.test(code)
}

function t(key: string, params?: Record<string, unknown>): string {
  return (i18n.global as any).t(key, params ?? {}) as string
}

function formatUntil(epochOrIso: string | number | null | undefined): string {
  if (epochOrIso == null || epochOrIso === '') return ''
  const date = typeof epochOrIso === 'number' || /^\d+$/.test(String(epochOrIso))
    ? new Date(Number(epochOrIso) * 1000)
    : new Date(String(epochOrIso))
  if (Number.isNaN(date.getTime())) return ''
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

/** The author-facing sentence for a block notice. */
export function describeBlockNotice(notice: Partial<AutoModBlockNotice> | null | undefined): string {
  if (notice?.message) return notice.message
  const type = notice?.rule_type ?? ''
  const key = [
    'keyword', 'keyword_preset', 'mention_spam', 'message_flood', 'duplicate_spam', 'invites', 'links', 'new_member',
  ].includes(type)
    ? `automod.blocked.${type}`
    : 'automod.blocked.generic'
  let text = t(key)
  if (notice?.timeout_until) {
    text += ' ' + t('automod.blocked.timedOutUntil', { time: formatUntil(notice.timeout_until) })
  }
  return text
}

/**
 * Maps a database error raised by the moderation triggers to a rejection, or
 * null for any other error. Matches the message, details and hint, since the
 * code sits in whichever of them the caller's error wrapper kept.
 */
export function moderationRejectionFromError(error: any): ModerationRejection | null {
  if (!error) return null
  const haystack = [error.code, error.message, error.details, error.hint]
    .filter((v) => typeof v === 'string')
    .join(' ')
  const match = haystack.match(REJECTION_PATTERN)
  if (!match) return null
  const code = match[1] as ModerationRejectionCode
  const arg = match[2]
  switch (code) {
    case 'AUTOMOD_BLOCKED': {
      let details: any = null
      try {
        details = typeof error.details === 'string' ? JSON.parse(error.details) : error.details
      } catch {
        details = null
      }
      return { code, message: describeBlockNotice(details ?? { rule_type: arg }), details }
    }
    case 'MEMBER_TIMED_OUT':
      return { code, message: t('automod.timedOut', { time: formatUntil(arg) }), details: { until: arg } }
    case 'ANTISPAM_RATE_LIMITED':
      return { code, message: t('automod.antispam.rateLimited', { seconds: arg ?? '60' }) }
    case 'ANTISPAM_LINKS_BLOCKED':
      return { code, message: t('automod.antispam.linksBlocked') }
    case 'ANTISPAM_STRANGER_MENTIONS':
      return { code, message: t('automod.antispam.strangerMentions', { count: arg ?? '0' }) }
    // 20261006300001_welcome_server_and_rules.sql; arg is the server id.
    case 'RULES_NOT_ACCEPTED':
      return { code, message: t('serverWelcome.rulesRequired'), details: { serverId: arg ?? null } }
  }
  return null
}

/**
 * The rejection for a channel write that came back with zero rows. The trigger
 * records the block before dropping the row; the notice names the rule type and
 * the server's custom message.
 */
export async function blockedMessageRejection(channelId: string | null | undefined): Promise<ModerationRejection> {
  let notice: AutoModBlockNotice | null = null
  if (channelId) {
    const { data } = await supabase.rpc('get_automod_block_notice', { p_channel_id: channelId })
    notice = (data as AutoModBlockNotice | null) ?? null
  }
  return { code: 'AUTOMOD_BLOCKED', message: describeBlockNotice(notice), details: notice }
}
