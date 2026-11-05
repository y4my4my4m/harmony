import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'
import { hasCapability } from '@/services/instanceCapabilities'
import { debug } from '@/utils/debug'

export interface FundingConfig {
  id: string
  enabled: boolean
  goal_amount: number | null
  goal_currency: string
  current_amount: number
  funding_period?: 'all' | 'monthly'
  goal_description: string | null
  funding_links: FundingLink[]
  show_progress_bar: boolean
  show_in_context_bar: boolean
  context_bar_style: string
  thank_you_message: string | null
  /** When true, auto-assign supporter tier on webhook based on amount. */
  kofi_auto_assign_tier: boolean
  /** As kofi_auto_assign_tier, for the Stripe webhook. */
  stripe_auto_assign_tier: boolean
  /** Donors may attach a message; approved ones show in the Support window. */
  supporter_messages_enabled?: boolean
  /** Approved messages also show signed out: the sign-in page and the public funding feed. */
  supporter_messages_public?: boolean
  /** The Harmony development tab shows the project's supporter messages. */
  show_project_messages?: boolean
}

/**
 * Client-readable funding columns. The Ko-fi webhook token and the Stripe signing secret are
 * not among them: clients hold no privilege on either, and admins use the get/set RPCs.
 */
const FUNDING_CONFIG_COLUMNS =
  'id, enabled, goal_amount, goal_currency, current_amount, funding_period, goal_description, ' +
  'funding_links, show_progress_bar, show_in_context_bar, context_bar_style, thank_you_message, ' +
  'kofi_auto_assign_tier, stripe_auto_assign_tier'
const MESSAGE_SWITCH_COLUMNS = ', supporter_messages_enabled, supporter_messages_public, show_project_messages'

/** Canonical platform keys rendered with branded icons in the UI. */
export const FUNDING_PLATFORMS = [
  'ko-fi',
  'patreon',
  'github-sponsors',
  'liberapay',
  'open-collective',
  'paypal',
  'buymeacoffee',
  'stripe',
  'custom',
] as const
export type FundingPlatformKey = typeof FUNDING_PLATFORMS[number]

/** Config with current_amount computed from donation history (for progress display) */
export interface FundingConfigWithProgress extends FundingConfig {
  displayed_amount: number
}

/** Condition of the goal progress pill (context bar) and card (social sidebar). */
export function showsFundingGoal<T extends Pick<FundingConfig, 'enabled' | 'show_in_context_bar' | 'goal_amount'>>(
  config: T | null | undefined,
): config is T & { goal_amount: number } {
  return !!(config?.enabled && config.show_in_context_bar && config.goal_amount)
}

/** An approved supporter message as members see it. Anonymous: no name, avatar or profile id. */
export interface SupporterMessage {
  id: string
  body: string
  anonymous: boolean
  at: string
  user_id: string | null
  name: string | null
  avatar_url: string | null
}

export type SupporterMessageReview = 'pending' | 'approved' | 'hidden'

/** One of the caller's own messages: unattached until a donation within 24 hours of writing it. */
export interface MySupporterMessage {
  id: string
  body: string
  anonymous: boolean
  attached: boolean
  review: SupporterMessageReview
  created_at: string
  attached_at: string | null
  /** End of the attach window of an unattached message. */
  expires_at: string | null
}

export interface MyFunding {
  profile_id: string
  badge: (SupporterBadge & { expires_at: string | null }) | null
  donations: Array<Pick<DonationRecord, 'id' | 'amount' | 'currency' | 'platform' | 'note' | 'donated_at'>>
  messages: MySupporterMessage[]
}

/** public.get_funding_summary(): everything the pill, the Support window and settings show. */
export interface FundingSummary extends FundingConfigWithProgress {
  /** Start and end of the monthly period, UTC; null for all time. */
  period_start: string | null
  period_end: string | null
  supporter_count: number
  tiers: SupporterTier[]
  messages: SupporterMessage[]
  me: MyFunding | null
}

/** A message on the sign-in page: no profile id; name null for an anonymous one. */
export interface PublicSupporterMessage {
  id: string
  body: string
  name: string | null
  at: string
}

/** An instance's public funding feed (federation-backend services/projectFunding.ts). */
export interface PublicFunding {
  version: number
  instance: string
  enabled: boolean
  goal: {
    amount: number
    currency: string
    period: 'monthly' | 'all'
    raised: number
    periodEnd: string | null
    description: string | null
  } | null
  supporters: number
  links: FundingLink[]
  messages: PublicSupporterMessage[]
}

