-- Unread badges: thread replies, muted contexts, and notifications of a read context.
--
-- Thread replies carry their parent's channel_id, and trigger_new_message_unread had no thread
-- filter: every reply advanced the channel's message_seq and last_message_id, so a channel
-- showed unread for messages its view never renders. Replies no longer count toward the
-- channel. message_heads then counts what the 20261005700001 backfill counted; read_seq and
-- skipped stay consistent because a reply changes neither the head nor any member's row.
-- Counts that replies raised before this migration remain until the channel is next read.
--
-- get_unread_counts gains muted: the context has an active mute in notification_channels
-- (muted, muted_until unset or in the future). A mute freezes the count it began with
-- (20261005700001); clients summed that frozen count into the server's unread state while
-- the channel list hid it, which left a server dot with no unread channel. The unread:change
-- payload of broadcast_unread_count_event carries the same flag as count.muted, and a mute
-- or unmute (muted_at_seq set or cleared) now sends one.
--
-- mark_channel_as_read and mark_conversation_as_read mark the context's notifications read,
-- as mark_server_as_read does for a server, with the predicate of
-- mark_notifications_read_by_context. A read set unread_mentions to 0 while the mention and
-- DM notifications behind the client's badges stayed unread.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Thread replies
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trigger_new_message_unread ON public.messages;
CREATE TRIGGER trigger_new_message_unread
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.thread_id IS NULL
          AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_new_message_unread();

-- ---------------------------------------------------------------------------
-- Muted contexts
-- ---------------------------------------------------------------------------

-- The return type changes; CREATE OR REPLACE cannot add an output column.
DROP FUNCTION IF EXISTS public.get_unread_counts();

