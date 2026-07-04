/**
 * BlockedInstancesCache - In-memory cache for blocked instances
 * 
 * Loads blocked domains at startup and keeps them in a Set for O(1) lookups.
 * Refreshes periodically to catch admin changes.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

class BlockedInstancesCacheService {
  private blockedDomains: Set<string> = new Set();
  private lastRefresh: Date | null = null;
  private refreshIntervalId: ReturnType<typeof setInterval> | null = null;
  
  private readonly REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  /**
   * Initialize cache - call at startup
   */
  async initialize(): Promise<void> {
    await this.refresh();
    
    this.refreshIntervalId = setInterval(async () => {
      try {
        await this.refresh();
      } catch (error) {
        logger.error('Failed to refresh blocked instances cache:', error);
      }
    }, this.REFRESH_INTERVAL_MS);
    
    logger.info(`🚫 Blocked instances cache initialized (${this.blockedDomains.size} domains, refreshes every 5 min)`);
  }

  /**
   * Refresh the cache from database
   */
  async refresh(): Promise<void> {
    const supabase = getSupabaseClient();
    
    const { data, error } = await supabase
      .from('federated_instances')
      .select('domain')
      .eq('is_blocked', true);
    
    if (error) {
      logger.error('Failed to fetch blocked instances:', error);
      return;
    }
    
    const newBlockedDomains = new Set<string>(data?.map(s => s.domain) || []);
    
    const added = [...newBlockedDomains].filter(d => !this.blockedDomains.has(d));
    const removed = [...this.blockedDomains].filter(d => !newBlockedDomains.has(d));
    
    if (added.length > 0) {
      logger.info(`🚫 Newly blocked instances: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      logger.info(`✅ Unblocked instances: ${removed.join(', ')}`);
    }
    
    this.blockedDomains = newBlockedDomains;
    this.lastRefresh = new Date();
  }

  /**
   * Check if a domain is blocked - O(1) lookup
   */
  isBlocked(domain: string): boolean {
    return this.blockedDomains.has(domain.toLowerCase());
  }

  /**
   * Manually add a blocked domain (for immediate updates)
   */
  addBlocked(domain: string): void {
    this.blockedDomains.add(domain.toLowerCase());
    logger.info(`🚫 Added to block cache: ${domain}`);
  }

  /**
   * Manually remove a blocked domain (for immediate updates)
   */
  removeBlocked(domain: string): void {
    this.blockedDomains.delete(domain.toLowerCase());
    logger.info(`✅ Removed from block cache: ${domain}`);
  }

  /**
   * Get all blocked domains (for debugging)
   */
  getBlockedDomains(): string[] {
    return [...this.blockedDomains];
  }

  /**
   * Get cache stats
   */
  getStats(): { count: number; lastRefresh: Date | null } {
    return {
      count: this.blockedDomains.size,
      lastRefresh: this.lastRefresh,
    };
  }

  /**
   * Stop the refresh interval
   */
  stop(): void {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }
  }
}

export const BlockedInstancesCache = new BlockedInstancesCacheService();

