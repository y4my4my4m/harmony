import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

/**
 * Tracks live federation contact with remote instances.
 */
export class FederatedInstanceService {
  static touchFromUrl(url: string): void {
    try {
      FederatedInstanceService.touchDomain(new URL(url).hostname);
    } catch {
      // Ignore malformed URLs
    }
  }

  static touchDomain(input: string): void {
    let normalized: string;

    try {
      normalized = input.includes('://')
        ? new URL(input).hostname
        : input.split('/')[0];
    } catch {
      return;
    }

    normalized = normalized.trim().toLowerCase().replace(/\.$/, '');

    if (!normalized || normalized === config.INSTANCE_DOMAIN.toLowerCase()) {
      return;
    }

    void FederatedInstanceService.touchDomainAsync(normalized);
  }

  private static async touchDomainAsync(domain: string): Promise<void> {
    try {
      const supabase = getSupabaseClient();
      const { error } = await supabase.rpc('touch_federated_instance', {
        p_domain: domain,
      });
      if (error) {
        logger.debug(`touch_federated_instance failed for ${domain}:`, error.message);
      }
    } catch (err) {
      logger.debug(`touch_federated_instance error for ${domain}:`, err);
    }
  }
}
