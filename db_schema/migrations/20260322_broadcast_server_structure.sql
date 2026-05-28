BEGIN;

-- ============================================================================
-- Step 2a+2b: Replace per-server CDC on channels, channel_categories,
-- and server_membership_events with server-scoped broadcast triggers.
--
-- Each trigger sends a broadcast to topic "server-structure:{server_id}"
-- with event "server_event".  The frontend subscribes to this single
-- broadcast topic instead of 6+ CDC listeners per server.
-- ============================================================================

-- 1. channels → broadcast to server-structure:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_channel_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row    record;
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row    := OLD;
    v_server := OLD.server_id;
  ELSE
    v_row    := NEW;
    v_server := NEW.server_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'channel:' || lower(TG_OP),
      'new',  CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old',  CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || v_server::text
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_channel_change ON channels;
CREATE TRIGGER trg_broadcast_channel_change
  AFTER INSERT OR UPDATE OR DELETE ON channels
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_channel_change();


-- 2. channel_categories → broadcast to server-structure:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_category_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
  ELSE
    v_server := NEW.server_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'category:' || lower(TG_OP),
      'new',  CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old',  CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || v_server::text
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_category_change ON channel_categories;
CREATE TRIGGER trg_broadcast_category_change
  AFTER INSERT OR UPDATE OR DELETE ON channel_categories
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_category_change();


-- 3. server_membership_events → broadcast to server-structure:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_membership_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'membership:event',
      'new',  to_jsonb(NEW)
    ),
    'server_event',
    'server-structure:' || NEW.server_id::text
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_membership_event ON server_membership_events;
CREATE TRIGGER trg_broadcast_membership_event
  AFTER INSERT ON server_membership_events
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_membership_event();

-- 4. threads → broadcast to server-structure:{server_id} (via channel lookup)
CREATE OR REPLACE FUNCTION public.broadcast_thread_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_channel_id uuid;
  v_server_id  uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_channel_id := OLD.channel_id;
  ELSE
    v_channel_id := NEW.channel_id;
  END IF;

  SELECT server_id INTO v_server_id
  FROM channels
  WHERE id = v_channel_id;

  IF v_server_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'thread:' || lower(TG_OP),
      'new',  CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old',  CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || v_server_id::text
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_thread_change ON threads;
CREATE TRIGGER trg_broadcast_thread_change
  AFTER INSERT OR UPDATE OR DELETE ON threads
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_thread_change();

COMMIT;
