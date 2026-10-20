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
    
    logger.info(`Blocked instances cache initialized (${this.blockedDomains.size} domains, refreshes every 5 min)`);
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
    
    // isBlocked compares lowercased hostnames.
    const newBlockedDomains = new Set<string>(
      (data || []).map(s => String(s.domain ?? '').toLowerCase()).filter(Boolean),
    );
    
    const added = [...newBlockedDomains].filter(d => !this.blockedDomains.has(d));
    const removed = [...this.blockedDomains].filter(d => !newBlockedDomains.has(d));
    
    if (added.length > 0) {
      logger.info(`Newly blocked instances: ${added.join(', ')}`);
    }
    if (removed.length > 0) {
      logger.info(`Unblocked instances: ${removed.join(', ')}`);
    }
    
    this.blockedDomains = newBlockedDomains;
    this.lastRefresh = new Date();
  }

  /**
   * A block covers the domain and every subdomain of it, as Mastodon's
   * DomainBlock.rule_for matches a.example.com against a block of example.com.
   * A trailing root dot is ignored.
   */
  isBlocked(domain: string): boolean {
    let host = domain.toLowerCase().replace(/\.$/, '');
    if (this.blockedDomains.size === 0 || !host) return false;
    for (;;) {
      if (this.blockedDomains.has(host)) return true;
      const dot = host.indexOf('.');
      if (dot < 0) return false;
      host = host.slice(dot + 1);
    }
  }

  /**
   * Manually add a blocked domain (for immediate updates)
   */
  addBlocked(domain: string): void {
    this.blockedDomains.add(domain.toLowerCase());
    logger.info(`Added to block cache: ${domain}`);
  }

  /**
   * Manually remove a blocked domain (for immediate updates)
   */
  removeBlocked(domain: string): void {
    this.blockedDomains.delete(domain.toLowerCase());
    logger.info(`Removed from block cache: ${domain}`);
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