CREATE FUNCTION public.get_unread_counts()
RETURNS TABLE(id uuid, user_id uuid, server_id uuid, channel_id uuid, conversation_id uuid,
              unread_messages integer, unread_mentions integer, last_read_message_id uuid,
              last_read_at timestamp with time zone, last_message_at timestamp with time zone,
              muted boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH ch AS (
        SELECT c.id, c.server_id, us.created_at AS since
          FROM public.user_servers us
          JOIN public.channels c ON c.server_id = us.server_id
         WHERE us.user_id = v_me AND us.status = 'accepted'
           AND c.id IN (SELECT public.current_user_viewable_channel_ids())
    ),
    cv AS (
        SELECT cp.conversation_id, min(cp.joined_at) AS since
          FROM public.conversation_participants cp
         WHERE cp.user_id = v_me AND cp.left_at IS NULL
         GROUP BY cp.conversation_id
    ),
    mu AS (
        SELECT nc.channel_id AS mch, nc.conversation_id AS mcv
          FROM public.notification_channels nc
         WHERE nc.user_id = v_me AND nc.muted = true
           AND (nc.muted_until IS NULL OR nc.muted_until > now())
    ),
    st AS (
        SELECT u.id AS row_id, ch.server_id AS sid, ch.id AS cid, NULL::uuid AS vid,
               COALESCE(u.muted_at_seq, h.message_seq, 0) - COALESCE(u.read_seq, 0) - COALESCE(u.skipped, 0) AS n,
               COALESCE(u.unread_mentions, 0) AS mentions, u.last_read_message_id AS lrm,
               COALESCE(u.last_read_at, GREATEST(ch.since, h.origin_at)) AS read_at, h.last_message_at AS lma,
               EXISTS (SELECT 1 FROM mu WHERE mu.mch = ch.id) AS is_muted
          FROM ch
          LEFT JOIN public.message_heads h ON h.channel_id = ch.id
          LEFT JOIN public.unread_counts u ON u.user_id = v_me AND u.channel_id = ch.id
        UNION ALL
        SELECT u.id, NULL::uuid, NULL::uuid, cv.conversation_id,
               COALESCE(u.muted_at_seq, h.message_seq, 0) - COALESCE(u.read_seq, 0) - COALESCE(u.skipped, 0),
               COALESCE(u.unread_mentions, 0), u.last_read_message_id,
               COALESCE(u.last_read_at, GREATEST(cv.since, h.origin_at)), h.last_message_at,
               EXISTS (SELECT 1 FROM mu WHERE mu.mcv = cv.conversation_id)
          FROM cv
          LEFT JOIN public.message_heads h ON h.conversation_id = cv.conversation_id
          LEFT JOIN public.unread_counts u ON u.user_id = v_me AND u.conversation_id = cv.conversation_id
    )
    SELECT st.row_id, v_me, st.sid, st.cid, st.vid,
           LEAST(GREATEST(st.n, 0), 2147483647)::integer, st.mentions, st.lrm, st.read_at, st.lma,
           st.is_muted
      FROM st
     WHERE st.n > 0 OR st.mentions > 0;
END;
$$;

COMMENT ON FUNCTION public.get_unread_counts() IS
'The caller''s channels and conversations with unread messages or mentions. muted: an active mute; unread_messages is then the count frozen when it began. Caller resolved via get_current_profile_id().';

REVOKE ALL ON FUNCTION public.get_unread_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unread_counts() TO authenticated, service_role;

-- Same as 20261005700001 but for count.muted.
CREATE OR REPLACE FUNCTION public.broadcast_unread_count_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_seq    bigint;
    v_origin timestamptz;
    v_since  timestamptz;
    v_muted  boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM realtime.send(
            public.unread_change_payload('delete', OLD.id, OLD.user_id, OLD.server_id, OLD.channel_id,
                                         OLD.conversation_id, 0, OLD.unread_mentions,
                                         OLD.last_read_message_id, OLD.last_read_at),
            'user_event', 'user:' || OLD.user_id::text, true);
        RETURN OLD;
    END IF;

    IF NEW.channel_id IS NOT NULL THEN
        SELECT h.message_seq, h.origin_at INTO v_seq, v_origin
          FROM public.message_heads h WHERE h.channel_id = NEW.channel_id;
        SELECT us.created_at INTO v_since
          FROM public.user_servers us
         WHERE us.user_id = NEW.user_id AND us.server_id = NEW.server_id;
        v_muted := EXISTS (
            SELECT 1 FROM public.notification_channels nc
             WHERE nc.user_id = NEW.user_id AND nc.channel_id = NEW.channel_id
               AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()));
    ELSE
        SELECT h.message_seq, h.origin_at INTO v_seq, v_origin
          FROM public.message_heads h WHERE h.conversation_id = NEW.conversation_id;
        SELECT min(cp.joined_at) INTO v_since
          FROM public.conversation_participants cp
         WHERE cp.user_id = NEW.user_id AND cp.conversation_id = NEW.conversation_id;
        v_muted := EXISTS (
            SELECT 1 FROM public.notification_channels nc
             WHERE nc.user_id = NEW.user_id AND nc.conversation_id = NEW.conversation_id
               AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()));
    END IF;

    PERFORM realtime.send(
        jsonb_set(
            public.unread_change_payload('upsert', NEW.id, NEW.user_id, NEW.server_id, NEW.channel_id,
                                         NEW.conversation_id,
                                         COALESCE(NEW.muted_at_seq, v_seq, 0) - NEW.read_seq - NEW.skipped,
                                         NEW.unread_mentions, NEW.last_read_message_id,
                                         COALESCE(NEW.last_read_at, GREATEST(v_since, v_origin))),
            '{count,muted}', to_jsonb(v_muted)),
        'user_event', 'user:' || NEW.user_id::text, true);
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'broadcast_unread_count_event failed: %', SQLERRM;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_unread_count_insert ON public.unread_counts;
CREATE TRIGGER trg_broadcast_unread_count_insert
    AFTER INSERT ON public.unread_counts
    FOR EACH ROW
    WHEN (NEW.last_read_at IS NOT NULL OR NEW.unread_mentions > 0 OR NEW.muted_at_seq IS NOT NULL)
    EXECUTE FUNCTION public.broadcast_unread_count_event();

DROP TRIGGER IF EXISTS trg_broadcast_unread_count_update ON public.unread_counts;
CREATE TRIGGER trg_broadcast_unread_count_update
    AFTER UPDATE ON public.unread_counts
    FOR EACH ROW
    WHEN (OLD.last_read_at IS DISTINCT FROM NEW.last_read_at
          OR OLD.last_read_message_id IS DISTINCT FROM NEW.last_read_message_id
          OR OLD.unread_mentions IS DISTINCT FROM NEW.unread_mentions
          OR (OLD.muted_at_seq IS NULL) <> (NEW.muted_at_seq IS NULL))
    EXECUTE FUNCTION public.broadcast_unread_count_event();