/** GET /funding/project. */
export type ProjectFundingResponse =
  | { projectInstance: true }
  | {
      projectInstance: false
      source: 'upstream' | 'stale' | 'fallback'
      fetchedAt: string | null
      funding: PublicFunding
    }

/** An attached message in the admin review queue. */
export interface AdminSupporterMessage {
  id: string
  body: string
  anonymous: boolean
  review: SupporterMessageReview
  attached_at: string
  reviewed_at: string | null
  user_id: string
  username: string | null
  display_name: string | null
  amount: number | null
  currency: string | null
}

/** set_supporter_message refusal: the rule from the error hint, or 'disabled' / 'failed'. */
export class SupporterMessageError extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

export interface FundingLink {
  platform: string
  url: string
  label: string
}

/** Stripe Payment Links: the webhook credits the profile in client_reference_id. */
export const isStripeLink = (link: Pick<FundingLink, 'platform'>): boolean =>
  link.platform.toLowerCase() === 'stripe'

/**
 * The URL a donor opens. A Stripe Payment Link carries the donor's profile id as
 * client_reference_id and their email as prefilled_email; other links are unchanged.
 * https://docs.stripe.com/payment-links/url-parameters
 */
export function donationLinkHref(
  link: FundingLink,
  donor: { profileId?: string | null; email?: string | null } = {},
): string {
  if (!isStripeLink(link) || !donor.profileId) return link.url
  try {
    const url = new URL(link.url)
    url.searchParams.set('client_reference_id', donor.profileId)
    if (donor.email && !url.searchParams.has('prefilled_email')) {
      url.searchParams.set('prefilled_email', donor.email)
    }
    return url.toString()
  } catch {
    return link.url
  }
}

/** Stripe links first: they credit the donor without a handle. Order within each group is kept. */
export const orderDonationLinks = (links: FundingLink[]): FundingLink[] => [
  ...links.filter(isStripeLink),
  ...links.filter((link) => !isStripeLink(link)),
]

/** Whether any link needs the donor's handle in the donation message to be attributed. */
export const needsHandleInMessage = (links: FundingLink[]): boolean =>
  links.some((link) => !isStripeLink(link))

export interface SupporterTier {
  id: string
  name: string
  min_amount: number
  badge_icon: string | null
  badge_color: string | null
  perks: string | null
  display_order: number
  /** When true, active supporters on this tier get the ad-free GIF picker. */
  removes_ads?: boolean
}

/** A supporter as admin_list_supporters() returns it; amount, platform and external_id are admin-only. */
export interface Supporter {
  id: string
  user_id: string
  tier_id: string | null
  amount: number | null
  started_at: string
  expires_at: string | null
  is_active: boolean
  platform: string | null
  external_id?: string | null
  tier?: SupporterTier | null
  user?: {
    username: string
    display_name: string
    avatar_url: string
  }
}

export interface SupporterBadge {
  tier_name: string
  badge_icon: string | null
  badge_color: string | null
  is_active: boolean
}

export interface DonationRecord {
  id: string
  supporter_id: string
  user_id: string
  amount: number
  currency: string
  platform: string | null
  external_reference: string | null
  note: string | null
  donated_at: string
  user?: {
    username: string
    display_name: string
    avatar_url: string
  }
}

/**
 * Donations received via webhook that couldn't be auto-matched to a profile.
 * Admins resolve these manually via the funding admin panel.
 */
export interface PendingDonation {
  id: string
  received_at: string
  platform: string
  external_reference: string | null
  amount: number
  currency: string
  donor_name: string | null
  donor_email: string | null
  donor_message: string | null
  raw_payload: Record<string, unknown>
  resolved_at: string | null
  resolved_by: string | null
  resolved_user_id: string | null
}

// A badge changes when its holder's support does; the holder's own is re-primed from the summary.
const BADGE_CACHE_TTL = 30 * 60 * 1000
const badgeCache = new Map<string, { badge: SupporterBadge | null; fetchedAt: number }>()

// Dedup in-flight badge requests so concurrent calls for the same user share one RPC
const pendingBadgeRequests = new Map<string, Promise<SupporterBadge | null>>()

