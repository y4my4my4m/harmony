#!/usr/bin/env tsx
/**
 * Backfill RSA keys for existing local users
 * Run this once to generate keys for users created before the federation-backend
 */

import { getSupabaseClient } from './src/config/supabase.js';
import crypto from 'crypto';

function generateRsaKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  return { privateKey, publicKey };
}

async function backfillKeys() {
  const supabase = getSupabaseClient();

  // Get all local users without public keys
  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, username, domain')
    .eq('is_local', true)
    .is('public_key', null);

  if (error) {
    console.error('❌ Failed to fetch users:', error);
    process.exit(1);
  }

  if (!users || users.length === 0) {
    console.log('✅ No users need key generation');
    process.exit(0);
  }

  console.log(`🔐 Generating keys for ${users.length} users...`);

  let successCount = 0;
  let failCount = 0;

  for (const user of users) {
    try {
      console.log(`  Generating for: ${user.username}...`);
      
      const { privateKey, publicKey } = generateRsaKeypair();

      // Store private key - CHECK FOR ERRORS!
      const { error: privateKeyError } = await supabase
        .from('user_private_keys')
        .upsert({
          user_id: user.id,
          private_key: privateKey,
          created_at: new Date().toISOString()
        });

      if (privateKeyError) {
        console.error(`  ❌ Failed to store private key for ${user.username}:`, privateKeyError);
        failCount++;
        continue; // DON'T update public key if private key failed!
      }

      // Update profile with public key - only if private key succeeded
      const { error: publicKeyError } = await supabase
        .from('profiles')
        .update({ public_key: publicKey })
        .eq('id', user.id);

      if (publicKeyError) {
        console.error(`  ❌ Failed to store public key for ${user.username}:`, publicKeyError);
        // Try to clean up the orphaned private key
        await supabase
          .from('user_private_keys')
          .delete()
          .eq('user_id', user.id);
        failCount++;
        continue;
      }

      console.log(`  ✅ ${user.username}`);
      successCount++;
    } catch (err) {
      console.error(`  ❌ Failed for ${user.username}:`, err);
      failCount++;
    }
  }

  console.log(`\n📊 Results: ${successCount} succeeded, ${failCount} failed`);
  

  console.log('🎉 Backfill complete!');
  process.exit(0);
}

backfillKeys();

