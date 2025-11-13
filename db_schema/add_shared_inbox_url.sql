-- Add shared_inbox_url column to profiles table
-- This is used for efficient ActivityPub delivery - one message per server instead of per user

-- Add the column if it doesn't exist
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS shared_inbox_url TEXT;

-- Add comment to explain purpose
COMMENT ON COLUMN profiles.shared_inbox_url IS 
'ActivityPub shared inbox URL for this user''s instance. Used for efficient delivery - send one copy to shared inbox instead of individual inboxes.';

-- Create index for faster lookups when grouping by shared inbox
CREATE INDEX IF NOT EXISTS idx_profiles_shared_inbox_url 
ON profiles(shared_inbox_url) 
WHERE shared_inbox_url IS NOT NULL;

-- Show results
SELECT 
  'Added shared_inbox_url column' as action,
  COUNT(*) FILTER (WHERE shared_inbox_url IS NULL AND is_local = false) as remote_users_need_refresh
FROM profiles;

