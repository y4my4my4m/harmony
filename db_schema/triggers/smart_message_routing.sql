-- ============================================
-- SMART MESSAGE ROUTING TRIGGERS
-- Local-first optimization for federated servers
-- ============================================

-- Route channel messages efficiently:
-- - Local members get it via Supabase real-time (INSTANT!)
-- - Remote members get it via federation (slower but works)

-- ============================================
-- FUNCTION: Route channel message
-- ============================================

CREATE OR REPLACE FUNCTION route_channel_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_server_id UUID;
  v_has_remote_members BOOLEAN;
  v_channel_name TEXT;
BEGIN
  -- Only process server channel messages (not DMs)
  IF NEW.channel_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get server from channel
  SELECT c.server_id, c.name
  INTO v_server_id, v_channel_name
  FROM channels c
  WHERE c.id = NEW.channel_id;

  IF v_server_id IS NULL THEN
    -- Not a server channel, skip
    RETURN NEW;
  END IF;

  -- Check if server has remote members
  v_has_remote_members := server_has_remote_members(v_server_id);

  -- If has remote members, notify federation backend
  IF v_has_remote_members THEN
    PERFORM pg_notify('channel_message_federate', 
      json_build_object(
        'message_id', NEW.id,
        'channel_id', NEW.channel_id,
        'server_id', v_server_id,
        'channel_name', v_channel_name,
        'author_id', NEW.user_id
      )::text
    );
    
    RAISE DEBUG 'Message % queued for federation (server % has remote members)', 
      NEW.id, v_server_id;
  ELSE
    RAISE DEBUG 'Message % is local-only (server % has no remote members)', 
      NEW.id, v_server_id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION route_channel_message IS
'Smart routing: Notify federation backend only if server has remote members';

-- ============================================
-- TRIGGER: Smart route channel messages
-- ============================================

DROP TRIGGER IF EXISTS smart_route_channel_message ON messages;

CREATE TRIGGER smart_route_channel_message
AFTER INSERT ON messages
FOR EACH ROW
WHEN (NEW.channel_id IS NOT NULL)  -- Server channel message
EXECUTE FUNCTION route_channel_message();

COMMENT ON TRIGGER smart_route_channel_message ON messages IS
'Routes channel messages: local members via real-time, remote members via federation';

-- ============================================
-- FUNCTION: Route server membership events
-- ============================================

CREATE OR REPLACE FUNCTION route_server_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_server RECORD;
  v_user RECORD;
  v_is_remote_user BOOLEAN;
  v_is_remote_server BOOLEAN;
BEGIN
  -- Get server info
  SELECT * INTO v_server
  FROM servers
  WHERE id = NEW.server_id;

  -- Get user info
  SELECT * INTO v_user
  FROM profiles
  WHERE id = NEW.user_id;

  v_is_remote_user := (v_user.is_local = false);
  v_is_remote_server := (v_server.is_local_server = false);

  -- Case 1: Local user joining remote server
  IF NOT v_is_remote_user AND v_is_remote_server THEN
    PERFORM pg_notify('user_join_remote_server',
      json_build_object(
        'user_id', NEW.user_id,
        'server_id', NEW.server_id,
        'server_ap_id', v_server.ap_id,
        'server_inbox', v_server.federation_inbox_url
      )::text
    );
    RAISE NOTICE 'Local user % joining remote server %', v_user.username, v_server.name;
  END IF;

  -- Case 2: Remote user joining local server (handled by inbox)
  -- No notification needed here, inbox handler adds membership

  -- Case 3: Membership status change (pending → accepted)
  IF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
    IF NEW.status = 'accepted' THEN
      -- Member is now active, might need to notify
      PERFORM pg_notify('member_accepted',
        json_build_object(
          'user_id', NEW.user_id,
          'server_id', NEW.server_id
        )::text
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION route_server_membership IS
'Handle federation for server membership changes (joins/leaves)';

-- ============================================
-- TRIGGER: Route membership events
-- ============================================

DROP TRIGGER IF EXISTS route_membership_federation ON user_servers;

CREATE TRIGGER route_membership_federation
AFTER INSERT OR UPDATE ON user_servers
FOR EACH ROW
EXECUTE FUNCTION route_server_membership();

COMMENT ON TRIGGER route_membership_federation ON user_servers IS
'Routes membership events to federation backend when needed';

-- ============================================
-- FUNCTION: Route server leave events
-- ============================================

CREATE OR REPLACE FUNCTION route_server_leave()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_server RECORD;
  v_user RECORD;
BEGIN
  -- Get server info
  SELECT * INTO v_server
  FROM servers
  WHERE id = OLD.server_id;

  -- Get user info
  SELECT * INTO v_user
  FROM profiles
  WHERE id = OLD.user_id;

  -- If remote server, notify federation backend to send Leave activity
  IF v_server.is_local_server = false THEN
    PERFORM pg_notify('user_leave_remote_server',
      json_build_object(
        'user_id', OLD.user_id,
        'server_id', OLD.server_id,
        'server_ap_id', v_server.ap_id,
        'server_inbox', v_server.federation_inbox_url
      )::text
    );
  END IF;

  -- If local server with remote user, broadcast Leave to other instances
  IF v_server.is_local_server = true AND v_user.is_local = false THEN
    PERFORM pg_notify('remote_user_left_server',
      json_build_object(
        'user_id', OLD.user_id,
        'user_ap_id', v_user.ap_id,
        'server_id', OLD.server_id
      )::text
    );
  END IF;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION route_server_leave IS
'Handle federation for server leave events';

-- ============================================
-- TRIGGER: Route leave events
-- ============================================

DROP TRIGGER IF EXISTS route_leave_federation ON user_servers;

CREATE TRIGGER route_leave_federation
AFTER DELETE ON user_servers
FOR EACH ROW
EXECUTE FUNCTION route_server_leave();

COMMENT ON TRIGGER route_leave_federation ON user_servers IS
'Routes leave events to federation backend';

-- ============================================
-- VERIFICATION
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ Smart message routing triggers installed';
  RAISE NOTICE '   - route_channel_message: Routes messages to federation if needed';
  RAISE NOTICE '   - route_server_membership: Handles join events';
  RAISE NOTICE '   - route_server_leave: Handles leave events';
  RAISE NOTICE '';
  RAISE NOTICE '🎯 Optimization: Local members get instant delivery via Supabase real-time';
  RAISE NOTICE '   Remote members get federation delivery (batched by instance)';
END $$;

