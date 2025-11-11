-- ============================================
-- RENAME federated_id TO ap_id
-- Standardizing column names across all tables
-- ============================================

-- This migration renames federated_id to ap_id for consistency
-- ActivityPub ID should be consistently named everywhere

BEGIN;

-- 1. profiles table
ALTER TABLE IF EXISTS profiles 
  RENAME COLUMN federated_id TO ap_id;

COMMENT ON COLUMN profiles.ap_id IS 'ActivityPub ID (actor URL)';

-- 2. posts table  
ALTER TABLE IF EXISTS posts
  RENAME COLUMN federated_id TO ap_id;

COMMENT ON COLUMN posts.ap_id IS 'ActivityPub ID (object URL)';

-- 3. messages table (if it has federated_id)
ALTER TABLE IF EXISTS messages
  RENAME COLUMN federated_id TO ap_id;

COMMENT ON COLUMN messages.ap_id IS 'ActivityPub ID (object URL for federated DMs)';

-- 4. Update indexes if they exist
DROP INDEX IF EXISTS idx_profiles_federated_id;
CREATE INDEX IF NOT EXISTS idx_profiles_ap_id ON profiles(ap_id) WHERE ap_id IS NOT NULL;

DROP INDEX IF EXISTS idx_posts_federated_id;
CREATE INDEX IF NOT EXISTS idx_posts_ap_id ON posts(ap_id) WHERE ap_id IS NOT NULL;

DROP INDEX IF EXISTS idx_messages_federated_id;
CREATE INDEX IF NOT EXISTS idx_messages_ap_id ON messages(ap_id) WHERE ap_id IS NOT NULL;

-- 5. Update any views that reference federated_id
-- (Add any views here if they exist)

COMMIT;

-- ============================================
-- VERIFICATION
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ Column rename complete: federated_id → ap_id';
  RAISE NOTICE '   - profiles.ap_id';
  RAISE NOTICE '   - posts.ap_id';
  RAISE NOTICE '   - messages.ap_id';
  RAISE NOTICE '';
  RAISE NOTICE '⚠️  Update your application code to use ap_id instead of federated_id';
END $$;

