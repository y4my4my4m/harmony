import { supabase } from '@/supabase'
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
  /** Verification token from Ko-fi (Gold-tier required). Empty/null = disabled. */
  kofi_webhook_token: string | null
  /** When true, auto-assign supporter tier on webhook based on amount. */
  kofi_auto_assign_tier: boolean
}

/** Canonical platform keys we render with branded icons in the UI. */
export const FUNDING_PLATFORMS = [
  'ko-fi',
  'patreon',
  'github-sponsors',
  'liberapay',
  'open-collective',
  'paypal',
  'buymeacoffee',
  'custom',
] as const
export type FundingPlatformKey = typeof FUNDING_PLATFORMS[number]

/** Config with current_amount computed from donation history (for progress display) */
export interface FundingConfigWithProgress extends FundingConfig {
  displayed_amount: number
}

export interface FundingLink {
  platform: string
  url: string
  label: string
}

export interface SupporterTier {
  id: string
  name: string
  min_amount: number
  badge_icon: string | null
  badge_color: string | null
  perks: string | null
  display_order: number
}

export interface Supporter {
  id: string
  user_id: string
  tier_id: string | null
  amount: number | null
  started_at: string
  expires_at: string | null
  is_active: boolean
  platform: string | null
  tier?: SupporterTier
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

const BADGE_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const badgeCache = new Map<string, { badge: SupporterBadge | null; fetchedAt: number }>()

// Dedup in-flight badge requests so concurrent calls for the same user share one RPC
const pendingBadgeRequests = new Map<string, Promise<SupporterBadge | null>>()

// ---------------------------------------------------------------------------
// Coalescing batch loader (DataLoader-style).
//
// A chat view renders one <SupporterBadge> per message author, each calling
// getSupporterBadge() on mount within the same tick. Previously that produced
// one /rpc/get_supporter_badge POST per user (an N+1 storm). We now collect all
// userIds requested in the same microtask and resolve them with a single
// get_supporter_badges(uuid[]) round-trip.
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

// Normalize the supporter_membership shape returned by the PostgREST embed
// `author.supporter_membership[*]` into the same SupporterBadge shape that
// `getSupporterBadge` returns. Caller passes the raw embed array.
export function badgeFromMembership(
  membership: Array<{ is_active: boolean; tier: { name: string; badge_icon: string | null; badge_color: string | null } | null }> | null | undefined
): SupporterBadge | null {
  if (!membership || membership.length === 0) return null
  const active = membership.find(m => m?.is_active && m.tier)
  if (!active || !active.tier) return null
  return {
    tier_name: active.tier.name,
    badge_icon: active.tier.badge_icon,
    badge_color: active.tier.badge_color,
    is_active: true,
  }
}

// Cache pre-resolved badges so SupporterBadge can render instantly without
// hitting the RPC. Used by timeline loaders that already have the embed data.
export function primeBadgeCache(userId: string, badge: SupporterBadge | null): void {
  badgeCache.set(userId, { badge, fetchedAt: Date.now() })
}

class FundingService {
  async getFundingConfig(): Promise<FundingConfig | null> {
    try {
      const { data, error } = await supabase
        .from('instance_funding')
        .select('*')
        .limit(1)
        .maybeSingle()

      if (error) throw error
      return data
    } catch (error) {
      debug.error('Failed to get funding config:', error)
      return null
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

  async getSupporters(): Promise<Supporter[]> {
    try {
      const { data, error } = await supabase
        .from('instance_supporters')
        .select(`
          *,
          tier:instance_supporter_tiers(*),
          user:profiles(username, display_name, avatar_url)
        `)
        .eq('is_active', true)
        .order('started_at', { ascending: false })

      if (error) throw error
      return data || []
    } catch (error) {
      debug.error('Failed to get supporters:', error)
      return []
    }
  }

  async addSupporter(userId: string, tierId?: string, amount?: number, platform?: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('instance_supporters')
        .upsert({
          user_id: userId,
          tier_id: tierId || null,
          amount: amount || null,
          platform: platform || 'manual',
          is_active: true,
          started_at: new Date().toISOString()
        }, { onConflict: 'user_id' })

      if (error) throw error
      badgeCache.delete(userId)
      return true
    } catch (error) {
      debug.error('Failed to add supporter:', error)
      return false
    }
  }

  async removeSupporter(userId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('instance_supporters')
        .update({ is_active: false })
        .eq('user_id', userId)

      if (error) throw error
      badgeCache.delete(userId)
      return true
    } catch (error) {
      debug.error('Failed to remove supporter:', error)
      return false
    }
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

  /**
   * Batch-prefetch supporter badges for multiple users at once.
   * Fills the cache so individual SupporterBadge components hit cache instead of RPC.
   */
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
   * Records a donation and snaps the user's supporter tier to match their
   * new cumulative cycle total. The cumulative semantics (vs picking from
   * the single donation amount) means small recurring donations correctly
   * unlock tiers, and donations below any tier leave tier_id NULL so no
   * badge displays. See migration 20260524_cumulative_tier_and_notifications.
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

      // Recompute tier from cumulative cycle total. Fire-and-log: even if
      // this fails the donation row is already recorded, and the next call
      // will snap things back into sync.
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
   * Recompute a user's supporter tier from their cumulative cycle total.
   * Public wrapper around the SQL helper - handy after manually editing or
   * deleting donations so the badge stays consistent.
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

  async updateSupporter(userId: string, updates: { tier_id?: string | null; amount?: number | null; platform?: string | null }): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('instance_supporters')
        .update(updates)
        .eq('user_id', userId)

      if (error) throw error
      badgeCache.delete(userId)
      return true
    } catch (error) {
      debug.error('Failed to update supporter:', error)
      return false
    }
  }

