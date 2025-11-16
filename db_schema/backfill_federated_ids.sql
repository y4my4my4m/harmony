-- Temporary: Backfill federated_id for existing local users that don't have it
UPDATE profiles
SET 
  federated_id = 'https://' || domain || '/users/' || username,
  inbox_url = 'https://' || domain || '/users/' || username || '/inbox',
  outbox_url = 'https://' || domain || '/users/' || username || '/outbox',
  followers_url = 'https://' || domain || '/users/' || username || '/followers',
  following_url = 'https://' || domain || '/users/' || username || '/following'
WHERE is_local = true 
  AND federated_id IS NULL
  AND domain IS NOT NULL
  AND username IS NOT NULL;

-- Show what was updated
SELECT 
  id, 
  username, 
  domain,
  federated_id,
  is_local
FROM profiles 
WHERE is_local = true
ORDER BY created_at DESC
LIMIT 10;

