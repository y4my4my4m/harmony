-- ============================================
-- SERVER & CHANNEL FEDERATION SCHEMA
-- ============================================

-- Add federation metadata to servers
-- Note: Some columns might already exist, using IF NOT EXISTS
ALTER TABLE servers ADD COLUMN IF NOT EXISTS ap_id TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS host_domain TEXT;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS is_local_server BOOLEAN DEFAULT true;

-- Update is_local_server for existing servers (they're all local if already created)
UPDATE servers SET is_local_server = true WHERE is_local_server IS NULL;

CREATE INDEX IF NOT EXISTS idx_servers_ap_id ON servers(ap_id) WHERE ap_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_servers_federation ON servers(federation_enabled, is_local_server);

COMMENT ON COLUMN servers.ap_id IS 'ActivityPub ID for this server (Group actor)';
COMMENT ON COLUMN servers.host_domain IS 'Domain where this server is hosted (null if local)';
COMMENT ON COLUMN servers.is_local_server IS 'True if server is hosted on this instance';

-- Add federation metadata to channels
ALTER TABLE channels ADD COLUMN IF NOT EXISTS ap_id TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_remote BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_channels_ap_id ON channels(ap_id) WHERE ap_id IS NOT NULL;

COMMENT ON COLUMN channels.ap_id IS 'ActivityPub context URL for this channel';
COMMENT ON COLUMN channels.is_remote IS 'True if this is a mirror of a remote channel';

-- Add member instance tracking
ALTER TABLE user_servers ADD COLUMN IF NOT EXISTS member_instance TEXT;

-- Update existing rows to set member_instance
UPDATE user_servers us
SET member_instance = p.domain
FROM profiles p
WHERE us.user_id = p.id
  AND us.member_instance IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_servers_by_instance 
  ON user_servers(server_id, member_instance);

COMMENT ON COLUMN user_servers.member_instance IS 'Instance domain of the member (for efficient batching)';

-- Add status to user_servers for pending joins
ALTER TABLE user_servers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'accepted';

-- Set existing rows to 'accepted' (they're already members)
UPDATE user_servers SET status = 'accepted' WHERE status IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_servers_status ON user_servers(server_id, status);

COMMENT ON COLUMN user_servers.status IS 'Membership status: pending, accepted, rejected';

-- ============================================
-- FUNCTION: Get server members grouped by instance
-- ============================================

CREATE OR REPLACE FUNCTION get_server_members_by_instance(p_server_id UUID)
RETURNS TABLE(
  instance TEXT,
  member_ids UUID[],
  member_ap_ids TEXT[],
  member_count INT
)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    COALESCE(p.domain, 'local') as instance,
    array_agg(p.id) as member_ids,
    array_agg(p.federated_id) as member_ap_ids,
    COUNT(*)::INT as member_count
  FROM user_servers us
  JOIN profiles p ON us.user_id = p.id
  WHERE us.server_id = p_server_id
  GROUP BY COALESCE(p.domain, 'local');
$$;

COMMENT ON FUNCTION get_server_members_by_instance IS
'Get server members grouped by instance domain for efficient batch delivery';

-- ============================================
-- FUNCTION: Check if server has remote members
-- ============================================

CREATE OR REPLACE FUNCTION server_has_remote_members(p_server_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS(
    SELECT 1 
    FROM user_servers us
    JOIN profiles p ON us.user_id = p.id
    WHERE us.server_id = p_server_id
      AND p.is_local = false
      AND us.status = 'accepted'
  );
$$;

COMMENT ON FUNCTION server_has_remote_members IS
'Check if server has any remote (federated) members';

-- ============================================
-- TRIGGER: Auto-set member_instance
-- ============================================

CREATE OR REPLACE FUNCTION set_member_instance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Auto-populate member_instance from user's domain
  SELECT domain INTO NEW.member_instance
  FROM profiles
  WHERE id = NEW.user_id;
  
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_set_member_instance ON user_servers;

CREATE TRIGGER auto_set_member_instance
BEFORE INSERT ON user_servers
FOR EACH ROW
EXECUTE FUNCTION set_member_instance();

COMMENT ON TRIGGER auto_set_member_instance ON user_servers IS
'Automatically set member_instance from user profile domain';

-- ============================================
-- SUMMARY
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ Server federation schema ready';
  RAISE NOTICE '   - Servers can be federated (ap_id, host_domain)';
  RAISE NOTICE '   - Channels can be remote mirrors (ap_id, is_remote)';
  RAISE NOTICE '   - Members tracked by instance (for efficient delivery)';
  RAISE NOTICE '   - Helper functions for instance grouping';
END $$;

