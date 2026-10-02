-- Unread state is computed on read; a message insert no longer writes a row per member.
--
-- handle_new_message_unread upserted unread_counts for every accepted member who could view
-- the channel, and trg_broadcast_unread_count sent one realtime message per upserted row, so
-- a message cost O(members). Now:
--
--   message_heads     one row per channel or conversation. message_seq counts the messages
--                     that count toward unread (not deleted or system at insert, the same
--                     filter the message triggers carry); a DM from a null author is not
--                     counted, as before. Updated once per message, under its row lock.
--   unread_counts     per (user, context) read state. read_seq is message_seq when the user
--                     last read. skipped counts messages after read_seq that never count: the
--                     user's own, and those posted while the user muted the context.
--                     muted_at_seq is message_seq when the current mute began, NULL when
--                     unmuted. unread_mentions is unchanged.
--
--   unread messages = coalesce(muted_at_seq, message_seq) - read_seq - skipped
--
-- A missing unread_counts row reads as read_seq = skipped = 0 and not muted. message_seq is 0
-- for every context at this migration, so existing rows carry read_seq = -unread_messages
-- and every count is unchanged. A missing message_heads row reads as message_seq = 0.
--
-- Rows keep these in step: an accepted join, or a participant (re)joining a conversation,
-- sets read_seq to the current message_seq, so earlier messages are not unread; the author of
-- a message is advanced past it when they had nothing unread, else skipped += 1; a mute
-- freezes the count at its start, and its end adds the messages posted during it to
-- skipped. A mute that lapses by muted_until is settled by the next message in its context,
-- and until then no message has arrived to count. Unmuted and caught up therefore means
-- read_seq = message_seq and skipped = 0.
--
-- Realtime. A channel message sends unread:change only to members whose count goes from 0
-- to 1: rows with read_seq = the previous message_seq, found through
-- idx_unread_counts_channel_seq, and at the first counted message every member without a
-- row. A member with unread messages already shows the channel unread. A DM still sends its
-- exact count to every unmuted participant. A read sends unread:change to the reader's
-- devices.
--
-- Deviations from the per-message counter, all on transitions it never observed: a member
-- gaining VIEW_CHANNEL sees messages since their last read rather than since the grant; a
-- member who leaves and rejoins starts with nothing unread rather than the count frozen at
-- departure.
--
-- channel_viewer_ids computed each member's role mask with a subquery over all of the
-- server's role assignments: 4.2 s for a 10,000-member server with 9,050 assignments. The
-- mask is now aggregated once per member; same result.
--
-- Seeded local DB, supabase/postgres 15.8.1.060: servers of 60, 2,000 and 10,000 members,
-- 1,000 channels, 101 conversations, 293k messages, 285k unread rows. ms, before -> after.
-- Unread trigger per message, warm session, median of 9:
--   60 members, open channel                          2.8  -> 0.19
--   2,000 members, open channel                        90  -> 0.32
--   2,000 members, channel a role of 50 can view      165  -> 0.19   (4.7: viewer fix alone)
--   10,000 members, open channel                      487  -> 0.19
--   10,000 members, channel a role of 9,000 can view  4,568 -> 0.19  (508: viewer fix alone)
--   DM / group DM of 10                        0.11 / 0.88 -> 0.16 / 0.31
-- Message insert, pgbench, committed, 1 client / 4 clients on one channel:
--   10,000 members, open channel           677 / 2,390 -> 1.8 / 3.2
-- 8 clients on that channel, one insert per four mark-reads by 500 readers: insert 4,644 ->
-- 18, mark-read 113 -> 1.3; without the FOR SHARE in the mark functions, 6.5 and 0.4.
-- The first counted message in a channel after this migration or its creation reaches every
-- member with nothing unread there, once: 136 for 7,558 members.
-- Reads, authenticated: unread fetch 0.16 -> 2.5 for a member of 50 servers (1,000
-- channels, 101 conversations), 0.08 -> 0.75 for a member of one; get_today_summary 20.7 ->
-- 10; get_user_conversations 7.7 -> 8.3; mark_server_as_read 2.5 -> 1.3.
-- This migration on that DB: 2.3 s.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- The per-row broadcast fires on every write below; replaced at the end.
DROP TRIGGER IF EXISTS trg_broadcast_unread_count ON public.unread_counts;
DROP TRIGGER IF EXISTS trg_broadcast_unread_count_insert ON public.unread_counts;
DROP TRIGGER IF EXISTS trg_broadcast_unread_count_update ON public.unread_counts;
DROP TRIGGER IF EXISTS trg_broadcast_unread_count_delete ON public.unread_counts;

-- ---------------------------------------------------------------------------
-- message_heads
-- ---------------------------------------------------------------------------

-- fillfactor leaves room for HOT updates; no indexed column changes per message.
CREATE TABLE IF NOT EXISTS public.message_heads (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    channel_id uuid REFERENCES public.channels(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
    message_seq bigint DEFAULT 0 NOT NULL,
    last_message_id uuid,
    last_message_at timestamp with time zone,
    -- When message_seq was 0: this migration for existing contexts, creation for new ones.
    origin_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_heads_one_context CHECK ((channel_id IS NULL) <> (conversation_id IS NULL))
) WITH (fillfactor = 70);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_heads_channel
    ON public.message_heads (channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_heads_conversation
    ON public.message_heads (conversation_id) WHERE conversation_id IS NOT NULL;

COMMENT ON TABLE public.message_heads IS
    'Per channel or conversation: message_seq counts messages that count toward unread. Read state lives in unread_counts.';

-- postgres owns part of production's SECURITY DEFINER functions; migrations there run as
-- supabase_admin, which then owns this table.
ALTER TABLE public.message_heads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.message_heads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.message_heads TO authenticated;
GRANT ALL ON TABLE public.message_heads TO postgres, service_role;

DROP POLICY IF EXISTS "message_heads_select_visible" ON public.message_heads;
CREATE POLICY "message_heads_select_visible" ON public.message_heads
    FOR SELECT TO authenticated
    USING (
        (channel_id IS NOT NULL
         AND channel_id IN (SELECT public.current_user_viewable_channel_ids()))
        OR (conversation_id IS NOT NULL
            AND public.is_conversation_participant(conversation_id, (SELECT public.get_current_profile_id())))
    );

INSERT INTO public.message_heads (channel_id, message_seq, last_message_id, last_message_at, origin_at)
SELECT c.id, 0, lm.id, lm.created_at, now()
  FROM public.channels c
  LEFT JOIN LATERAL (
      SELECT m.id, m.created_at
        FROM public.messages m
       WHERE m.channel_id = c.id
         AND m.thread_id IS NULL
         AND (m.is_deleted IS NULL OR m.is_deleted = false)
         AND m.is_system = false
       ORDER BY m.created_at DESC
       LIMIT 1
  ) lm ON true
ON CONFLICT (channel_id) WHERE channel_id IS NOT NULL DO NOTHING;

INSERT INTO public.message_heads (conversation_id, message_seq, last_message_id, last_message_at, origin_at)
SELECT cv.id, 0, lm.id, lm.created_at, now()
  FROM public.conversations cv
  LEFT JOIN LATERAL (
      SELECT m.id, m.created_at
        FROM public.messages m
       WHERE m.conversation_id = cv.id
         AND m.thread_id IS NULL
         AND (m.is_deleted IS NULL OR m.is_deleted = false)
         AND m.is_system = false
       ORDER BY m.created_at DESC
       LIMIT 1
  ) lm ON true
ON CONFLICT (conversation_id) WHERE conversation_id IS NOT NULL DO NOTHING;

-- ---------------------------------------------------------------------------
-- unread_counts
-- ---------------------------------------------------------------------------

ALTER TABLE public.unread_counts
    ADD COLUMN IF NOT EXISTS read_seq bigint DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS skipped bigint DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS muted_at_seq bigint;

-- NULL until the user reads; the read boundary then falls back to joining or the origin.
ALTER TABLE public.unread_counts ALTER COLUMN last_read_at DROP DEFAULT;

COMMENT ON COLUMN public.unread_counts.read_seq IS 'message_heads.message_seq when the user last read the context.';
COMMENT ON COLUMN public.unread_counts.skipped IS 'Messages after read_seq that do not count: the user''s own, and those posted while muted.';
COMMENT ON COLUMN public.unread_counts.muted_at_seq IS 'message_heads.message_seq when the current mute began; NULL when not muted.';

DO $$
DECLARE
    v_n bigint;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'unread_counts'
                  AND column_name = 'unread_messages') THEN
        -- Every head was created above at message_seq 0.
        EXECUTE 'UPDATE public.unread_counts SET read_seq = -unread_messages, skipped = 0 WHERE unread_messages > 0';
        GET DIAGNOSTICS v_n = ROW_COUNT;
        RAISE NOTICE 'unread_counts: % rows carry their count as read_seq', v_n;
        ALTER TABLE public.unread_counts DROP COLUMN unread_messages;
    ELSE
        RAISE NOTICE 'unread_counts.unread_messages absent; counts already converged';
    END IF;
END;
$$;

-- Active mutes freeze the count they started with.
INSERT INTO public.unread_counts AS u (user_id, server_id, channel_id, muted_at_seq)
SELECT DISTINCT ON (nc.user_id, nc.channel_id)
       nc.user_id, c.server_id, nc.channel_id, COALESCE(h.message_seq, 0)
  FROM public.notification_channels nc
  JOIN public.channels c ON c.id = nc.channel_id
  LEFT JOIN public.message_heads h ON h.channel_id = nc.channel_id
 WHERE nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now())
ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
DO UPDATE SET muted_at_seq = COALESCE(u.muted_at_seq, EXCLUDED.muted_at_seq);

