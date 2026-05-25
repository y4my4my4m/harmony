BEGIN;

-- =============================================================================
-- Phase 2: Expand user:{id} broadcast channel
--
-- Adds three more event sources to the user:{id} broadcast channel,
-- eliminating the dedicated postgres_changes channels for:
--   - dm-conversations-{userId}  (conversation_participants INSERT)
--   - user-servers:{userId}      (user_servers INSERT/DELETE, servers UPDATE)
--
-- Combined with Phase 1, the user:{id} channel now carries:
--   notification:new, notification:update, unread:change,
--   conversation:new, server:joined, server:left, server:updated
--
-- Net result: -2 always-on channels per user.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. New DM conversation added for a user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_conversation_participant_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'conversation:new',
        'conversation_id', NEW.conversation_id,
        'user_id', NEW.user_id
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. User joined / left a server
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_user_server_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'server:joined',
        'server_id', NEW.server_id,
        'user_id', NEW.user_id
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'server:left',
        'server_id', OLD.server_id,
        'user_id', OLD.user_id
      ),
      'user_event',
      'user:' || OLD.user_id::text,
      true
    );
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Server metadata updated (name, icon, description, etc.)
--    Fans out to every member's user:{id} channel.
--    Server updates are rare so the fanout cost is acceptable.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_server_change_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_member_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR v_member_id IN
      SELECT user_id FROM user_servers WHERE server_id = NEW.id
    LOOP
      PERFORM realtime.send(
        jsonb_build_object(
          'type', 'server:updated',
          'server', jsonb_build_object(
            'id', NEW.id,
            'name', NEW.name,
            'description', NEW.description,
            'icon', NEW.icon,
            'banner', NEW.banner,
            'updated_at', NEW.updated_at
          )
        ),
        'user_event',
        'user:' || v_member_id::text,
        true
      );
    END LOOP;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Create triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_broadcast_conversation_participant ON public.conversation_participants;
CREATE TRIGGER trg_broadcast_conversation_participant
  AFTER INSERT ON public.conversation_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_conversation_participant_event();

DROP TRIGGER IF EXISTS trg_broadcast_user_server ON public.user_servers;
CREATE TRIGGER trg_broadcast_user_server
  AFTER INSERT OR DELETE ON public.user_servers
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_user_server_event();

DROP TRIGGER IF EXISTS trg_broadcast_server_change ON public.servers;
CREATE TRIGGER trg_broadcast_server_change
  AFTER UPDATE ON public.servers
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_server_change_event();

-- ---------------------------------------------------------------------------
-- 5. Remove notifications & unread_counts from realtime publication
--    These tables now use broadcast instead of CDC.
-- ---------------------------------------------------------------------------
DROP PUBLICATION IF EXISTS supabase_realtime;

CREATE PUBLICATION supabase_realtime FOR TABLE
  messages,
  reactions,
  channels,
  channel_categories,
  servers,
  user_servers,
  server_roles,
  conversations,
  conversation_participants,
  -- Kept in publication as fallback when realtime.send() is unavailable
  notifications,
  unread_counts,
  profiles,
  user_view_contexts,
  voice_channel_participants,
  megolm_session_shares,
  megolm_key_backups,
  posts,
  post_interactions,
  follows,
  threads,
  emojis,
  server_membership_events;

COMMIT;

NOTIFY pgrst, 'reload schema';
