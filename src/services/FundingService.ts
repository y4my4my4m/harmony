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
}

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

const BADGE_CACHE_TTL = 5 * 60 * 1000 // 5 minutes
const badgeCache = new Map<string, { badge: SupporterBadge | null; fetchedAt: number }>()

// Dedup in-flight badge requests so concurrent calls for the same user share one RPC
const pendingBadgeRequests = new Map<string, Promise<SupporterBadge | null>>()

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

    const request = (async () => {
      try {
        const { data, error } = await supabase.rpc('get_supporter_badge', {
          p_user_id: userId
        })

        if (error) throw error
        const badge = data?.[0] || null
        badgeCache.set(userId, { badge, fetchedAt: Date.now() })
        return badge
      } catch (error) {
        debug.error('Failed to get supporter badge:', error)
        return null
      } finally {
        pendingBadgeRequests.delete(userId)
      }
    })()

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

    // Fire all uncached requests in parallel (dedup handles concurrent calls)
    await Promise.allSettled(uncached.map(id => this.getSupporterBadge(id)))
  }

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
      return true
    } catch (error) {
      debug.error('Failed to add donation:', error)
      return false
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
      const { error } = await supabase
        .from('instance_donation_history')
        .update(updates)
        .eq('id', donationId)

      if (error) throw error
      return true
    } catch (error) {
      debug.error('Failed to update donation:', error)
      return false
    }
  }

  async deleteDonation(donationId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('instance_donation_history')
        .delete()
        .eq('id', donationId)

      if (error) throw error
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
