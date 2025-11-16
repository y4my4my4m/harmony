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

  for (const user of users) {
    try {
      console.log(`  Generating for: ${user.username}...`);
      
      const { privateKey, publicKey } = generateRsaKeypair();

      // Store private key
      await supabase
        .from('user_private_keys')
        .upsert({
          user_id: user.id,
          private_key: privateKey,
          created_at: new Date().toISOString()
        });

      // Update profile with public key
      await supabase
        .from('profiles')
        .update({ public_key: publicKey })
        .eq('id', user.id);

      console.log(`  ✅ ${user.username}`);
    } catch (err) {
      console.error(`  ❌ Failed for ${user.username}:`, err);
    }
  }

  console.log('🎉 Backfill complete!');
  process.exit(0);
}

backfillKeys();