INSERT INTO public.unread_counts AS u (user_id, conversation_id, muted_at_seq)
SELECT DISTINCT ON (nc.user_id, nc.conversation_id)
       nc.user_id, nc.conversation_id, COALESCE(h.message_seq, 0)
  FROM public.notification_channels nc
  JOIN public.conversations cv ON cv.id = nc.conversation_id
  LEFT JOIN public.message_heads h ON h.conversation_id = nc.conversation_id
 WHERE nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now())
ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
DO UPDATE SET muted_at_seq = COALESCE(u.muted_at_seq, EXCLUDED.muted_at_seq);

-- Caught-up members of a channel: (channel_id, read_seq = previous message_seq).
CREATE INDEX IF NOT EXISTS idx_unread_counts_channel_seq
    ON public.unread_counts (channel_id, read_seq) WHERE channel_id IS NOT NULL;
DROP INDEX IF EXISTS public.idx_unread_counts_channel;

-- Mutes with an end time; none is written by the application.
CREATE INDEX IF NOT EXISTS idx_notification_channels_channel_mute_end
    ON public.notification_channels (channel_id) WHERE muted = true AND muted_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_channels_conversation_mute_end
    ON public.notification_channels (conversation_id) WHERE muted = true AND muted_until IS NOT NULL;

-- Writes go through the functions below: read_seq is meaningful only against message_heads.
DROP POLICY IF EXISTS "unread_counts_update_own" ON public.unread_counts;
REVOKE ALL ON TABLE public.unread_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.unread_counts TO authenticated;
GRANT ALL ON TABLE public.unread_counts TO service_role;

-- ---------------------------------------------------------------------------
-- Payload
-- ---------------------------------------------------------------------------

-- unread:change on user:<id>. Shape of the former per-row broadcast, plus last_read_message_id.
CREATE OR REPLACE FUNCTION public.unread_change_payload(
    p_action text, p_id uuid, p_user_id uuid, p_server_id uuid, p_channel_id uuid,
    p_conversation_id uuid, p_unread_messages bigint, p_unread_mentions integer,
    p_last_read_message_id uuid, p_last_read_at timestamp with time zone)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'type', 'unread:change',
        'action', p_action,
        'count', jsonb_build_object(
            'id', p_id,
            'user_id', p_user_id,
            'server_id', p_server_id,
            'channel_id', p_channel_id,
            'conversation_id', p_conversation_id,
            'unread_messages', LEAST(GREATEST(p_unread_messages, 0), 2147483647),
            'unread_mentions', COALESCE(p_unread_mentions, 0),
            'last_read_message_id', p_last_read_message_id,
            'last_read_at', p_last_read_at))
$$;

-- ---------------------------------------------------------------------------
-- Message insert
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_message_unread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server  uuid;
    v_created timestamptz;
    v_prev    bigint;
    v_seq     bigint;
    v_origin  timestamptz;
BEGIN
    SELECT c.server_id, c.created_at INTO v_server, v_created
      FROM public.channels c WHERE c.id = NEW.channel_id;
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT h.message_seq, h.origin_at INTO v_prev, v_origin
      FROM public.message_heads h WHERE h.channel_id = NEW.channel_id
       FOR UPDATE;
    IF FOUND THEN
        UPDATE public.message_heads
           SET message_seq = v_prev + 1, last_message_id = NEW.id, last_message_at = NEW.created_at
         WHERE channel_id = NEW.channel_id;
    ELSE
        INSERT INTO public.message_heads AS h (channel_id, message_seq, last_message_id, last_message_at, origin_at)
        VALUES (NEW.channel_id, 1, NEW.id, NEW.created_at, v_created)
        ON CONFLICT (channel_id) WHERE channel_id IS NOT NULL DO UPDATE
           SET message_seq = h.message_seq + 1,
               last_message_id = EXCLUDED.last_message_id,
               last_message_at = EXCLUDED.last_message_at
        RETURNING h.message_seq - 1, h.origin_at INTO v_prev, v_origin;
    END IF;
    v_seq := v_prev + 1;

    -- Mutes that lapsed by muted_until end at v_prev: nothing was posted since.
    UPDATE public.unread_counts u
       SET read_seq = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN v_prev ELSE u.read_seq END,
           skipped = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN 0
                          ELSE u.skipped + v_prev - u.muted_at_seq END,
           muted_at_seq = NULL
      FROM public.notification_channels nc
     WHERE nc.channel_id = NEW.channel_id
       AND nc.muted = true AND nc.muted_until IS NOT NULL AND nc.muted_until <= now()
       AND u.user_id = nc.user_id AND u.channel_id = NEW.channel_id
       AND u.muted_at_seq IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.notification_channels a
            WHERE a.user_id = nc.user_id AND a.channel_id = NEW.channel_id
              AND a.muted = true AND (a.muted_until IS NULL OR a.muted_until > now()));

    IF NEW.user_id IS NOT NULL THEN
        INSERT INTO public.unread_counts AS u (user_id, server_id, channel_id, read_seq, skipped)
        VALUES (NEW.user_id, v_server, NEW.channel_id,
                CASE WHEN v_prev = 0 THEN v_seq ELSE 0 END,
                CASE WHEN v_prev = 0 THEN 0 ELSE 1 END)
        ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL DO UPDATE SET
            read_seq = CASE WHEN u.muted_at_seq IS NULL AND u.read_seq + u.skipped = v_prev
                            THEN v_seq ELSE u.read_seq END,
            skipped = CASE WHEN u.muted_at_seq IS NOT NULL THEN u.skipped
                           WHEN u.read_seq + u.skipped = v_prev THEN 0
                           ELSE u.skipped + 1 END;
    END IF;

    -- Members whose count goes from 0 to 1. channel_is_restricted() runs as an InitPlan, only
    -- once a candidate exists.
    BEGIN
        IF v_prev = 0 THEN
            PERFORM realtime.send(
                public.unread_change_payload('upsert', t.id, t.user_id, v_server, NEW.channel_id, NULL,
                                             1, t.unread_mentions, t.last_read_message_id,
                                             COALESCE(t.last_read_at, GREATEST(t.member_since, v_origin))),
                'user_event', 'user:' || t.user_id::text, true)
              FROM (
                  SELECT us.user_id, us.created_at AS member_since, u.id, u.unread_mentions,
                         u.last_read_message_id, u.last_read_at
                    FROM public.user_servers us
                    LEFT JOIN public.unread_counts u
                      ON u.user_id = us.user_id AND u.channel_id = NEW.channel_id
                   WHERE us.server_id = v_server
                     AND us.status = 'accepted'
                     AND us.user_id IS DISTINCT FROM NEW.user_id
                     AND (u.id IS NULL OR (u.read_seq = 0 AND u.skipped = 0 AND u.muted_at_seq IS NULL))
              ) t
             WHERE NOT (SELECT public.channel_is_restricted(NEW.channel_id))
                OR t.user_id IN (SELECT public.channel_viewer_ids(NEW.channel_id));
        ELSE
            PERFORM realtime.send(
                public.unread_change_payload('upsert', t.id, t.user_id, v_server, NEW.channel_id, NULL,
                                             1, t.unread_mentions, t.last_read_message_id,
                                             COALESCE(t.last_read_at, GREATEST(t.member_since, v_origin))),
                'user_event', 'user:' || t.user_id::text, true)
              FROM (
                  SELECT u.user_id, us.created_at AS member_since, u.id, u.unread_mentions,
                         u.last_read_message_id, u.last_read_at
                    FROM public.unread_counts u
                   -- LIMIT keeps this a probe per candidate; a join hashes every member.
                   CROSS JOIN LATERAL (
                       SELECT m.created_at
                         FROM public.user_servers m
                        WHERE m.user_id = u.user_id AND m.server_id = v_server AND m.status = 'accepted'
                        LIMIT 1
                   ) us
                   WHERE u.channel_id = NEW.channel_id
                     AND u.read_seq = v_prev
                     AND u.skipped = 0
                     AND u.muted_at_seq IS NULL
                     AND u.user_id IS DISTINCT FROM NEW.user_id
              ) t
             WHERE NOT (SELECT public.channel_is_restricted(NEW.channel_id))
                OR public.can_view_channel(t.user_id, NEW.channel_id);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_message_unread broadcast failed: %', SQLERRM;
    END;

    RETURN NEW;
