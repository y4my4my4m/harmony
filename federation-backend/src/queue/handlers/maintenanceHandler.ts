/**
 * Maintenance Handler - Periodic cleanup and verification jobs
 * 
 * This handler runs scheduled maintenance tasks like:
 * - Generating missing keys for local users
 * - Cleaning up orphaned data
 * - Verifying federation health
 */

import { logger } from '../../utils/logger.js';
import { getSupabaseClient } from '../../config/supabase.js';
import { SignatureService } from '../../activitypub/SignatureService.js';

export interface MaintenanceJobData {
  task: 'keygen-sweep' | 'cleanup-orphans' | 'verify-federation';
  triggered_by?: string;
}

/**
 * Handle maintenance jobs
 */
export async function handleMaintenanceJob(data: MaintenanceJobData): Promise<void> {
  logger.info(`🔧 Running maintenance task: ${data.task}`);

  switch (data.task) {
    case 'keygen-sweep':
      await sweepMissingKeys();
      break;
    case 'cleanup-orphans':
      await cleanupOrphanedKeys();
      break;
    case 'verify-federation':
      await verifyFederationHealth();
      break;
    default:
      logger.warn(`Unknown maintenance task: ${data.task}`);
  }
}

/**
 * Sweep for local users missing keys and generate them
 * 
 * This catches any edge cases where:
 * - Users were created before key generation was implemented
 * - Key generation failed during profile creation
 * - Keys were somehow lost/corrupted
 */
async function sweepMissingKeys(): Promise<void> {
  const supabase = getSupabaseClient();

  const { data: usersWithoutKeys, error: queryError } = await supabase
    .from('profiles')
    .select('id, username, domain')
    .eq('is_local', true)
    .is('public_key', null)
    .limit(50); // Process in batches

  if (queryError) {
    logger.error('❌ Failed to query users without keys:', queryError);
    return;
  }

  if (!usersWithoutKeys || usersWithoutKeys.length === 0) {
    logger.info('✅ All local users have public keys');
    return;
  }

  logger.info(`🔐 Found ${usersWithoutKeys.length} local users without keys`);

  let successCount = 0;
  let failCount = 0;

  for (const user of usersWithoutKeys) {
    try {
      logger.info(`  🔑 Generating keys for: ${user.username}@${user.domain}`);

      const keys = await SignatureService.generateKeyPair();

      // Store private key first
      const { error: privateKeyError } = await supabase
        .from('user_private_keys')
        .upsert({
          user_id: user.id,
          private_key: keys.privateKey,
        });

      if (privateKeyError) {
        logger.error(`  ❌ Failed to store private key for ${user.username}:`, privateKeyError);
        failCount++;
        continue;
      }

      const { error: publicKeyError } = await supabase
        .from('profiles')
        .update({ public_key: keys.publicKey })
        .eq('id', user.id);

      if (publicKeyError) {
        await supabase
          .from('user_private_keys')
          .delete()
          .eq('user_id', user.id);

        logger.error(`  ❌ Failed to store public key for ${user.username}:`, publicKeyError);
        failCount++;
        continue;
      }

      logger.info(`  ✅ ${user.username}@${user.domain}`);
      successCount++;
    } catch (err) {
      logger.error(`  ❌ Failed for ${user.username}:`, err);
      failCount++;
    }
  }

  logger.info(`🔐 Key generation sweep complete: ${successCount} succeeded, ${failCount} failed`);
}

/**
 * Clean up orphaned keys (public key without private key, or vice versa)
 */
async function cleanupOrphanedKeys(): Promise<void> {
  const supabase = getSupabaseClient();

  const { data: inconsistentUsers, error: queryError } = await supabase.rpc('check_key_consistency');

  if (queryError) {
    logger.error('❌ Failed to check key consistency:', queryError);
    return;
  }

  if (!inconsistentUsers || inconsistentUsers.length === 0) {
    logger.info('✅ All local users have consistent key state');
    return;
  }

  logger.info(`🔧 Found ${inconsistentUsers.length} users with inconsistent keys`);

  for (const user of inconsistentUsers) {
    try {
      if (user.has_public_key && !user.has_private_key) {
        // Has public key but no private key - clear public key so it can be regenerated
        logger.info(`  🧹 Clearing orphaned public key for: ${user.username}`);
        
        const { error: clearError } = await supabase
          .from('profiles')
          .update({ public_key: null })
          .eq('id', user.user_id);

        if (clearError) {
          logger.error(`  ❌ Failed to clear public key for ${user.username}:`, clearError);
        } else {
          logger.info(`  ✅ Cleared orphaned public key for ${user.username}`);
        }
      } else if (!user.has_public_key && user.has_private_key) {
        // Has private key but no public key - regenerate both
        logger.info(`  🔑 Regenerating keys for: ${user.username} (had orphaned private key)`);
        
        // Delete the orphaned private key first
        await supabase
          .from('user_private_keys')
          .delete()
          .eq('user_id', user.user_id);

        const keys = await SignatureService.generateKeyPair();

        const { error: privateKeyError } = await supabase
          .from('user_private_keys')
          .insert({
            user_id: user.user_id,
            private_key: keys.privateKey,
          });

        if (privateKeyError) {
          logger.error(`  ❌ Failed to store new private key for ${user.username}:`, privateKeyError);
          continue;
        }

        const { error: publicKeyError } = await supabase
          .from('profiles')
          .update({ public_key: keys.publicKey })
          .eq('id', user.user_id);

        if (publicKeyError) {
          await supabase
            .from('user_private_keys')
            .delete()
            .eq('user_id', user.user_id);
          logger.error(`  ❌ Failed to store new public key for ${user.username}:`, publicKeyError);
          continue;
        }

        logger.info(`  ✅ Regenerated keys for ${user.username}`);
      }
    } catch (err) {
      logger.error(`  ❌ Failed cleanup for ${user.username}:`, err);
    }
  }

  logger.info('🧹 Orphaned key cleanup complete');
}

/**
 * Verify federation health (placeholder for future implementation)
 */
async function verifyFederationHealth(): Promise<void> {
  logger.info('📊 Federation health check - not yet implemented');
  // Future: Check inbox delivery success rates, remote actor availability, etc.
}