-- ---------------------------------------------------------------------------
-- Reads clear the context's notifications
-- ---------------------------------------------------------------------------

-- Same as 20261005700001 but for the notifications.
CREATE OR REPLACE FUNCTION public.mark_channel_as_read(p_channel_id uuid, p_message_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me      uuid := public.get_current_profile_id();
    v_server  uuid;
    v_seq     bigint;
    v_message uuid;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel_id;
    IF v_server IS NULL OR NOT public.can_view_channel(v_me, p_channel_id) THEN
        RETURN;
    END IF;

    SELECT h.message_seq INTO v_seq
      FROM public.message_heads h WHERE h.channel_id = p_channel_id FOR SHARE;
    v_seq := COALESCE(v_seq, 0);

    IF p_message_id IS NOT NULL THEN
        SELECT m.id INTO v_message
          FROM public.messages m WHERE m.id = p_message_id AND m.channel_id = p_channel_id;
    END IF;

    INSERT INTO public.unread_counts AS u
        (user_id, server_id, channel_id, read_seq, skipped, unread_mentions,
         last_read_message_id, last_read_at, updated_at)
    VALUES (v_me, v_server, p_channel_id, v_seq, 0, 0, v_message, now(), now())
    ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL DO UPDATE SET
        read_seq = EXCLUDED.read_seq,
        skipped = 0,
        muted_at_seq = CASE WHEN u.muted_at_seq IS NULL THEN NULL ELSE EXCLUDED.read_seq END,
        unread_mentions = 0,
        last_read_message_id = COALESCE(EXCLUDED.last_read_message_id, u.last_read_message_id),
        last_read_at = EXCLUDED.last_read_at,
        updated_at = EXCLUDED.updated_at;

    UPDATE public.notifications n
       SET is_read = true, read_at = now(), updated_at = now()
     WHERE n.user_id = v_me
       AND n.is_read = false
       AND (n.data->>'channel_id' = p_channel_id::text
            OR n.data->'location'->>'channel_id' = p_channel_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_conversation_as_read(p_conversation_id uuid, p_message_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me      uuid := public.get_current_profile_id();
    v_seq     bigint;
    v_message uuid;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_conversation_participant(p_conversation_id, v_me) THEN
        RETURN;
    END IF;

    SELECT h.message_seq INTO v_seq
      FROM public.message_heads h WHERE h.conversation_id = p_conversation_id FOR SHARE;
    v_seq := COALESCE(v_seq, 0);

    IF p_message_id IS NOT NULL THEN
        SELECT m.id INTO v_message
          FROM public.messages m WHERE m.id = p_message_id AND m.conversation_id = p_conversation_id;
    END IF;

    INSERT INTO public.unread_counts AS u
        (user_id, conversation_id, read_seq, skipped, unread_mentions,
         last_read_message_id, last_read_at, updated_at)
    VALUES (v_me, p_conversation_id, v_seq, 0, 0, v_message, now(), now())
    ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL DO UPDATE SET
        read_seq = EXCLUDED.read_seq,
        skipped = 0,
        muted_at_seq = CASE WHEN u.muted_at_seq IS NULL THEN NULL ELSE EXCLUDED.read_seq END,
        unread_mentions = 0,
        last_read_message_id = COALESCE(EXCLUDED.last_read_message_id, u.last_read_message_id),
        last_read_at = EXCLUDED.last_read_at,
        updated_at = EXCLUDED.updated_at;

    UPDATE public.notifications n
       SET is_read = true, read_at = now(), updated_at = now()
     WHERE n.user_id = v_me
       AND n.is_read = false
       AND (n.data->>'conversation_id' = p_conversation_id::text
            OR n.data->'conversation'->>'id' = p_conversation_id::text);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_channel_as_read(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_conversation_as_read(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_channel_as_read(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_conversation_as_read(uuid, uuid) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