// Coalescing batch loader (DataLoader-style).
//
// A chat view renders one <SupporterBadge> per message author, each calling
// getSupporterBadge() on mount within the same tick. userIds requested in the
// same microtask resolve through a single get_supporter_badges(uuid[])
// round-trip rather than one /rpc/get_supporter_badge POST each.
const badgeLoadQueue = new Set<string>()
const badgeQueueResolvers = new Map<string, Array<(badge: SupporterBadge | null) => void>>()
let badgeFlushScheduled = false

async function flushBadgeQueue(): Promise<void> {
  badgeFlushScheduled = false
  const userIds = Array.from(badgeLoadQueue)
  badgeLoadQueue.clear()
  const resolvers = new Map(badgeQueueResolvers)
  badgeQueueResolvers.clear()
  if (userIds.length === 0) return

  const resolveOne = (id: string, badge: SupporterBadge | null) => {
    badgeCache.set(id, { badge, fetchedAt: Date.now() })
    resolvers.get(id)?.forEach(fn => fn(badge))
  }

  try {
    const { data, error } = await supabase.rpc('get_supporter_badges', {
      p_user_ids: userIds,
    })
    if (error) throw error

    const byUser = new Map<string, SupporterBadge>()
    for (const row of (data || []) as Array<{ user_id: string } & SupporterBadge>) {
      byUser.set(row.user_id, {
        tier_name: row.tier_name,
        badge_icon: row.badge_icon,
        badge_color: row.badge_color,
        is_active: row.is_active,
      })
    }
    for (const id of userIds) {
      resolveOne(id, byUser.get(id) || null)
    }
  } catch (error) {
    debug.error('Failed to batch-get supporter badges:', error)
    // Cache null so a transient failure doesn't re-trigger a storm immediately.
    for (const id of userIds) {
      resolveOne(id, null)
    }
  }
}

function queueBadgeLoad(userId: string): Promise<SupporterBadge | null> {
  return new Promise<SupporterBadge | null>(resolve => {
    badgeLoadQueue.add(userId)
    const list = badgeQueueResolvers.get(userId) || []
    list.push(resolve)
    badgeQueueResolvers.set(userId, list)
    if (!badgeFlushScheduled) {
      badgeFlushScheduled = true
      queueMicrotask(() => { void flushBadgeQueue() })
    }
  })
}

type SupporterMembership = {
  is_active: boolean
  tier: { name: string; badge_icon: string | null; badge_color: string | null } | null
}

// Normalizes the PostgREST embed `author.supporter_membership` into the SupporterBadge shape
// returned by getSupporterBadge. instance_supporters.user_id is unique, so PostgREST embeds it
// as one object or null; get_home_timeline_page builds an array.
export function badgeFromMembership(
  membership: SupporterMembership | SupporterMembership[] | null | undefined
): SupporterBadge | null {
  const rows = Array.isArray(membership) ? membership : membership ? [membership] : []
  const active = rows.find(m => m?.is_active && m.tier)
  if (!active || !active.tier) return null
  return {
    tier_name: active.tier.name,
    badge_icon: active.tier.badge_icon,
    badge_color: active.tier.badge_color,
    is_active: true,
  }
}

// Caches pre-resolved badges so SupporterBadge renders without an RPC.
// Called by timeline loaders that already hold the embed data.
export function primeBadgeCache(userId: string, badge: SupporterBadge | null): void {
  badgeCache.set(userId, { badge, fetchedAt: Date.now() })
}

class FundingService {
  async getFundingConfig(): Promise<FundingConfig | null> {
    try {
      // Signed-in users read instance_funding (column grants, 20261006700001); anon is refused
      // with 42501. A read before the session is attached, or after sign-out, is skipped.
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return null
      const { data, error } = await supabase
        .from('instance_funding')
        .select(FUNDING_CONFIG_COLUMNS + (hasCapability('supporter-messages') ? MESSAGE_SWITCH_COLUMNS : ''))
        .limit(1)
        .maybeSingle()

      if (error) throw error
      return data as unknown as FundingConfig | null
    } catch (error) {
      debug.error('Failed to get funding config:', error)
      return null
    }
  }

  /** Ko-fi verification token; instance admins only. Empty string when unset. */
  async getKofiWebhookToken(): Promise<string> {
    try {
      const { data, error } = await supabase.rpc('get_kofi_webhook_token')
      if (error) throw error
      return typeof data === 'string' ? data : ''
    } catch (error) {
      debug.error('Failed to get Ko-fi webhook token:', error)
      return ''
    }
  }