  async updateDonation(donationId: string, updates: { amount?: number; currency?: string; platform?: string | null; note?: string | null; donated_at?: string }): Promise<boolean> {
    try {
      // Snapshot affected user_id first so we can recompute their tier after the edit.
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

  // -------------------------------------------------------------------------
  // Pending donations (webhook integrations)
  // -------------------------------------------------------------------------

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
   * Resolves a pending donation by attributing it to a user. Creates the
   * matching supporter + donation_history rows, then recomputes the user's
   * tier from their cumulative cycle total (so multiple small donations
   * correctly aggregate into a tier). Idempotent on retry via the
   * (platform, external_reference) unique index.
   *
   * The `tierId` parameter is ignored - the cumulative recompute is
   * authoritative. It's kept in the signature for API compatibility.
   */
  async resolvePendingDonation(pendingId: string, userId: string, _tierId?: string | null): Promise<boolean> {
    try {
      const { data: pending, error: fetchErr } = await supabase
        .from('instance_pending_donations')
        .select('*')
        .eq('id', pendingId)
        .maybeSingle()

      if (fetchErr) throw fetchErr
      if (!pending) {
        debug.warn('resolvePendingDonation: pending row not found', pendingId)
        return false
      }
      if (pending.resolved_at) {
        debug.warn('resolvePendingDonation: already resolved', pendingId)
        return true
      }

      const { data: supporter, error: upsertErr } = await supabase
        .from('instance_supporters')
        .upsert(
          {
            user_id: userId,
            // tier_id intentionally omitted: recompute_supporter_tier below
            // sets it from the cumulative cycle total.
            amount: pending.amount,
            platform: pending.platform,
            is_active: true,
            started_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' },
        )
        .select('id')
        .single()

      if (upsertErr || !supporter) throw upsertErr ?? new Error('Supporter upsert failed')

      const { error: histErr } = await supabase
        .from('instance_donation_history')
        .insert({
          supporter_id: supporter.id,
          user_id: userId,
          amount: pending.amount,
          currency: pending.currency,
          platform: pending.platform,
          external_reference: pending.external_reference,
          note: pending.donor_message,
        })
      // Tolerate duplicate-key - webhook may have already inserted via retry.
      if (histErr && histErr.code !== '23505') throw histErr

      const { data: { user } } = await supabase.auth.getUser()
      const { error: resolveErr } = await supabase
        .from('instance_pending_donations')
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by: user?.id ?? null,
          resolved_user_id: userId,
        })
        .eq('id', pendingId)

      if (resolveErr) throw resolveErr

      // Recompute tier from cumulative cycle total - this is what actually
      // assigns the badge. If amount < lowest tier, tier_id becomes NULL
      // and the user keeps a supporter row but no badge displays.
      const { error: rpcErr } = await supabase.rpc('recompute_supporter_tier', { p_user_id: userId })
      if (rpcErr) debug.warn('resolvePendingDonation: tier recompute failed:', rpcErr)

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