END;
$$;

-- A DM from a null author reached no participant before (`user_id <> NULL`) and still does not.
CREATE OR REPLACE FUNCTION public.handle_new_dm_unread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_created timestamptz;
    v_prev    bigint;
    v_seq     bigint;
    v_origin  timestamptz;
BEGIN
    IF NEW.user_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT cv.created_at INTO v_created FROM public.conversations cv WHERE cv.id = NEW.conversation_id;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    SELECT h.message_seq, h.origin_at INTO v_prev, v_origin
      FROM public.message_heads h WHERE h.conversation_id = NEW.conversation_id
       FOR UPDATE;
    IF FOUND THEN
        UPDATE public.message_heads
           SET message_seq = v_prev + 1, last_message_id = NEW.id, last_message_at = NEW.created_at
         WHERE conversation_id = NEW.conversation_id;
    ELSE
        INSERT INTO public.message_heads AS h (conversation_id, message_seq, last_message_id, last_message_at, origin_at)
        VALUES (NEW.conversation_id, 1, NEW.id, NEW.created_at, COALESCE(v_created, now()))
        ON CONFLICT (conversation_id) WHERE conversation_id IS NOT NULL DO UPDATE
           SET message_seq = h.message_seq + 1,
               last_message_id = EXCLUDED.last_message_id,
               last_message_at = EXCLUDED.last_message_at
        RETURNING h.message_seq - 1, h.origin_at INTO v_prev, v_origin;
    END IF;
    v_seq := v_prev + 1;

    UPDATE public.unread_counts u
       SET read_seq = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN v_prev ELSE u.read_seq END,
           skipped = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN 0
                          ELSE u.skipped + v_prev - u.muted_at_seq END,
           muted_at_seq = NULL
      FROM public.notification_channels nc
     WHERE nc.conversation_id = NEW.conversation_id
       AND nc.muted = true AND nc.muted_until IS NOT NULL AND nc.muted_until <= now()
       AND u.user_id = nc.user_id AND u.conversation_id = NEW.conversation_id
       AND u.muted_at_seq IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.notification_channels a
            WHERE a.user_id = nc.user_id AND a.conversation_id = NEW.conversation_id
              AND a.muted = true AND (a.muted_until IS NULL OR a.muted_until > now()));

    INSERT INTO public.unread_counts AS u (user_id, conversation_id, read_seq, skipped)
    VALUES (NEW.user_id, NEW.conversation_id,
            CASE WHEN v_prev = 0 THEN v_seq ELSE 0 END,
            CASE WHEN v_prev = 0 THEN 0 ELSE 1 END)
    ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL DO UPDATE SET
        read_seq = CASE WHEN u.muted_at_seq IS NULL AND u.read_seq + u.skipped = v_prev
                        THEN v_seq ELSE u.read_seq END,
        skipped = CASE WHEN u.muted_at_seq IS NOT NULL THEN u.skipped
                       WHEN u.read_seq + u.skipped = v_prev THEN 0
                       ELSE u.skipped + 1 END;

    BEGIN
        PERFORM realtime.send(
            public.unread_change_payload('upsert', t.id, t.user_id, NULL, NULL, NEW.conversation_id,
                                         v_seq - COALESCE(t.read_seq, 0) - COALESCE(t.skipped, 0),
                                         t.unread_mentions, t.last_read_message_id,
                                         COALESCE(t.last_read_at, GREATEST(t.joined_at, v_origin))),
            'user_event', 'user:' || t.user_id::text, true)
          FROM (
              SELECT cp.user_id, min(cp.joined_at) AS joined_at, u.id, u.read_seq, u.skipped,
                     u.unread_mentions, u.last_read_message_id, u.last_read_at
                FROM public.conversation_participants cp
                LEFT JOIN public.unread_counts u
                  ON u.user_id = cp.user_id AND u.conversation_id = NEW.conversation_id
               WHERE cp.conversation_id = NEW.conversation_id
                 AND cp.left_at IS NULL
                 AND cp.user_id <> NEW.user_id
                 AND u.muted_at_seq IS NULL
               GROUP BY cp.user_id, u.id
          ) t;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_dm_unread broadcast failed: %', SQLERRM;
    END;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Mentions
-- ---------------------------------------------------------------------------

-- Upserts on the (user, context) unique indexes; the select-then-insert it replaces raised
-- 23505 when an existing channel row carried a different server_id.
CREATE OR REPLACE FUNCTION public.increment_unread_mentions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_channel_id uuid;
    v_server_id uuid;
    v_conversation_id uuid;
BEGIN
    IF NEW.type != 'mention' AND NEW.type != 'activitypub_mention' THEN
        RETURN NEW;
    END IF;

    v_channel_id := NULLIF((NEW.data->>'channel_id'), '')::uuid;
    v_server_id := NULLIF((NEW.data->>'server_id'), '')::uuid;
    v_conversation_id := NULLIF((NEW.data->>'conversation_id'), '')::uuid;

    IF v_channel_id IS NULL THEN
        v_channel_id := NULLIF((NEW.data->'location'->>'channel_id'), '')::uuid;
    END IF;
    IF v_server_id IS NULL THEN
        v_server_id := NULLIF((NEW.data->'location'->>'server_id'), '')::uuid;
    END IF;

    IF v_channel_id IS NOT NULL THEN
        INSERT INTO public.unread_counts AS u (user_id, server_id, channel_id, unread_mentions, updated_at)
        SELECT NEW.user_id, COALESCE(v_server_id, c.server_id), c.id, 1, now()
          FROM public.channels c
         WHERE c.id = v_channel_id
        ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
        DO UPDATE SET unread_mentions = u.unread_mentions + 1, updated_at = now();
    END IF;

    IF v_conversation_id IS NOT NULL THEN
        INSERT INTO public.unread_counts AS u (user_id, conversation_id, unread_mentions, updated_at)
        SELECT NEW.user_id, cv.id, 1, now()
          FROM public.conversations cv
         WHERE cv.id = v_conversation_id
        ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
        DO UPDATE SET unread_mentions = u.unread_mentions + 1, updated_at = now();
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Broadcast of read-state changes
-- ---------------------------------------------------------------------------

