import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export interface FundingConfig {
  id: string
  enabled: boolean
  goal_amount: number | null
  goal_currency: string
  current_amount: number
  goal_description: string | null
  funding_links: FundingLink[]
  show_progress_bar: boolean
  thank_you_message: string | null
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

  async updateFundingConfig(config: Partial<FundingConfig>): Promise<boolean> {
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
      return true
    } catch (error) {
      debug.error('Failed to remove supporter:', error)
      return false
    }
  }

  async getSupporterBadge(userId: string): Promise<SupporterBadge | null> {
    try {
      const { data, error } = await supabase.rpc('get_supporter_badge', {
        p_user_id: userId
      })

      if (error) throw error
      return data?.[0] || null
    } catch (error) {
      debug.error('Failed to get supporter badge:', error)
      return null
    }
  }
}

export const fundingService = new FundingService()
