BEGIN;

-- =============================================================================
-- Phase 1: User Event Broadcast Channel
--
-- Replace per-table postgres_changes subscriptions (notifications, unread_counts)
-- with a single broadcast channel per user via realtime.send().
--
-- REQUIRES: Supabase Realtime >= 2.28.0 (ships with self-hosted images from 2024+)
-- The realtime.send() function must exist in the realtime schema.
-- To verify: SELECT proname FROM pg_proc WHERE proname = 'send' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'realtime');
--
-- SECURITY: All broadcasts use private := true, which means only clients with
-- a valid Supabase JWT can subscribe.  The channel topic includes the user's
-- UUID (128-bit, unguessable), so other authenticated users cannot discover it
-- through the API.  For additional hardening, enable RLS on realtime.messages
-- and add a policy restricting topics to the authenticated user's own UUID:
--
--   ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "users_own_channel" ON realtime.messages FOR SELECT
--     USING (realtime.topic() = 'user:' || auth.uid()::text);
--
-- All trigger functions use EXCEPTION WHEN OTHERS to gracefully degrade
-- if realtime.send() is unavailable or fails for any reason.
-- The notification/unread INSERT is NEVER blocked by a broadcast failure.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Broadcast new/updated notifications to user:{user_id} broadcast channel
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_notification_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'notification:new',
        'notification', jsonb_build_object(
          'id', NEW.id,
          'type', NEW.type,
          'data', NEW.data,
          'is_read', NEW.is_read,
          'is_clicked', NEW.is_clicked,
          'created_at', NEW.created_at,
          'updated_at', NEW.updated_at,
          'user_id', NEW.user_id,
          'expires_at', NEW.expires_at
        )
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.is_read IS DISTINCT FROM NEW.is_read THEN
      PERFORM realtime.send(
        jsonb_build_object(
          'type', 'notification:update',
          'id', NEW.id,
          'is_read', NEW.is_read
        ),
        'user_event',
        'user:' || NEW.user_id::text,
        true
      );
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Broadcast unread count changes to user:{user_id} broadcast channel
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_unread_count_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_record record;
  v_action text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_record := OLD;
    v_action := 'delete';
  ELSE
    v_record := NEW;
    v_action := 'upsert';
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'unread:change',
      'action', v_action,
      'count', jsonb_build_object(
        'id', v_record.id,
        'user_id', v_record.user_id,
        'server_id', v_record.server_id,
        'channel_id', v_record.channel_id,
        'conversation_id', v_record.conversation_id,
        'unread_messages', v_record.unread_messages,
        'unread_mentions', v_record.unread_mentions,
        'last_read_at', v_record.last_read_at
      )
    ),
    'user_event',
    'user:' || v_record.user_id::text,
    true
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Create triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_broadcast_notification ON public.notifications;
CREATE TRIGGER trg_broadcast_notification
  AFTER INSERT OR UPDATE ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_notification_event();

DROP TRIGGER IF EXISTS trg_broadcast_unread_count ON public.unread_counts;
CREATE TRIGGER trg_broadcast_unread_count
  AFTER INSERT OR UPDATE OR DELETE ON public.unread_counts
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_unread_count_event();

COMMIT;

NOTIFY pgrst, 'reload schema';