-- Fires for what a client shows: a read, a mention, a deleted row. Advancing an author or
-- tracking a mute changes no count.
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
    ELSE
        SELECT h.message_seq, h.origin_at INTO v_seq, v_origin
          FROM public.message_heads h WHERE h.conversation_id = NEW.conversation_id;
        SELECT min(cp.joined_at) INTO v_since
          FROM public.conversation_participants cp
         WHERE cp.user_id = NEW.user_id AND cp.conversation_id = NEW.conversation_id;
    END IF;

    PERFORM realtime.send(
        public.unread_change_payload('upsert', NEW.id, NEW.user_id, NEW.server_id, NEW.channel_id,
                                     NEW.conversation_id,
                                     COALESCE(NEW.muted_at_seq, v_seq, 0) - NEW.read_seq - NEW.skipped,
                                     NEW.unread_mentions, NEW.last_read_message_id,
                                     COALESCE(NEW.last_read_at, GREATEST(v_since, v_origin))),
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

CREATE TRIGGER trg_broadcast_unread_count_insert
    AFTER INSERT ON public.unread_counts
    FOR EACH ROW
    WHEN (NEW.last_read_at IS NOT NULL OR NEW.unread_mentions > 0)
    EXECUTE FUNCTION public.broadcast_unread_count_event();

CREATE TRIGGER trg_broadcast_unread_count_update
    AFTER UPDATE ON public.unread_counts
    FOR EACH ROW
    WHEN (OLD.last_read_at IS DISTINCT FROM NEW.last_read_at
          OR OLD.last_read_message_id IS DISTINCT FROM NEW.last_read_message_id
          OR OLD.unread_mentions IS DISTINCT FROM NEW.unread_mentions)
    EXECUTE FUNCTION public.broadcast_unread_count_event();

CREATE TRIGGER trg_broadcast_unread_count_delete
    AFTER DELETE ON public.unread_counts
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_unread_count_event();

-- ---------------------------------------------------------------------------
-- Joins and mutes
-- ---------------------------------------------------------------------------

-- Messages posted before an accepted join or a (re)join of a conversation are not unread.
-- Rows are written only where message_seq is not 0, the value a missing row already reads.
CREATE OR REPLACE FUNCTION public.reset_unread_on_join()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_TABLE_NAME = 'user_servers' THEN
        IF TG_OP = 'UPDATE' AND OLD.status = 'accepted'
           AND OLD.user_id = NEW.user_id AND OLD.server_id = NEW.server_id THEN
            RETURN NULL;
        END IF;

        UPDATE public.unread_counts u
           SET read_seq = COALESCE(h.message_seq, 0),
               skipped = 0,
               muted_at_seq = CASE WHEN u.muted_at_seq IS NULL THEN NULL ELSE COALESCE(h.message_seq, 0) END,
               last_read_message_id = NULL,
               last_read_at = NULL
          FROM public.channels c
          LEFT JOIN public.message_heads h ON h.channel_id = c.id
         WHERE c.server_id = NEW.server_id
           AND u.user_id = NEW.user_id
           AND u.channel_id = c.id;

        INSERT INTO public.unread_counts (user_id, server_id, channel_id, read_seq)
        SELECT NEW.user_id, NEW.server_id, h.channel_id, h.message_seq
          FROM public.channels c
          JOIN public.message_heads h ON h.channel_id = c.id
         WHERE c.server_id = NEW.server_id
           AND h.message_seq <> 0
        ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL DO NOTHING;
    ELSE
        IF TG_OP = 'UPDATE' AND OLD.left_at IS NULL
           AND OLD.user_id = NEW.user_id AND OLD.conversation_id = NEW.conversation_id THEN
            RETURN NULL;
        END IF;

        UPDATE public.unread_counts u
           SET read_seq = COALESCE(h.message_seq, 0),
               skipped = 0,
               muted_at_seq = CASE WHEN u.muted_at_seq IS NULL THEN NULL ELSE COALESCE(h.message_seq, 0) END,
               last_read_message_id = NULL,
               last_read_at = NULL
          FROM (SELECT NEW.conversation_id AS conversation_id) x
          LEFT JOIN public.message_heads h ON h.conversation_id = x.conversation_id
         WHERE u.user_id = NEW.user_id
           AND u.conversation_id = NEW.conversation_id;

        INSERT INTO public.unread_counts (user_id, conversation_id, read_seq)
        SELECT NEW.user_id, h.conversation_id, h.message_seq
          FROM public.message_heads h
         WHERE h.conversation_id = NEW.conversation_id
           AND h.message_seq <> 0
        ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL DO NOTHING;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_reset_unread_on_join ON public.user_servers;
CREATE TRIGGER trg_reset_unread_on_join
    AFTER INSERT OR UPDATE OF status, user_id, server_id ON public.user_servers
    FOR EACH ROW
    WHEN (NEW.status = 'accepted')
    EXECUTE FUNCTION public.reset_unread_on_join();

DROP TRIGGER IF EXISTS trg_reset_unread_on_join ON public.conversation_participants;
CREATE TRIGGER trg_reset_unread_on_join
    AFTER INSERT OR UPDATE OF left_at, user_id, conversation_id ON public.conversation_participants
    FOR EACH ROW
    WHEN (NEW.left_at IS NULL)
    EXECUTE FUNCTION public.reset_unread_on_join();

-- Brings unread_counts.muted_at_seq in line with notification_channels for one user and
-- context. A mute that lapsed by muted_until while no message arrived ends at the current
-- message_seq, which is where it lapsed.
CREATE OR REPLACE FUNCTION public.sync_unread_mute(p_user_id uuid, p_channel_id uuid, p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_muted  boolean;
    v_seq    bigint;
    v_server uuid;
BEGIN
    IF p_channel_id IS NOT NULL THEN
        SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel_id;
        IF NOT FOUND THEN
            RETURN;
        END IF;
        v_muted := EXISTS (
            SELECT 1 FROM public.notification_channels nc
             WHERE nc.user_id = p_user_id AND nc.channel_id = p_channel_id
               AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()));
        SELECT h.message_seq INTO v_seq
          FROM public.message_heads h WHERE h.channel_id = p_channel_id FOR SHARE;
        v_seq := COALESCE(v_seq, 0);

        IF v_muted THEN
            INSERT INTO public.unread_counts AS u (user_id, server_id, channel_id, muted_at_seq)
            VALUES (p_user_id, v_server, p_channel_id, v_seq)
            ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
            DO UPDATE SET muted_at_seq = COALESCE(u.muted_at_seq, EXCLUDED.muted_at_seq);
        ELSE
            UPDATE public.unread_counts u
               SET read_seq = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN v_seq ELSE u.read_seq END,
                   skipped = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN 0
                                  ELSE u.skipped + v_seq - u.muted_at_seq END,
                   muted_at_seq = NULL
             WHERE u.user_id = p_user_id AND u.channel_id = p_channel_id
               AND u.muted_at_seq IS NOT NULL;
        END IF;
    ELSIF p_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.conversations cv WHERE cv.id = p_conversation_id) THEN
            RETURN;
        END IF;
        v_muted := EXISTS (
            SELECT 1 FROM public.notification_channels nc
             WHERE nc.user_id = p_user_id AND nc.conversation_id = p_conversation_id
               AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()));
        SELECT h.message_seq INTO v_seq
          FROM public.message_heads h WHERE h.conversation_id = p_conversation_id FOR SHARE;
        v_seq := COALESCE(v_seq, 0);

        IF v_muted THEN
            INSERT INTO public.unread_counts AS u (user_id, conversation_id, muted_at_seq)
            VALUES (p_user_id, p_conversation_id, v_seq)
            ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
            DO UPDATE SET muted_at_seq = COALESCE(u.muted_at_seq, EXCLUDED.muted_at_seq);
        ELSE
            UPDATE public.unread_counts u
               SET read_seq = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN v_seq ELSE u.read_seq END,
                   skipped = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN 0
                                  ELSE u.skipped + v_seq - u.muted_at_seq END,
                   muted_at_seq = NULL
             WHERE u.user_id = p_user_id AND u.conversation_id = p_conversation_id
               AND u.muted_at_seq IS NOT NULL;
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.track_unread_mute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        IF OLD.channel_id IS NOT NULL THEN
            PERFORM public.sync_unread_mute(OLD.user_id, OLD.channel_id, NULL);
        END IF;
        IF OLD.conversation_id IS NOT NULL THEN
            PERFORM public.sync_unread_mute(OLD.user_id, NULL, OLD.conversation_id);
        END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        IF NEW.channel_id IS NOT NULL
           AND (TG_OP = 'INSERT' OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
                OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
            PERFORM public.sync_unread_mute(NEW.user_id, NEW.channel_id, NULL);
        END IF;
        IF NEW.conversation_id IS NOT NULL
           AND (TG_OP = 'INSERT' OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
                OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
            PERFORM public.sync_unread_mute(NEW.user_id, NULL, NEW.conversation_id);
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_track_unread_mute ON public.notification_channels;
CREATE TRIGGER trg_track_unread_mute
    AFTER INSERT OR UPDATE OF muted, muted_until, channel_id, conversation_id, user_id OR DELETE
    ON public.notification_channels
    FOR EACH ROW
    EXECUTE FUNCTION public.track_unread_mute();

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- The caller's contexts with unread messages or mentions: channels of servers they are an
-- accepted member of and can view, and conversations they have not left. Same row shape as
-- unread_counts had, plus the context's last_message_at. last_read_at falls back to joining
-- or the origin of message_seq, whichever is later. plpgsql rather than sql so the plan is
-- cached per session: planning was 0.6 of the 1.4 ms a one-server caller took on the bench.
CREATE OR REPLACE FUNCTION public.get_unread_counts()
RETURNS TABLE(id uuid, user_id uuid, server_id uuid, channel_id uuid, conversation_id uuid,
              unread_messages integer, unread_mentions integer, last_read_message_id uuid,
              last_read_at timestamp with time zone, last_message_at timestamp with time zone)
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
    st AS (
        SELECT u.id AS row_id, ch.server_id AS sid, ch.id AS cid, NULL::uuid AS vid,
               COALESCE(u.muted_at_seq, h.message_seq, 0) - COALESCE(u.read_seq, 0) - COALESCE(u.skipped, 0) AS n,
               COALESCE(u.unread_mentions, 0) AS mentions, u.last_read_message_id AS lrm,
               COALESCE(u.last_read_at, GREATEST(ch.since, h.origin_at)) AS read_at, h.last_message_at AS lma
          FROM ch
          LEFT JOIN public.message_heads h ON h.channel_id = ch.id
          LEFT JOIN public.unread_counts u ON u.user_id = v_me AND u.channel_id = ch.id
        UNION ALL
        SELECT u.id, NULL::uuid, NULL::uuid, cv.conversation_id,
               COALESCE(u.muted_at_seq, h.message_seq, 0) - COALESCE(u.read_seq, 0) - COALESCE(u.skipped, 0),
               COALESCE(u.unread_mentions, 0), u.last_read_message_id,
               COALESCE(u.last_read_at, GREATEST(cv.since, h.origin_at)), h.last_message_at
          FROM cv
          LEFT JOIN public.message_heads h ON h.conversation_id = cv.conversation_id
          LEFT JOIN public.unread_counts u ON u.user_id = v_me AND u.conversation_id = cv.conversation_id
    )
    SELECT st.row_id, v_me, st.sid, st.cid, st.vid,
           LEAST(GREATEST(st.n, 0), 2147483647)::integer, st.mentions, st.lrm, st.read_at, st.lma
      FROM st
     WHERE st.n > 0 OR st.mentions > 0;
END;
$$;

COMMENT ON FUNCTION public.get_unread_counts() IS
'The caller''s channels and conversations with unread messages or mentions. Caller resolved via get_current_profile_id().';

-- ---------------------------------------------------------------------------
-- Marking read
-- ---------------------------------------------------------------------------

-- FOR SHARE on the head orders a read against a concurrent message: the message's
-- caught-up scan runs after the read commits, or the read sees the message's seq.
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
END;
$$;

-- Clears every channel of the server the caller can view that has something to clear. Heads
-- and rows are locked in channel id order.
CREATE OR REPLACE FUNCTION public.mark_server_as_read(p_server_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_user_id uuid;
BEGIN
    v_user_id := public.get_current_profile_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF EXISTS (SELECT 1 FROM public.user_servers us
                WHERE us.user_id = v_user_id AND us.server_id = p_server_id
                  AND us.status = 'accepted') THEN
        PERFORM 1
           FROM public.message_heads h
           JOIN public.channels c ON c.id = h.channel_id
          WHERE c.server_id = p_server_id
          ORDER BY h.channel_id
            FOR SHARE OF h;

        INSERT INTO public.unread_counts AS u
            (user_id, server_id, channel_id, read_seq, skipped, unread_mentions, last_read_at, updated_at)
        SELECT v_user_id, p_server_id, c.id, COALESCE(h.message_seq, 0), 0, 0, now(), now()
          FROM public.channels c
          LEFT JOIN public.message_heads h ON h.channel_id = c.id
          LEFT JOIN public.unread_counts x ON x.user_id = v_user_id AND x.channel_id = c.id
         WHERE c.server_id = p_server_id
           AND c.id IN (SELECT public.current_user_viewable_channel_ids())
           AND (COALESCE(x.muted_at_seq, h.message_seq, 0) - COALESCE(x.read_seq, 0) - COALESCE(x.skipped, 0) <> 0
                OR COALESCE(x.unread_mentions, 0) > 0)
         ORDER BY c.id
        ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL DO UPDATE SET
            read_seq = EXCLUDED.read_seq,
            skipped = 0,
            muted_at_seq = CASE WHEN u.muted_at_seq IS NULL THEN NULL ELSE EXCLUDED.read_seq END,
            unread_mentions = 0,
            last_read_at = EXCLUDED.last_read_at,
            updated_at = EXCLUDED.updated_at;
    END IF;

    UPDATE public.notifications
    SET is_read = true, read_at = NOW(), updated_at = NOW()
    WHERE user_id = v_user_id
      AND is_read = false
      AND (
          data->>'server_id' = p_server_id::text
          OR data->'location'->>'server_id' = p_server_id::text
      );
END;
$$;

-- get_user_conversations(): unread_messages computed from message_heads.
CREATE OR REPLACE FUNCTION public.get_user_conversations()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
WITH me AS (
    SELECT public.get_current_profile_id() AS id
),
parts AS (
    SELECT
        cp.conversation_id,
        cp.role,
        cp.joined_at,
        cp.hidden_at,
        c.created_at,
        c.updated_at,
        c.type,
        c.name,
        c.created_by,
        c.is_active,
        c.metadata
    FROM public.conversation_participants cp
    JOIN public.conversations c ON c.id = cp.conversation_id
    WHERE cp.user_id = (SELECT id FROM me)
      AND cp.left_at IS NULL
)
SELECT COALESCE(
    jsonb_agg(
        jsonb_build_object(
            'conversation_id', p.conversation_id,
            'created_at', p.created_at,
            'updated_at', p.updated_at,
            'type', COALESCE(p.type, 'direct'),
            'name', p.name,
            'created_by', p.created_by,
            'is_active', p.is_active,
            'metadata', p.metadata,
            'hidden_at', p.hidden_at,
            'user_role', p.role,
            'user_joined_at', p.joined_at,
            'other_participants', COALESCE(op.others, '[]'::jsonb),
            'last_message', CASE WHEN lm.id IS NULL THEN NULL ELSE
                jsonb_build_object(
                    'id', lm.id,
                    'user_id', lm.user_id,
                    'content', lm.content,
                    'encrypted', COALESCE(lm.encrypted, false),
                    'created_at', lm.created_at,
                    'metadata', lm.metadata
                ) END,
            'unread_messages', GREATEST(
                COALESCE(uc.muted_at_seq, hd.message_seq, 0) - COALESCE(uc.read_seq, 0) - COALESCE(uc.skipped, 0), 0),
            'unread_mentions', COALESCE(uc.unread_mentions, 0),
            'is_muted', COALESCE(nc.muted, false)
        )
        ORDER BY COALESCE(lm.created_at, p.updated_at, p.created_at) DESC
    ),
    '[]'::jsonb
)
FROM parts p
LEFT JOIN LATERAL (
    SELECT m.id, m.user_id, m.content, m.encrypted, m.created_at, m.metadata
    FROM public.messages m
    WHERE m.conversation_id = p.conversation_id
    ORDER BY m.created_at DESC
    LIMIT 1
) lm ON true
LEFT JOIN LATERAL (
    SELECT jsonb_agg(
        jsonb_build_object(
            'user_id', cp2.user_id,
            'role', cp2.role,
            'joined_at', cp2.joined_at,
            'profile', jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', pr.domain,
                'is_local', pr.is_local,
                'federated_id', pr.federated_id
            )
        )
        ORDER BY cp2.joined_at ASC
    ) AS others
    FROM public.conversation_participants cp2
    JOIN public.profiles pr ON pr.id = cp2.user_id
    WHERE cp2.conversation_id = p.conversation_id
      AND cp2.user_id <> (SELECT id FROM me)
      AND cp2.left_at IS NULL
) op ON true
LEFT JOIN LATERAL (
    SELECT u.read_seq, u.skipped, u.muted_at_seq, u.unread_mentions
    FROM public.unread_counts u
    WHERE u.conversation_id = p.conversation_id
      AND u.user_id = (SELECT id FROM me)
    LIMIT 1
) uc ON true
LEFT JOIN public.message_heads hd ON hd.conversation_id = p.conversation_id
LEFT JOIN LATERAL (
    SELECT n.muted
    FROM public.notification_channels n
    WHERE n.conversation_id = p.conversation_id
      AND n.user_id = (SELECT id FROM me)
      AND n.channel_id IS NULL
    LIMIT 1
) nc ON true
$$;

-- ---------------------------------------------------------------------------
-- channel_viewer_ids: one role mask per member
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.channel_viewer_ids(p_channel_id uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    WITH ch AS (
        SELECT c.id, c.server_id, s.owner, ev.id AS everyone_id,
               COALESCE(ev.permissions, 0) AS everyone_mask
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
          LEFT JOIN public.server_roles ev ON ev.server_id = c.server_id AND ev.is_default = true
         WHERE c.id = p_channel_id
    ),
    mem AS (
        SELECT us.user_id
          FROM public.user_servers us
          JOIN ch ON ch.server_id = us.server_id
         WHERE us.status = 'accepted'
        UNION
        SELECT ch.owner FROM ch WHERE ch.owner IS NOT NULL
    ),
    their_roles AS (
        SELECT ur.user_id, ur.role_id
          FROM public.user_roles ur
          JOIN ch ON ch.server_id = ur.server_id
    ),
    role_mask AS (
        SELECT tr.user_id, bit_or(sr.permissions) AS mask
          FROM their_roles tr
          JOIN public.server_roles sr ON sr.id = tr.role_id
         GROUP BY tr.user_id
    ),
    mask AS (
        SELECT m.user_id, ch.everyone_mask | COALESCE(rm.mask, 0) AS mask
          FROM mem m
         CROSS JOIN ch
          LEFT JOIN role_mask rm ON rm.user_id = m.user_id
    ),
    ov AS (
        SELECT o.user_id, o.role_id,
               COALESCE(o.allow_permissions, 0) AS allow_p,
               COALESCE(o.deny_permissions, 0) AS deny_p
          FROM public.channel_permission_overrides o
          JOIN ch ON ch.id = o.channel_id
    ),
    -- Layer of an override row for a member, as get_user_permissions() assigns it: the
    -- member's own row is 3, then an @everyone row is 1, then a row of a role they hold is 2.
    layered AS (
        SELECT ov.user_id, 3 AS layer, ov.allow_p, ov.deny_p
          FROM ov JOIN mem m ON m.user_id = ov.user_id
        UNION ALL
        SELECT m.user_id, 1, ov.allow_p, ov.deny_p
          FROM ov CROSS JOIN ch CROSS JOIN mem m
         WHERE ov.role_id = ch.everyone_id
           AND ov.user_id IS DISTINCT FROM m.user_id
        UNION ALL
        SELECT tr.user_id, 2, ov.allow_p, ov.deny_p
          FROM ov CROSS JOIN ch
          JOIN their_roles tr ON tr.role_id = ov.role_id
          JOIN mem m ON m.user_id = tr.user_id
         WHERE ov.role_id IS DISTINCT FROM ch.everyone_id
           AND ov.user_id IS DISTINCT FROM tr.user_id
    ),
    ovr AS (
        SELECT l.user_id,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 1), 0) AS everyone_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 1), 0) AS everyone_deny,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 2), 0) AS role_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 2), 0) AS role_deny,
               COALESCE(bit_or(l.allow_p) FILTER (WHERE l.layer = 3), 0) AS user_allow,
               COALESCE(bit_or(l.deny_p)  FILTER (WHERE l.layer = 3), 0) AS user_deny
          FROM layered l
         GROUP BY l.user_id
    )
    SELECT mk.user_id
      FROM mask mk
     CROSS JOIN ch
      LEFT JOIN ovr ON ovr.user_id = mk.user_id
     WHERE mk.user_id = ch.owner
        OR (mk.mask & 1) <> 0
        OR ((((((((mk.mask & ~COALESCE(ovr.everyone_deny, 0)) | COALESCE(ovr.everyone_allow, 0))
                  & ~COALESCE(ovr.role_deny, 0)) | COALESCE(ovr.role_allow, 0))
                  & ~COALESCE(ovr.user_deny, 0)) | COALESCE(ovr.user_allow, 0)) & 2) <> 0);