  /** Sets the Ko-fi verification token; empty disables the webhook. Instance admins only. */
  async setKofiWebhookToken(token: string): Promise<boolean> {
    try {
      const { error } = await supabase.rpc('set_kofi_webhook_token', { p_token: token })
      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to set Ko-fi webhook token:', error)
      return false
    }
  }

  /** Stripe webhook signing secret; instance admins only. Empty string when unset. */
  async getStripeWebhookSecret(): Promise<string> {
    try {
      const { data, error } = await supabase.rpc('get_stripe_webhook_secret')
      if (error) throw error
      return typeof data === 'string' ? data : ''
    } catch (error) {
      debug.error('Failed to get Stripe webhook secret:', error)
      return ''
    }
  }

  /** Sets the Stripe signing secret (whsec_...); empty disables the webhook. Instance admins only. */
  async setStripeWebhookSecret(secret: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const { error } = await supabase.rpc('set_stripe_webhook_secret', { p_secret: secret })
      if (error) throw error
      return { ok: true }
    } catch (error: any) {
      debug.error('Failed to set Stripe webhook secret:', error)
      return { ok: false, message: error?.code === '22023' ? error.message : undefined }
    }
  }

  /** Returns funding total from donation history (RPC, respects RLS via SECURITY DEFINER) */
  async getFundingCurrentTotal(period: 'all' | 'monthly' = 'monthly'): Promise<number> {
    try {
      const { data, error } = await supabase.rpc('get_funding_current_total', {
        p_period: period,
      })
      if (error) throw error
      return Number(data ?? 0)
    } catch (error) {
      debug.error('Failed to get funding current total:', error)
      return 0
    }
  }

  /**
   * Returns config with displayed_amount computed from donation history.
   * Use this for progress bar / funding modal display.
   */
  async getFundingWithProgress(): Promise<FundingConfigWithProgress | null> {
    const config = await this.getFundingConfig()
    if (!config) return null
    const period = config.funding_period === 'all' ? 'all' : 'monthly'
    const displayedAmount = await this.getFundingCurrentTotal(period)
    return {
      ...config,
      displayed_amount: displayedAmount,
    }
  }

  /**
   * One read of everything funding shows (get_funding_summary). An instance without the
   * supporter-messages capability answers through the per-table reads it has.
   */
  async getFundingSummary(): Promise<FundingSummary | null> {
    if (!hasCapability('supporter-messages')) return this.getLegacySummary()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return null
    const { data, error } = await supabase.rpc('get_funding_summary')
    if (error) throw error
    if (!data) return null
    const summary = data as FundingSummary
    return { ...summary, displayed_amount: Number(summary.displayed_amount ?? 0) }
  }

  /** As getFundingSummary from the reads of an instance before 1.9.3: no messages. */
  private async getLegacySummary(): Promise<FundingSummary | null> {
    const config = await this.getFundingWithProgress()
    if (!config) return null
    const { data: { session } } = await supabase.auth.getSession()
    const profileId = session?.user?.id ?? null
    const [tiers, count, badge, donations] = await Promise.all([
      this.getTiers(),
      this.getActiveSupporterCount(),
      profileId ? this.getSupporterBadge(profileId) : Promise.resolve(null),
      profileId ? this.getDonationHistory(profileId) : Promise.resolve([]),
    ])
    return {
      ...config,
      period_start: null,
      period_end: null,
      supporter_count: count,
      tiers,
      messages: [],
      me: profileId ? {
        profile_id: profileId,
        badge: badge ? { ...badge, expires_at: null } : null,
        donations,
        messages: [],
      } : null,
    }
  }

  /** Writes the caller's message for their next donation; throws SupporterMessageError. */
  async setSupporterMessage(body: string, anonymous: boolean): Promise<MySupporterMessage> {
    const { data, error } = await supabase.rpc('set_supporter_message', {
      p_body: body,
      p_anonymous: anonymous,
    })
    if (error) {
      debug.warn('set_supporter_message refused:', error)
      const hint = (error as { hint?: string }).hint
      throw new SupporterMessageError(error.code === '22023' || error.code === '55000' ? hint || 'failed' : 'failed')
    }
    return { ...(data as MySupporterMessage), attached: false, review: 'pending', attached_at: null }
  }

  async deleteSupporterMessage(id: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('delete_supporter_message', { p_id: id })
    if (error) {
      debug.error('Failed to delete supporter message:', error)
      return false
    }
    return data === true
  }

  /** Approved messages for the sign-in page; empty when the instance does not show them. */
  async getPublicSupporterMessages(limit = 6): Promise<PublicSupporterMessage[]> {
    try {
      if (!hasCapability('supporter-messages')) return []
      const { data, error } = await supabase.rpc('get_public_supporter_messages', { p_limit: limit })
      if (error) throw error
      return Array.isArray(data) ? (data as PublicSupporterMessage[]) : []
    } catch (error) {
      debug.warn('Failed to read supporter messages:', error)
      return []
    }
  }

  /**
   * The Harmony project's funding through this instance's backend; null when unavailable.
   * `fresh` revalidates past the response's max-age.
   */
  async getProjectFunding(options: { fresh?: boolean } = {}): Promise<ProjectFundingResponse | null> {
    if (!hasCapability('supporter-messages')) return null
    try {
      const res = await fetch(apiUrl('/api/federation/funding/project'), {
        headers: { Accept: 'application/json' },
        cache: options.fresh ? 'no-cache' : 'default',
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      return (await res.json()) as ProjectFundingResponse
    } catch (error) {
      debug.warn('Failed to read the project funding:', error)
      return null
    }
  }

  /** Attached messages, awaiting review first. Instance admins only. */
  async adminListSupporterMessages(): Promise<AdminSupporterMessage[]> {
    try {
      const { data, error } = await supabase.rpc('admin_list_supporter_messages')
      if (error) throw error
      return Array.isArray(data) ? (data as AdminSupporterMessage[]) : []
    } catch (error) {
      debug.error('Failed to list supporter messages:', error)
      return []
    }
  }

  /** Instance admins only. */
  async adminReviewSupporterMessage(id: string, review: 'approved' | 'hidden'): Promise<boolean> {
    const { error } = await supabase.rpc('admin_review_supporter_message', { p_id: id, p_review: review })
    if (error) {
      debug.error('Failed to review supporter message:', error)
      return false
    }
    return true
  }

  async updateFundingConfig(config: Partial<FundingConfig & { funding_period?: 'all' | 'monthly' }>): Promise<boolean> {
    try {
      const existing = await this.getFundingConfig()

      if (existing) {
        const { error } = await supabase
          .from('instance_funding')
          .update({ ...config, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('instance_funding')
          .insert(config)
        if (error) throw error
      }

      return true
    } catch (error) {
      debug.error('Failed to update funding config:', error)
      return false
    }
  }

  async getTiers(): Promise<SupporterTier[]> {
    try {
      const { data, error } = await supabase
        .from('instance_supporter_tiers')
        .select('*')
        .order('display_order', { ascending: true })

      if (error) throw error
      return data || []
    } catch (error) {
      debug.error('Failed to get supporter tiers:', error)
      return []
    }
  }

  async createTier(tier: Omit<SupporterTier, 'id'>): Promise<SupporterTier | null> {
    try {
      const { data, error } = await supabase
        .from('instance_supporter_tiers')
        .insert(tier)
        .select()
        .single()

      if (error) throw error
      return data
    } catch (error) {
      debug.error('Failed to create tier:', error)
      return null
    }
  }

  async updateTier(tierId: string, updates: Partial<SupporterTier>): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('instance_supporter_tiers')
        .update(updates)
        .eq('id', tierId)

      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to update tier:', error)
      return false
    }
  }

  async deleteTier(tierId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('instance_supporter_tiers')
        .delete()
        .eq('id', tierId)

      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to delete tier:', error)
      return false
    }
  }

  /** Active supporters, newest first. Instance admins only. */
  async getSupporters(): Promise<Supporter[]> {
    try {
      const { data, error } = await supabase.rpc('admin_list_supporters')
      if (error) throw error
      return Array.isArray(data) ? (data as Supporter[]) : []
    } catch (error) {
      debug.error('Failed to get supporters:', error)
      return []
    }
  }

  async getActiveSupporterCount(): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('instance_supporters')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true)

      if (error) throw error
      return count ?? 0
    } catch (error) {
      debug.error('Failed to count supporters:', error)
      return 0
    }
  }

  /** Creates or reactivates a supporter row; platform defaults to 'manual'. Instance admins only. */
  async addSupporter(userId: string, tierId?: string, amount?: number, platform?: string): Promise<boolean> {
    try {
      const { error } = await supabase.rpc('admin_add_supporter', {
        p_user_id: userId,
        p_tier_id: tierId || null,
        p_amount: amount || null,
        p_platform: platform || null,
      })
      if (error) throw error
      badgeCache.delete(userId)
      return true
    } catch (error) {
      debug.error('Failed to add supporter:', error)
      return false
    }
  }

  async removeSupporter(userId: string): Promise<boolean> {
    return this.updateSupporter(userId, { is_active: false })
  }

  async getSupporterBadge(userId: string): Promise<SupporterBadge | null> {
    const cached = badgeCache.get(userId)
    if (cached && Date.now() - cached.fetchedAt < BADGE_CACHE_TTL) {
      return cached.badge
    }

    // Dedup concurrent requests for the same userId
    const pending = pendingBadgeRequests.get(userId)
    if (pending) return pending

    // Coalesce with every other badge requested in this microtask into a single
    // get_supporter_badges([...]) call instead of one RPC per user.
    const request = queueBadgeLoad(userId).finally(() => {
      pendingBadgeRequests.delete(userId)
    })
    pendingBadgeRequests.set(userId, request)
    return request
  }

  /** Fills the badge cache so individual SupporterBadge components skip the RPC. */
  async prefetchBadges(userIds: string[]): Promise<void> {
    const now = Date.now()
    const uncached = [...new Set(userIds)].filter(id => {
      const cached = badgeCache.get(id)
      return !cached || now - cached.fetchedAt >= BADGE_CACHE_TTL
    })
    if (uncached.length === 0) return

    // All of these queue into the same coalesced batch RPC.
    await Promise.allSettled(uncached.map(id => this.getSupporterBadge(id)))
  }

  /**
   * Records a donation and snaps the user's supporter tier to the new
   * cumulative cycle total. Cumulative (rather than single-amount) semantics
   * let small recurring donations unlock tiers; a total below the lowest tier
   * leaves tier_id NULL and no badge displays.
   * See migration 20260524_cumulative_tier_and_notifications.
   */
  async addDonation(
    supporterId: string,
    userId: string,
    amount: number,
    currency = 'USD',
    platform?: string,
    note?: string,
    externalReference?: string
  ): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('instance_donation_history')
        .insert({
          supporter_id: supporterId,
          user_id: userId,
          amount,
          currency,
          platform: platform || null,
          note: note || null,
          external_reference: externalReference || null,
        })

      if (error) throw error

      // Recompute tier from cumulative cycle total. Fire-and-log: on failure
      // the donation row is already recorded and the next call resyncs.
      const { error: rpcErr } = await supabase.rpc('recompute_supporter_tier', { p_user_id: userId })
      if (rpcErr) debug.warn('addDonation: tier recompute failed:', rpcErr)
      badgeCache.delete(userId)

      return true
    } catch (error) {
      debug.error('Failed to add donation:', error)
      return false
    }
  }

  /**
   * Recomputes a user's supporter tier from their cumulative cycle total.
   * Public wrapper around the SQL helper; call after manually editing or
   * deleting donations to keep the badge consistent.
   */
  async recomputeSupporterTier(userId: string): Promise<string | null> {
    try {
      const { data, error } = await supabase.rpc('recompute_supporter_tier', { p_user_id: userId })
      if (error) throw error
      badgeCache.delete(userId)
      return (data as string | null) ?? null
    } catch (error) {
      debug.error('Failed to recompute supporter tier:', error)
      return null
    }
  }

  /** Sets the given fields of a supporter row; absent fields keep their value. Instance admins only. */
  async updateSupporter(
    userId: string,
    updates: { tier_id?: string | null; amount?: number | null; platform?: string | null; is_active?: boolean },
  ): Promise<boolean> {
    try {
      const { data, error } = await supabase.rpc('admin_update_supporter', {
        p_user_id: userId,
        p_changes: updates,
      })
      if (error) throw error
      badgeCache.delete(userId)
      return data === true
    } catch (error) {
      debug.error('Failed to update supporter:', error)
      return false
    }
  }

  async updateDonation(donationId: string, updates: { amount?: number; currency?: string; platform?: string | null; note?: string | null; donated_at?: string }): Promise<boolean> {
    try {
      // Snapshot the affected user_id before the edit; the tier recompute needs it.
      const { data: existing } = await supabase
        .from('instance_donation_history')
        .select('user_id')
        .eq('id', donationId)
        .maybeSingle()

      const { error } = await supabase
        .from('instance_donation_history')
        .update(updates)
        .eq('id', donationId)

      if (error) throw error

      if (existing?.user_id) {
        const { error: rpcErr } = await supabase.rpc('recompute_supporter_tier', { p_user_id: existing.user_id })
        if (rpcErr) debug.warn('updateDonation: tier recompute failed:', rpcErr)
        badgeCache.delete(existing.user_id)
      }

      return true
    } catch (error) {
      debug.error('Failed to update donation:', error)
      return false
    }
  }

  async deleteDonation(donationId: string): Promise<boolean> {
    try {
      const { data: existing } = await supabase
        .from('instance_donation_history')
        .select('user_id')
        .eq('id', donationId)
        .maybeSingle()

      const { error } = await supabase
        .from('instance_donation_history')
        .delete()
        .eq('id', donationId)

      if (error) throw error

      if (existing?.user_id) {
        const { error: rpcErr } = await supabase.rpc('recompute_supporter_tier', { p_user_id: existing.user_id })
        if (rpcErr) debug.warn('deleteDonation: tier recompute failed:', rpcErr)
        badgeCache.delete(existing.user_id)
      }

      return true
    } catch (error) {
      debug.error('Failed to delete donation:', error)
      return false
    }
  }

  async getDonationHistory(userId?: string): Promise<DonationRecord[]> {
    try {
      let query = supabase
        .from('instance_donation_history')
        .select(`
          *,
          user:profiles!user_id(username, display_name, avatar_url)
        `)
        .order('donated_at', { ascending: false })

      if (userId) {
        query = query.eq('user_id', userId)
      }

      const { data, error } = await query
      if (error) throw error
      return data || []
    } catch (error) {
      debug.error('Failed to get donation history:', error)
      return []
    }
  }

  // Pending donations (webhook integrations)

  /** Lists pending donations awaiting admin resolution. */
  async getPendingDonations(includeResolved = false): Promise<PendingDonation[]> {
    try {
      let query = supabase
        .from('instance_pending_donations')
        .select('*')
        .order('received_at', { ascending: false })

      if (!includeResolved) {
        query = query.is('resolved_at', null)
      }

      const { data, error } = await query
      if (error) throw error
      return (data || []) as PendingDonation[]
    } catch (error) {
      debug.error('Failed to get pending donations:', error)
      return []
    }
  }

  /**
   * Attributes a pending donation to a user in one transaction: supporter row, donation_history
   * row (skipped when the webhook already recorded it), the pending row resolved, then the tier
   * recomputed from the cumulative cycle total. A row already resolved is left as it is.
   * Instance admins only.
   *
   * `tierId` is ignored; the cumulative recompute decides the tier.
   */
  async resolvePendingDonation(pendingId: string, userId: string, _tierId?: string | null): Promise<boolean> {
    try {
      const { error } = await supabase.rpc('admin_resolve_pending_donation', {
        p_pending_id: pendingId,
        p_user_id: userId,
      })
      if (error) throw error
      badgeCache.delete(userId)
      return true
    } catch (error) {
      debug.error('Failed to resolve pending donation:', error)
      return false
    }
  }

  /** Dismisses a pending donation without attributing it (still marks resolved). */
  async dismissPendingDonation(pendingId: string): Promise<boolean> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { error } = await supabase
        .from('instance_pending_donations')
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by: user?.id ?? null,
        })
        .eq('id', pendingId)
      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to dismiss pending donation:', error)
      return false
    }
  }

  async getPendingDonationCount(): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('instance_pending_donations')
        .select('id', { count: 'exact', head: true })
        .is('resolved_at', null)
      if (error) throw error
      return count ?? 0
    } catch (error) {
      debug.error('Failed to count pending donations:', error)
      return 0
    }
  }

  async getDonationStats(): Promise<{
    totalDonated: number
    donationCount: number
    uniqueDonors: number
  }> {
    try {
      const { data, error } = await supabase
        .from('instance_donation_history')
        .select('amount, user_id')

      if (error) throw error

      const records = data || []
      const uniqueDonors = new Set(records.map(r => r.user_id)).size
      const totalDonated = records.reduce((sum, r) => sum + (r.amount || 0), 0)

      return {
        totalDonated,
        donationCount: records.length,
        uniqueDonors,
      }
    } catch (error) {
      debug.error('Failed to get donation stats:', error)
      return { totalDonated: 0, donationCount: 0, uniqueDonors: 0 }
    }
  }
}

export const fundingService = new FundingService()
