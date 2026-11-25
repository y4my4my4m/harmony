import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { AuthProviderConfigWriter, redirectUriFor, type ProviderRow } from './AuthProviderConfigWriter.js';

/** The writer of HARMONY_AUTH_CONFIG_DIR; null when the setting is absent. */
export function createAuthProviderConfigWriter(intervalMs?: number): AuthProviderConfigWriter | null {
  const dir = config.HARMONY_AUTH_CONFIG_DIR;
  if (!dir) return null;
  const supabase = getSupabaseClient();
  return new AuthProviderConfigWriter({
    dir,
    redirectUri: redirectUriFor(config.PUBLIC_SUPABASE_URL),
    intervalMs,
    async render() {
      const { data, error } = await supabase.rpc('auth_provider_credentials_render');
      if (error) throw new Error(`auth_provider_credentials_render: ${error.message}`);
      return (data ?? []) as ProviderRow[];
    },
    async report(applied, problem) {
      const { error } = await supabase.rpc('auth_provider_writer_report', { p_applied: applied, p_error: problem });
      if (error) throw new Error(error.message);
    },
    log: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
  });
}
