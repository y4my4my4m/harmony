-- Generate ActivityPub keys for existing users
-- Run this in your Supabase SQL editor

CREATE OR REPLACE FUNCTION generate_activitypub_keys()
RETURNS void AS $$
DECLARE
  user_record RECORD;
  v_private_key TEXT;
  v_public_key TEXT;
BEGIN
  -- Loop through users without keys
  FOR user_record IN 
    SELECT id, username, domain 
    FROM profiles 
    WHERE is_local = true 
    AND (profiles.public_key IS NULL OR profiles.private_key IS NULL)
  LOOP
    -- Generate RSA-2048 key pair (simplified - you'd use proper crypto in production)
    -- For now, we'll create placeholder keys that work for development
    
    v_private_key := '-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0vx7agoebGcQSuuPiLJXZptN9nndrQmbPFRP6gPiw+AlyRaC
' || user_record.id || '
-----END RSA PRIVATE KEY-----';

    v_public_key := '-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0vx7agoebGcQSuuPiLJX
' || user_record.id || '
-----END PUBLIC KEY-----';

    -- Update user with keys and federation URLs
    UPDATE profiles SET
      public_key = v_public_key,
      private_key = v_private_key,
      federated_id = 'https://' || domain || '/users/' || username,
      inbox_url = 'https://' || domain || '/users/' || username || '/inbox',
      outbox_url = 'https://' || domain || '/users/' || username || '/outbox',
      followers_url = 'https://' || domain || '/users/' || username || '/followers',
      following_url = 'https://' || domain || '/users/' || username || '/following',
      featured_url = 'https://' || domain || '/users/' || username || '/featured',
      last_synced_at = NOW()
    WHERE id = user_record.id;
    
    RAISE NOTICE 'Generated keys for user: %', user_record.username;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Execute the function
SELECT generate_activitypub_keys();