END;
$$;

-- get_today_summary(): conversation and channel counts from one get_unread_counts() call; a
-- channel's last_activity is its last message.
CREATE OR REPLACE FUNCTION public.get_today_summary(p_since timestamp with time zone DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_auth uuid := auth.uid();
    v_now timestamptz := now();
    v_recent timestamptz := now() - interval '14 days';
    v_since timestamptz;
    v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_mentions jsonb;
    v_mentions_unread bigint;
    v_conversations jsonb;
    v_conversation_count bigint;
    v_dm_messages bigint;
    v_servers jsonb;
    v_server_count bigint;
    v_channel_count bigint;
    v_channel_messages bigint;
    v_unread_mentions bigint;
    v_threads jsonb;
    v_thread_count bigint;
    v_voice jsonb;
    v_follow_requests jsonb;
    v_follow_request_count bigint;
    v_new_followers jsonb;
    v_new_follower_count bigint;
    v_social_counts jsonb;
    v_social_items jsonb;
    v_posts jsonb;
    v_announcements jsonb;
    v_announcement_count bigint;
    v_unread jsonb;
BEGIN
    IF v_me IS NULL THEN
        RETURN NULL;
    END IF;

    -- Both sections below read it; one evaluation.
    SELECT COALESCE(jsonb_agg(to_jsonb(g)), '[]'::jsonb) INTO v_unread FROM public.get_unread_counts() g;

    v_since := least(greatest(coalesce(p_since, v_now - interval '1 day'), v_now - interval '7 days'),
                     v_now - interval '12 hours');

    -- Mentions and replies ------------------------------------------------------------------
    -- Candidates are the newest 60 of each kind; the list keeps 20 after visibility, deletion
    -- and blocks narrow them.
    WITH mention_hits AS (
        SELECT n.data->>'message_id' AS ref, coalesce(n.is_read, false) AS is_read
          FROM public.notifications n
         WHERE n.user_id = v_me
           AND n.type = 'mention'
           AND n.created_at > v_recent
         ORDER BY n.created_at DESC
         LIMIT 60
    ),
    reply_hits AS (
        SELECT r.id
          FROM public.messages mine
          JOIN public.messages r ON r.reply_to = mine.id
         WHERE mine.user_id = v_me
           AND mine.created_at > v_recent
           AND r.created_at > v_recent
           AND r.user_id IS DISTINCT FROM v_me
         ORDER BY r.created_at DESC
         LIMIT 60
    ),
    hits AS (
        SELECT CASE WHEN mh.ref ~* v_uuid THEN mh.ref::uuid END AS message_id,
               'mention'::text AS kind, mh.is_read
          FROM mention_hits mh
        UNION ALL
        SELECT rh.id, 'reply', false FROM reply_hits rh
    ),
    per_message AS (
        SELECT h.message_id,
               CASE WHEN bool_or(h.kind = 'mention') THEN 'mention' ELSE 'reply' END AS kind,
               bool_and(h.is_read) AS is_read
          FROM hits h
         WHERE h.message_id IS NOT NULL
         GROUP BY h.message_id
    ),
    picked AS (
        SELECT p.kind, p.is_read, m.*
          FROM per_message p
          JOIN public.messages m ON m.id = p.message_id
         WHERE (m.is_deleted IS NULL OR m.is_deleted = false)
           AND (m.user_id IS NULL OR m.user_id NOT IN (SELECT public.current_user_block_peer_ids()))
         ORDER BY m.created_at DESC
         LIMIT 20
    ),
    shaped AS (
        SELECT k.created_at,
               NOT k.is_read AND k.created_at >= coalesce(rd.last_read_at, '-infinity'::timestamptz) AS unread,
               jsonb_build_object(
                   'kind', k.kind,
                   'unread', NOT k.is_read AND k.created_at >= coalesce(rd.last_read_at, '-infinity'::timestamptz),
                   'message', jsonb_build_object(
                       'id', k.id,
                       'channel_id', k.channel_id,
                       'conversation_id', k.conversation_id,
                       'thread_id', k.thread_id,
                       'user_id', k.user_id,
                       'bot_id', k.bot_id,
                       'content', k.content,
                       'encrypted', coalesce(k.encrypted, false),
                       'encryption_metadata', k.encryption_metadata,
                       'metadata', k.metadata,
                       'created_at', k.created_at),
                   'server', CASE WHEN s.id IS NULL THEN NULL
                                  ELSE jsonb_build_object('id', s.id, 'name', s.name, 'icon', s.icon) END,
                   'channel_name', c.name,
                   'thread_name', t.name,
                   'conversation', CASE WHEN cv.id IS NULL THEN NULL
                                        ELSE jsonb_build_object('id', cv.id, 'type', coalesce(cv.type, 'direct'),
                                                                'name', cv.name) END,
                   'author', CASE WHEN au.id IS NULL THEN NULL
                                  ELSE jsonb_build_object('id', au.id, 'username', au.username,
                                                          'display_name', au.display_name,
                                                          'avatar_url', au.avatar_url, 'domain', au.domain,
                                                          'is_local', au.is_local) END
               ) AS entry
          FROM picked k
          LEFT JOIN public.profiles au ON au.id = k.user_id
          LEFT JOIN public.channels c ON c.id = k.channel_id
          LEFT JOIN public.servers s ON s.id = c.server_id
          LEFT JOIN public.threads t ON t.id = k.thread_id
          LEFT JOIN public.conversations cv ON cv.id = k.conversation_id
          LEFT JOIN LATERAL (
              SELECT u.last_read_at
                FROM public.unread_counts u
               WHERE u.user_id = v_me
                 AND ((k.channel_id IS NOT NULL AND u.channel_id = k.channel_id)
                      OR (k.channel_id IS NULL AND u.conversation_id = k.conversation_id))
               LIMIT 1
          ) rd ON true
    )
    SELECT coalesce(jsonb_agg(sh.entry ORDER BY sh.created_at DESC), '[]'::jsonb),
           count(*) FILTER (WHERE sh.unread)
      INTO v_mentions, v_mentions_unread
      FROM shaped sh;

    -- Conversations -------------------------------------------------------------------------
    WITH unread AS (
        SELECT u.conversation_id, u.unread_messages, u.unread_mentions, cp.hidden_at
          FROM jsonb_to_recordset(v_unread) AS u(conversation_id uuid, unread_messages integer, unread_mentions integer)
          JOIN public.conversation_participants cp
            ON cp.conversation_id = u.conversation_id
           AND cp.user_id = v_me
           AND cp.left_at IS NULL
         WHERE u.conversation_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM public.notification_channels nc
                WHERE nc.user_id = v_me
                  AND nc.conversation_id = u.conversation_id
                  AND nc.channel_id IS NULL
                  AND nc.muted = true
                  AND (nc.muted_until IS NULL OR nc.muted_until > v_now))
    ),
    latest AS (
        SELECT un.*, lm.id AS last_id, lm.user_id AS last_user_id, lm.bot_id AS last_bot_id,
               lm.content AS last_content, lm.encrypted AS last_encrypted,
               lm.encryption_metadata AS last_encryption_metadata, lm.metadata AS last_metadata,
               lm.created_at AS last_at
          FROM unread un
          LEFT JOIN LATERAL (
              SELECT m.id, m.user_id, m.bot_id, m.content, m.encrypted, m.encryption_metadata,
                     m.metadata, m.created_at
                FROM public.messages m
               WHERE m.conversation_id = un.conversation_id
                 AND m.thread_id IS NULL
                 AND (m.is_deleted IS NULL OR m.is_deleted = false)
               ORDER BY m.created_at DESC
               LIMIT 1
          ) lm ON true
         WHERE un.hidden_at IS NULL OR lm.created_at > un.hidden_at
    ),
    top AS (
        SELECT l.* FROM latest l ORDER BY l.last_at DESC NULLS LAST LIMIT 8
    )
    SELECT (SELECT count(*) FROM latest),
           (SELECT coalesce(sum(l.unread_messages), 0) FROM latest l),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', cv.id,
               'type', coalesce(cv.type, 'direct'),
               'name', cv.name,
               'icon_url', CASE WHEN cv.type = 'group' THEN cv.metadata->>'icon_url' END,
               'unread_messages', coalesce(tp.unread_messages, 0),
               'unread_mentions', coalesce(tp.unread_mentions, 0),
               'participant_count', coalesce(op.total, 0) + 1,
               'participants', coalesce(op.people, '[]'::jsonb),
               'last_message', CASE WHEN tp.last_id IS NULL THEN NULL ELSE jsonb_build_object(
                   'id', tp.last_id,
                   'conversation_id', cv.id,
                   'user_id', tp.last_user_id,
                   'bot_id', tp.last_bot_id,
                   'content', tp.last_content,
                   'encrypted', coalesce(tp.last_encrypted, false),
                   'encryption_metadata', tp.last_encryption_metadata,
                   'metadata', tp.last_metadata,
                   'created_at', tp.last_at) END
           ) ORDER BY tp.last_at DESC NULLS LAST), '[]'::jsonb)
      INTO v_conversation_count, v_dm_messages, v_conversations
      FROM top tp
      JOIN public.conversations cv ON cv.id = tp.conversation_id
      LEFT JOIN LATERAL (
          SELECT count(*) AS total,
                 jsonb_agg(jsonb_build_object(
                     'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
                     'avatar_url', pr.avatar_url, 'domain', pr.domain, 'is_local', pr.is_local)
                     ORDER BY o.joined_at) FILTER (WHERE o.rn <= 4) AS people
            FROM (
                SELECT cp2.user_id, cp2.joined_at, row_number() OVER (ORDER BY cp2.joined_at) AS rn
                  FROM public.conversation_participants cp2
                 WHERE cp2.conversation_id = tp.conversation_id
                   AND cp2.user_id <> v_me
                   AND cp2.left_at IS NULL
            ) o
            JOIN public.profiles pr ON pr.id = o.user_id
      ) op ON true;

    -- Unread channels by server -------------------------------------------------------------
    WITH rows AS (
        SELECT c.server_id, c.id AS channel_id, c.name, c.type, u.unread_messages, u.unread_mentions,
               u.last_message_at AS updated_at
          FROM jsonb_to_recordset(v_unread)
               AS u(channel_id uuid, unread_messages integer, unread_mentions integer, last_message_at timestamptz)
          JOIN public.channels c ON c.id = u.channel_id
         WHERE u.channel_id IS NOT NULL
           AND c.server_id IS NOT NULL
    ),
    per_server AS (
        SELECT r.server_id,
               sum(r.unread_messages) AS unread_messages,
               sum(r.unread_mentions) AS unread_mentions,
               count(*) AS channel_count,
               max(r.updated_at) AS last_activity
          FROM rows r
         GROUP BY r.server_id
    ),
    top AS (
        SELECT ps.* FROM per_server ps
         ORDER BY ps.unread_mentions DESC, ps.last_activity DESC NULLS LAST
         LIMIT 20
    )
    SELECT (SELECT count(*) FROM per_server),
           (SELECT coalesce(sum(ps.channel_count), 0) FROM per_server ps),
           (SELECT coalesce(sum(ps.unread_messages), 0) FROM per_server ps),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id,
               'name', s.name,
               'icon', s.icon,
               'unread_messages', tp.unread_messages,
               'unread_mentions', tp.unread_mentions,
               'channel_count', tp.channel_count,
               'last_activity', tp.last_activity,
               'channels', (
                   SELECT jsonb_agg(jsonb_build_object(
                              'id', ch.channel_id, 'name', ch.name, 'type', ch.type,
                              'unread_messages', ch.unread_messages,
                              'unread_mentions', ch.unread_mentions)
                              ORDER BY ch.unread_mentions DESC, ch.unread_messages DESC, ch.channel_id)
                     FROM (SELECT r.* FROM rows r
                            WHERE r.server_id = tp.server_id
                            ORDER BY r.unread_mentions DESC, r.unread_messages DESC, r.channel_id
                            LIMIT 12) ch)
           ) ORDER BY tp.unread_mentions DESC, tp.last_activity DESC NULLS LAST), '[]'::jsonb)
      INTO v_server_count, v_channel_count, v_channel_messages, v_servers
      FROM top tp
      JOIN public.servers s ON s.id = tp.server_id;

    SELECT coalesce(sum(u.unread_mentions), 0)
      INTO v_unread_mentions
      FROM public.unread_counts u
     WHERE u.user_id = v_me
       AND u.unread_mentions > 0
       AND ((u.channel_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.channels c WHERE c.id = u.channel_id))
            OR (u.channel_id IS NULL AND u.conversation_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.conversation_participants cp
                 WHERE cp.conversation_id = u.conversation_id
                   AND cp.user_id = v_me
                   AND cp.left_at IS NULL)));

    -- Threads -------------------------------------------------------------------------------
    -- A thread qualifies when its last message is newer than the caller's read position, join
    -- or last post there. Reply counts and repliers are computed for the 20 listed only.
    -- MATERIALIZED: inlined, the last-post subquery ran once per reference to `mine`.
    WITH mine AS MATERIALIZED (
        SELECT t.id, t.name, t.channel_id, t.last_message_at,
               greatest(tm.last_read_at, tm.joined_at,
                        (SELECT m.created_at FROM public.messages m
                          WHERE m.thread_id = t.id AND m.user_id = v_me
                          ORDER BY m.created_at DESC
                          LIMIT 1)) AS seen_at
          FROM public.thread_members tm
          JOIN public.threads t ON t.id = tm.thread_id
         WHERE tm.user_id = v_me
           AND coalesce(tm.muted, false) = false
           AND coalesce(t.archived, false) = false
           AND t.last_message_at > v_recent
    ),
    fresh AS MATERIALIZED (
        SELECT mi.* FROM mine mi WHERE mi.last_message_at > mi.seen_at
    ),
    top AS (
        SELECT f.*, nr.new_replies, nr.last_reply_at, nr.repliers
          FROM (SELECT * FROM fresh ORDER BY last_message_at DESC LIMIT 20) f
          CROSS JOIN LATERAL (
              SELECT count(*) AS new_replies,
                     max(x.created_at) AS last_reply_at,
                     (SELECT array_agg(y.user_id ORDER BY y.at DESC)
                        FROM (SELECT z.user_id, max(z.created_at) AS at
                                FROM public.messages z
                               WHERE z.thread_id = f.id
                                 AND z.created_at > f.seen_at
                                 AND z.user_id IS NOT NULL
                                 AND z.user_id <> v_me
                                 AND (z.is_deleted IS NULL OR z.is_deleted = false)
                               GROUP BY z.user_id
                               ORDER BY max(z.created_at) DESC
                               LIMIT 3) y) AS repliers
                FROM public.messages x
               WHERE x.thread_id = f.id
                 AND x.created_at > f.seen_at
                 AND x.user_id IS DISTINCT FROM v_me
                 AND (x.is_deleted IS NULL OR x.is_deleted = false)
          ) nr
         WHERE nr.new_replies > 0
    )
    SELECT (SELECT count(*) FROM fresh),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', tp.id,
               'name', tp.name,
               'channel_id', tp.channel_id,
               'channel_name', c.name,
               'server', jsonb_build_object('id', s.id, 'name', s.name, 'icon', s.icon),
               'new_replies', tp.new_replies,
               'last_reply_at', tp.last_reply_at,
               'repliers', coalesce((
                   SELECT jsonb_agg(jsonb_build_object(
                              'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
                              'avatar_url', pr.avatar_url)
                              ORDER BY u.ord)
                     FROM unnest(tp.repliers) WITH ORDINALITY u(id, ord)
                     JOIN public.profiles pr ON pr.id = u.id), '[]'::jsonb)
           ) ORDER BY tp.last_reply_at DESC), '[]'::jsonb)
      INTO v_thread_count, v_threads
      FROM top tp
      JOIN public.channels c ON c.id = tp.channel_id
      JOIN public.servers s ON s.id = c.server_id;

    -- Voice ---------------------------------------------------------------------------------
    WITH live AS (
        SELECT v.channel_id, v.user_id, v.joined_at,
               row_number() OVER (PARTITION BY v.channel_id ORDER BY v.joined_at) AS rn
          FROM public.voice_channel_participants v
          JOIN public.channels c ON c.id = v.channel_id
         WHERE v.joined_at > v_now - interval '12 hours'
    ),
    per_channel AS (
        SELECT l.channel_id,
               count(*) AS participant_count,
               min(l.joined_at) AS started_at,
               bool_or(l.user_id = v_me) AS includes_me,
               jsonb_agg(jsonb_build_object(
                   'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
                   'avatar_url', pr.avatar_url)
                   ORDER BY l.joined_at) FILTER (WHERE l.rn <= 6) AS participants
          FROM live l
          JOIN public.profiles pr ON pr.id = l.user_id
         GROUP BY l.channel_id
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'channel_id', c.id,
               'channel_name', c.name,
               'server', jsonb_build_object('id', s.id, 'name', s.name, 'icon', s.icon,
                                            'is_local', coalesce(s.is_local_server, true)),
               'participant_count', pc.participant_count,
               'started_at', pc.started_at,
               'includes_me', pc.includes_me,
               'participants', coalesce(pc.participants, '[]'::jsonb)
           ) ORDER BY pc.includes_me DESC, pc.participant_count DESC, pc.started_at), '[]'::jsonb)
      INTO v_voice
      FROM (SELECT * FROM per_channel ORDER BY includes_me DESC, participant_count DESC, started_at
             LIMIT 12) pc
      JOIN public.channels c ON c.id = pc.channel_id
      JOIN public.servers s ON s.id = c.server_id;

    -- Follows -------------------------------------------------------------------------------
    SELECT count(*),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
               'avatar_url', pr.avatar_url, 'domain', pr.domain, 'is_local', pr.is_local,
               'requested_at', f.created_at)
               ORDER BY f.created_at DESC) FILTER (WHERE f.rn <= 5), '[]'::jsonb)
      INTO v_follow_request_count, v_follow_requests
      FROM (SELECT fo.follower_id, fo.created_at,
                   row_number() OVER (ORDER BY fo.created_at DESC) AS rn
              FROM public.follows fo
             WHERE fo.following_id = v_me
               AND fo.status = 'pending') f
      JOIN public.profiles pr ON pr.id = f.follower_id;

    SELECT count(*),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
               'avatar_url', pr.avatar_url, 'domain', pr.domain, 'is_local', pr.is_local,
               'followed_at', f.at)
               ORDER BY f.at DESC) FILTER (WHERE f.rn <= 8), '[]'::jsonb)
      INTO v_new_follower_count, v_new_followers
      FROM (SELECT fo.follower_id, coalesce(fo.accepted_at, fo.created_at) AS at,
                   row_number() OVER (ORDER BY coalesce(fo.accepted_at, fo.created_at) DESC) AS rn
              FROM public.follows fo
             WHERE fo.following_id = v_me
               AND fo.status = 'accepted'
               AND coalesce(fo.accepted_at, fo.created_at) > v_since) f
      JOIN public.profiles pr ON pr.id = f.follower_id;

    -- Social notifications ------------------------------------------------------------------
    SELECT coalesce(jsonb_object_agg(x.type, x.n), '{}'::jsonb)
      INTO v_social_counts
      FROM (SELECT n.type, count(*) AS n
              FROM public.notifications n
             WHERE n.user_id = v_me
               AND n.is_read = false
               AND n.type IN ('activitypub_mention', 'activitypub_reply', 'activitypub_favorite',
                              'activitypub_reblog', 'activitypub_reaction', 'activitypub_follow')
               AND n.created_at > v_recent
             GROUP BY n.type) x;

    WITH items AS (
        SELECT n.id, n.type, n.created_at,
               CASE WHEN n.data->>'post_id' ~* v_uuid THEN (n.data->>'post_id')::uuid END AS post_id
          FROM public.notifications n
         WHERE n.user_id = v_me
           AND n.is_read = false
           AND n.type IN ('activitypub_mention', 'activitypub_reply')
           AND n.created_at > v_recent
         ORDER BY n.created_at DESC
         LIMIT 10
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'notification_id', i.id,
               'type', i.type,
               'created_at', i.created_at,
               'post', jsonb_build_object(
                   'id', p.id, 'content', p.content, 'content_warning', p.content_warning,
                   'is_sensitive', coalesce(p.is_sensitive, false), 'created_at', p.created_at),
               'author', jsonb_build_object(
                   'id', a.id, 'username', a.username, 'display_name', a.display_name,
                   'avatar_url', a.avatar_url, 'domain', a.domain, 'is_local', a.is_local)
           ) ORDER BY i.created_at DESC), '[]'::jsonb)
      INTO v_social_items
      FROM (SELECT * FROM items LIMIT 5) i
      JOIN public.posts p ON p.id = i.post_id AND coalesce(p.is_deleted, false) = false
      JOIN public.profiles a ON a.id = p.author_id;

    -- Posts from followed accounts ----------------------------------------------------------
    SELECT coalesce(jsonb_agg(jsonb_build_object(
               'id', r.id,
               'created_at', r.created_at,
               'content', r.content,
               'content_warning', r.content_warning,
               'is_sensitive', coalesce(r.is_sensitive, false),
               'media_count', jsonb_array_length(coalesce(r.media_attachments, '[]'::jsonb)),
               'replies_count', coalesce(r.replies_count, 0),
               'reblogs_count', coalesce(r.reblogs_count, 0),
               'favorites_count', coalesce(r.favorites_count, 0),
               'author', jsonb_build_object(
                   'id', a.id, 'username', a.username, 'display_name', a.display_name,
                   'avatar_url', a.avatar_url, 'domain', a.domain, 'is_local', a.is_local)
           ) ORDER BY r.score DESC), '[]'::jsonb)
      INTO v_posts
      FROM (
          -- float8 throughout: numeric power() cost 13 us a row.
          SELECT p.*,
                 (power(greatest(coalesce(p.replies_count, 0), 0)::float8, 0.9::float8) * 3
                  + power(greatest(coalesce(p.reblogs_count, 0), 0)::float8, 0.8::float8) * 2
                  + power(greatest(coalesce(p.favorites_count, 0), 0)::float8, 0.7::float8)
                  + 0.1)
                 * power(0.5::float8, extract(epoch FROM v_now - p.created_at)::float8 / 64800.0) AS score
            FROM public.posts p
            JOIN public.follows f
              ON f.following_id = p.author_id
             AND f.follower_id = v_me
             AND f.status = 'accepted'
           WHERE p.created_at > v_since
             AND p.in_reply_to IS NULL
             AND p.reblog IS NULL
             AND coalesce(p.is_deleted, false) = false
             AND p.visibility IN ('public', 'unlisted', 'followers')
           ORDER BY score DESC
           LIMIT 5
      ) r
      JOIN public.profiles a ON a.id = r.author_id;

    -- Instance announcements ----------------------------------------------------------------
    WITH unread AS (
        SELECT a.*
          FROM public.instance_announcements a
         WHERE a.is_active = true
           AND a.starts_at <= v_now
           AND (a.ends_at IS NULL OR a.ends_at > v_now)
           AND (a.is_pinned = true
                OR a.starts_at >= (SELECT pr.created_at FROM public.profiles pr WHERE pr.id = v_me))
           AND NOT EXISTS (SELECT 1 FROM public.announcement_reads ar
                            WHERE ar.announcement_id = a.id AND ar.user_id = v_auth)
    )
    SELECT (SELECT count(*) FROM unread),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', t.id, 'title', t.title, 'content', t.content, 'icon', t.icon,
               'image_url', t.image_url, 'is_pinned', coalesce(t.is_pinned, false),
               'created_at', t.created_at)
               ORDER BY t.is_pinned DESC, t.display_order, t.created_at DESC), '[]'::jsonb)
      INTO v_announcement_count, v_announcements
      FROM (SELECT u.* FROM unread u
             ORDER BY u.is_pinned DESC, u.display_order, u.created_at DESC
             LIMIT 3) t;

    RETURN jsonb_build_object(
        'generated_at', v_now,
        'since', v_since,
        'mentions', v_mentions,
        'conversations', v_conversations,
        'servers', v_servers,
        'threads', v_threads,
        'voice', v_voice,
        'follow_requests', v_follow_requests,
        'new_followers', v_new_followers,
        'social', jsonb_build_object('unread', v_social_counts, 'items', v_social_items),
        'followed_posts', v_posts,
        'announcements', v_announcements,
        'totals', jsonb_build_object(
            'unread_mentions', v_unread_mentions,
            'mentions_unread', v_mentions_unread,
            'conversations', v_conversation_count,
            'dm_messages', v_dm_messages,
            'servers', v_server_count,
            'channels', v_channel_count,
            'channel_messages', v_channel_messages,
            'threads', v_thread_count,
            'follow_requests', v_follow_request_count,
            'new_followers', v_new_follower_count,
            'announcements', v_announcement_count));
END;
$$;

REVOKE ALL ON FUNCTION public.get_today_summary(timestamp with time zone) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_today_summary(timestamp with time zone) TO authenticated;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('unread_change_payload', 'handle_new_message_unread',
                             'handle_new_dm_unread', 'increment_unread_mentions',
                             'broadcast_unread_count_event', 'reset_unread_on_join',
                             'sync_unread_mute', 'track_unread_mute', 'channel_viewer_ids')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.get_unread_counts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_channel_as_read(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_conversation_as_read(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_server_as_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unread_counts() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_channel_as_read(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_conversation_as_read(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_server_as_read(uuid) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
