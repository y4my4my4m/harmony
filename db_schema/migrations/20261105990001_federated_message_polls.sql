-- Chat message polls over federation.
--
-- One instance holds a poll's tally: the server's host for a poll in a channel, the author's
-- instance for a poll in a direct message. Every other instance with the message holds a copy
-- of the poll: message_polls.remote is true, remote_voters and message_poll_options.remote_votes
-- carry the counts the holder last sent, and message_poll_votes holds only the answers of this
-- instance's voters. message_polls.ap_id is the poll's ActivityPub id, the id of its message's
-- Note, when that is not this instance's /messages/<message uuid>.
--
-- A vote on a copy is final, as on Mastodon and as on remote social polls
-- (20261022100001_remote_poll_votes.sql): ActivityPub carries no retraction of a vote. It adds
-- to the stored counts at once; the holder's next count update replaces them. A poll posted in
-- a channel of a server hosted elsewhere is a copy from the start and the host takes its tally;
-- create_message_poll refuses one when the host does not federate polls
-- (servers.federation_metadata.message_polls, from the Group's harmony:polls).
--
-- message_poll_outbox is what the federation backend still has to send, one row per poll, kind
-- and voter: 'vote' (a voter's answers on a copy, to the holder), 'end' (the author ends a copy
-- held by the server's host), 'state' (the holder's counts and end, to every instance with a
-- copy). queue_message_poll_federation writes the row and queues the job
-- 'federate-message-poll'; the backend deletes the row once sent, and the worker's sweep
-- requeues rows left behind. A repeated 'state' row moves its queued_at, so a send that read the
-- counts before the change leaves the row for the next one.
--
-- The service role writes the federated side: store_federated_message_poll (a poll arriving in a
-- Note), apply_federated_message_poll_state (the holder's counts), record_federated_message_poll_vote
-- (a voter of another instance on a poll held here; one answer per call, as ActivityPub sends
-- them), end_federated_message_poll (the author, on another instance, ends a poll held here) and
-- message_poll_federation_state (polls as sent). Voters are never sent: only counts leave the
-- holder, as get_message_polls shows only counts and the caller's own answers.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.message_polls ADD COLUMN IF NOT EXISTS remote boolean DEFAULT false NOT NULL;
ALTER TABLE public.message_polls ADD COLUMN IF NOT EXISTS ap_id text;
ALTER TABLE public.message_polls ADD COLUMN IF NOT EXISTS remote_voters integer DEFAULT 0 NOT NULL;
ALTER TABLE public.message_poll_options ADD COLUMN IF NOT EXISTS remote_votes integer DEFAULT 0 NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_polls_remote_voters_check') THEN
        ALTER TABLE public.message_polls
            ADD CONSTRAINT message_polls_remote_voters_check CHECK (remote_voters >= 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_poll_options_remote_votes_check') THEN
        ALTER TABLE public.message_poll_options
            ADD CONSTRAINT message_poll_options_remote_votes_check CHECK (remote_votes >= 0);
    END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS message_polls_ap_id_key ON public.message_polls (ap_id) WHERE ap_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.message_poll_outbox (
    poll_id uuid NOT NULL REFERENCES public.message_polls(id) ON DELETE CASCADE,
    kind text NOT NULL,
    user_id uuid,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_poll_outbox_kind_check CHECK (kind IN ('vote', 'end', 'state')),
    CONSTRAINT message_poll_outbox_key UNIQUE NULLS NOT DISTINCT (poll_id, kind, user_id)
);

CREATE INDEX IF NOT EXISTS message_poll_outbox_queued_idx ON public.message_poll_outbox (queued_at);

REVOKE ALL ON public.message_poll_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.message_poll_outbox TO service_role;
ALTER TABLE public.message_poll_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_poll_outbox_service_role ON public.message_poll_outbox;
CREATE POLICY message_poll_outbox_service_role ON public.message_poll_outbox
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Queue
-- ---------------------------------------------------------------------------

-- 'state' for a poll held here whose message reaches another instance: a channel of a local,
-- federated server with a member from another instance, or a direct message with a participant
-- from another instance. 'vote' and 'end' for a copy. Anything else queues nothing.
CREATE OR REPLACE FUNCTION public.queue_message_poll_federation(p_poll_id uuid, p_kind text, p_user_id uuid DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_go boolean;
BEGIN
    IF p_kind = 'state' THEN
        SELECT CASE
                 WHEN p.remote THEN false
                 WHEN m.channel_id IS NOT NULL THEN EXISTS (
                     SELECT 1
                       FROM public.channels c
                       JOIN public.servers s ON s.id = c.server_id
                      WHERE c.id = m.channel_id
                        AND s.is_local_server IS NOT FALSE
                        AND s.federation_enabled IS TRUE
                        AND EXISTS (
                            SELECT 1 FROM public.user_servers us
                              JOIN public.profiles pr ON pr.id = us.user_id
                             WHERE us.server_id = s.id
                               AND us.status = 'accepted'
                               AND pr.is_local IS FALSE))
                 ELSE EXISTS (
                     SELECT 1 FROM public.conversation_participants cp
                       JOIN public.profiles pr ON pr.id = cp.user_id
                      WHERE cp.conversation_id = m.conversation_id
                        AND cp.left_at IS NULL
                        AND pr.is_local IS FALSE)
               END
          INTO v_go
          FROM public.message_polls p
          JOIN public.messages m ON m.id = p.message_id
         WHERE p.id = p_poll_id;
    ELSIF p_kind IN ('vote', 'end') THEN
        SELECT p.remote INTO v_go FROM public.message_polls p WHERE p.id = p_poll_id;
    END IF;

    IF v_go IS NOT TRUE THEN
        RETURN;
    END IF;

    INSERT INTO public.message_poll_outbox AS o (poll_id, kind, user_id)
    VALUES (p_poll_id, p_kind, p_user_id)
    ON CONFLICT ON CONSTRAINT message_poll_outbox_key DO UPDATE SET queued_at = now();

    PERFORM public.queue_federation_job(
        'federate-message-poll',
        jsonb_build_object('type', 'update', 'poll_id', p_poll_id, 'kind', p_kind, 'user_id', p_user_id));
END;
$$;

REVOKE ALL ON FUNCTION public.queue_message_poll_federation(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_message_poll_federation(uuid, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.vote_message_poll(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.end_message_poll(uuid);
DROP FUNCTION IF EXISTS public.get_message_polls(uuid[]);

-- As 20261017100001 (get_message_polls). A copy reads the holder's counts; `remote` names one,
-- whose votes are final.
CREATE FUNCTION public.get_message_polls(p_poll_ids uuid[])
RETURNS TABLE(poll_id uuid, message_id uuid, question text, allow_multiple boolean,
              expires_at timestamp with time zone, closed boolean, total_voters integer,
              options jsonb, my_option_ids uuid[], is_author boolean, remote boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH me AS (SELECT public.get_current_profile_id() AS id,
                       public.current_user_history_cutoffs() AS cutoffs)
    SELECT p.id,
           p.message_id,
           p.question,
           p.allow_multiple,
           p.expires_at,
           p.expires_at IS NOT NULL AND p.expires_at <= now(),
           CASE WHEN p.remote THEN p.remote_voters
                ELSE (SELECT count(DISTINCT v.user_id)::integer
                        FROM public.message_poll_votes v WHERE v.poll_id = p.id) END,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'id', o.id,
                       'position', o."position",
                       'text', o.text,
                       'votes', CASE WHEN p.remote THEN o.remote_votes
                                     ELSE (SELECT count(*)::integer FROM public.message_poll_votes v
                                            WHERE v.poll_id = p.id AND v.option_id = o.id) END)
                       ORDER BY o."position"), '[]'::jsonb)
              FROM public.message_poll_options o WHERE o.poll_id = p.id),
           COALESCE((SELECT array_agg(v.option_id ORDER BY v.option_id)
                       FROM public.message_poll_votes v
                      WHERE v.poll_id = p.id AND v.user_id = me.id), '{}'::uuid[]),
           m.user_id IS NOT DISTINCT FROM me.id,
           p.remote
      FROM me
      JOIN public.message_polls p ON p.id = ANY (p_poll_ids[1:100])
      JOIN public.messages m ON m.id = p.message_id
     WHERE me.id IS NOT NULL
       AND m.is_deleted IS NOT TRUE
       AND ((m.channel_id IS NOT NULL AND public.can_view_channel(me.id, m.channel_id)
             AND (m.created_at >= COALESCE((me.cutoffs ->> m.channel_id::text)::timestamptz, '-infinity'::timestamptz)
                  OR m.user_id = me.id))
            OR (m.conversation_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = m.conversation_id
                       AND cp.user_id = me.id
                       AND cp.left_at IS NULL)));
$$;

REVOKE ALL ON FUNCTION public.get_message_polls(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_polls(uuid[]) TO authenticated, service_role;

-- Polls of messages as the federation backend sends them: counts of the voters here for a poll
-- held here, the holder's counts for a copy. options: [{position, text, votes}].
CREATE OR REPLACE FUNCTION public.message_poll_federation_state(p_message_ids uuid[])
RETURNS TABLE(message_id uuid, poll_id uuid, question text, allow_multiple boolean,
              expires_at timestamp with time zone, remote boolean, ap_id text, voters integer,
              options jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p.message_id,
           p.id,
           p.question,
           p.allow_multiple,
           p.expires_at,
           p.remote,
           p.ap_id,
           CASE WHEN p.remote THEN p.remote_voters
                ELSE (SELECT count(DISTINCT v.user_id)::integer
                        FROM public.message_poll_votes v WHERE v.poll_id = p.id) END,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'position', o."position",
                       'text', o.text,
                       'votes', CASE WHEN p.remote THEN o.remote_votes
                                     ELSE (SELECT count(*)::integer FROM public.message_poll_votes v
                                            WHERE v.poll_id = p.id AND v.option_id = o.id) END)
                       ORDER BY o."position"), '[]'::jsonb)
              FROM public.message_poll_options o WHERE o.poll_id = p.id)
      FROM public.message_polls p
     WHERE p.message_id = ANY (p_message_ids[1:500]);
$$;

REVOKE ALL ON FUNCTION public.message_poll_federation_state(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.message_poll_federation_state(uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

-- As 20261010700001 (broadcast_message_poll_event); a copy broadcasts the holder's counts.
CREATE OR REPLACE FUNCTION public.broadcast_message_poll_event(p_poll_id uuid, p_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_message_id uuid;
    v_channel_id uuid;
    v_conversation_id uuid;
    v_expires_at timestamptz;
    v_remote boolean;
    v_topic text;
BEGIN
    SELECT p.message_id, m.channel_id, m.conversation_id, p.expires_at, p.remote
      INTO v_message_id, v_channel_id, v_conversation_id, v_expires_at, v_remote
      FROM public.message_polls p
      JOIN public.messages m ON m.id = p.message_id
     WHERE p.id = p_poll_id;

    IF v_conversation_id IS NOT NULL THEN
        v_topic := 'dm-conversation-' || v_conversation_id::text;
    ELSIF v_channel_id IS NOT NULL THEN
        v_topic := 'channel-messages-' || v_channel_id::text;
    ELSE
        RETURN;
    END IF;

    PERFORM realtime.send(
        jsonb_build_object(
            'type', p_type,
            'poll_id', p_poll_id,
            'message_id', v_message_id,
            'expires_at', v_expires_at,
            'total_voters', CASE WHEN v_remote
                                 THEN (SELECT p.remote_voters FROM public.message_polls p WHERE p.id = p_poll_id)
                                 ELSE (SELECT count(DISTINCT v.user_id)
                                         FROM public.message_poll_votes v WHERE v.poll_id = p_poll_id) END,
            'options', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                   'id', o.id,
                                   'votes', CASE WHEN v_remote THEN o.remote_votes
                                                 ELSE (SELECT count(*) FROM public.message_poll_votes v
                                                        WHERE v.poll_id = p_poll_id AND v.option_id = o.id) END)
                                   ORDER BY o."position"), '[]'::jsonb)
                          FROM public.message_poll_options o WHERE o.poll_id = p_poll_id)),
        'poll_event',
        v_topic,
        true);
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'broadcast_message_poll_event failed: %', SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.broadcast_message_poll_event(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_message_poll_event(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Client writes
-- ---------------------------------------------------------------------------

-- As 20261010700001 (create_message_poll). A poll in a channel of a server hosted elsewhere is a
-- copy whose host holds the tally; a host that does not federate polls refuses it.
CREATE OR REPLACE FUNCTION public.create_message_poll(
    p_channel_id uuid,
    p_conversation_id uuid,
    p_question text,
    p_options text[],
    p_allow_multiple boolean DEFAULT false,
    p_duration_hours integer DEFAULT 24,
    p_reply_to uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_question text := btrim(COALESCE(p_question, ''));
    v_options text[];
    v_poll_id uuid := gen_random_uuid();
    v_expires_at timestamptz;
    v_content jsonb;
    v_message public.messages;
    v_remote boolean := false;
    v_host_polls boolean := false;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    IF (p_channel_id IS NULL) = (p_conversation_id IS NULL) THEN
        RAISE EXCEPTION 'A poll is posted to one channel or one conversation' USING ERRCODE = '22023';
    END IF;

    IF char_length(v_question) NOT BETWEEN 1 AND 300 THEN
        RAISE EXCEPTION 'POLL_QUESTION_INVALID: the question is 1 to 300 characters'
            USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(btrim(u.o) ORDER BY u.ord) INTO v_options
      FROM unnest(p_options) WITH ORDINALITY AS u(o, ord);

    IF COALESCE(cardinality(v_options), 0) NOT BETWEEN 2 AND 10 THEN
        RAISE EXCEPTION 'POLL_OPTIONS_INVALID: a poll has 2 to 10 answers' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_options) AS o WHERE o IS NULL OR char_length(o) NOT BETWEEN 1 AND 100) THEN
        RAISE EXCEPTION 'POLL_OPTIONS_INVALID: each answer is 1 to 100 characters' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(DISTINCT lower(o)) FROM unnest(v_options) AS o) <> cardinality(v_options) THEN
        RAISE EXCEPTION 'POLL_OPTIONS_INVALID: answers are distinct' USING ERRCODE = '22023';
    END IF;

    IF p_duration_hours IS NULL OR p_duration_hours NOT BETWEEN 1 AND 168 THEN
        RAISE EXCEPTION 'POLL_DURATION_INVALID: a poll lasts 1 hour to 7 days' USING ERRCODE = '22023';
    END IF;

    IF public.message_poll_target_encrypted(p_channel_id, p_conversation_id) THEN
        RAISE EXCEPTION 'POLL_ENCRYPTED: polls are not available in end-to-end encrypted conversations'
            USING ERRCODE = 'check_violation';
    END IF;

    IF p_channel_id IS NOT NULL THEN
        SELECT s.is_local_server IS FALSE, (s.federation_metadata ->> 'message_polls') = 'true'
          INTO v_remote, v_host_polls
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
         WHERE c.id = p_channel_id;
        v_remote := COALESCE(v_remote, false);
        IF v_remote AND v_host_polls IS NOT TRUE THEN
            RAISE EXCEPTION 'POLL_HOST_UNSUPPORTED: the server''s host does not take polls'
                USING ERRCODE = '0A000';
        END IF;
    END IF;

    v_expires_at := now() + make_interval(hours => p_duration_hours);
    v_content := jsonb_build_array(
        jsonb_build_object(
            'type', 'poll',
            'pollId', v_poll_id,
            'question', v_question,
            'options', to_jsonb(v_options),
            'allowMultiple', COALESCE(p_allow_multiple, false),
            'expiresAt', v_expires_at),
        jsonb_build_object(
            'type', 'text',
            'text', '📊 ' || v_question || E'\n' || (
                SELECT string_agg(u.ord || '. ' || u.o, E'\n' ORDER BY u.ord)
                  FROM unnest(v_options) WITH ORDINALITY AS u(o, ord))));

    PERFORM set_config('harmony.message_poll_id', v_poll_id::text, true);

    INSERT INTO public.messages (channel_id, conversation_id, user_id, content, reply_to)
    VALUES (p_channel_id, p_conversation_id, v_me, v_content, p_reply_to)
    RETURNING * INTO v_message;

    IF NOT FOUND THEN
        -- AutoMod dropped the message and recorded the block.
        PERFORM set_config('harmony.message_poll_id', '', true);
        RETURN NULL;
    END IF;

    INSERT INTO public.message_polls (id, message_id, question, allow_multiple, expires_at, created_by, remote)
    VALUES (v_poll_id, v_message.id, v_question, COALESCE(p_allow_multiple, false), v_expires_at, v_me, v_remote);

    INSERT INTO public.message_poll_options (poll_id, "position", text)
    SELECT v_poll_id, (u.ord - 1)::smallint, u.o
      FROM unnest(v_options) WITH ORDINALITY AS u(o, ord);

    PERFORM set_config('harmony.message_poll_id', '', true);

    RETURN to_jsonb(v_message);
END;
$$;

REVOKE ALL ON FUNCTION public.create_message_poll(uuid, uuid, text, text[], boolean, integer, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_message_poll(uuid, uuid, text, text[], boolean, integer, uuid)
    TO authenticated, service_role;

-- As 20261010700001 (vote_message_poll). On a copy the vote is final: a second one raises
-- POLL_ALREADY_VOTED, an empty one changes nothing. It adds to the stored counts and is queued for
-- the holder. A change of a vote on a poll held here queues its counts for the copies.
CREATE FUNCTION public.vote_message_poll(p_poll_id uuid, p_option_ids uuid[])
RETURNS TABLE(poll_id uuid, message_id uuid, question text, allow_multiple boolean,
              expires_at timestamp with time zone, closed boolean, total_voters integer,
              options jsonb, my_option_ids uuid[], is_author boolean, remote boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_allow_multiple boolean;
    v_closed boolean;
    v_remote boolean;
    v_author uuid;
    v_choice uuid[];
    v_removed integer;
    v_added integer;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT g.allow_multiple, g.closed, g.remote INTO v_allow_multiple, v_closed, v_remote
      FROM public.get_message_polls(ARRAY[p_poll_id]) g;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'POLL_NOT_FOUND: poll not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT m.user_id INTO v_author
      FROM public.message_polls p JOIN public.messages m ON m.id = p.message_id
     WHERE p.id = p_poll_id;
    IF v_author IS NOT NULL AND public.is_blocked_by(v_author) THEN
        RAISE EXCEPTION 'POLL_NOT_FOUND: poll not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_closed THEN
        RAISE EXCEPTION 'POLL_CLOSED: the poll has ended' USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT o), '{}'::uuid[]) INTO v_choice
      FROM unnest(p_option_ids) AS o WHERE o IS NOT NULL;

    IF cardinality(v_choice) > 1 AND NOT v_allow_multiple THEN
        RAISE EXCEPTION 'POLL_SINGLE_CHOICE: this poll takes one answer' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM unnest(v_choice) AS o
         WHERE NOT EXISTS (SELECT 1 FROM public.message_poll_options po
                            WHERE po.poll_id = p_poll_id AND po.id = o)) THEN
        RAISE EXCEPTION 'POLL_OPTION_INVALID: the answer is not part of this poll' USING ERRCODE = '22023';
    END IF;

    -- One vote change per voter and poll at a time: concurrent single-choice votes would
    -- otherwise both insert.
    PERFORM pg_advisory_xact_lock(hashtextextended('message_poll_vote:' || p_poll_id::text || ':' || v_me::text, 0));

    IF v_remote THEN
        IF EXISTS (SELECT 1 FROM public.message_poll_votes v WHERE v.poll_id = p_poll_id AND v.user_id = v_me) THEN
            RAISE EXCEPTION 'POLL_ALREADY_VOTED: a vote on this poll is final' USING ERRCODE = '23505';
        END IF;
        IF cardinality(v_choice) > 0 THEN
            INSERT INTO public.message_poll_votes (poll_id, option_id, user_id)
            SELECT p_poll_id, o, v_me FROM unnest(v_choice) AS o;
            UPDATE public.message_poll_options po SET remote_votes = po.remote_votes + 1
             WHERE po.poll_id = p_poll_id AND po.id = ANY (v_choice);
            UPDATE public.message_polls p SET remote_voters = p.remote_voters + 1 WHERE p.id = p_poll_id;
            PERFORM public.broadcast_message_poll_event(p_poll_id, 'poll:vote');
            PERFORM public.queue_message_poll_federation(p_poll_id, 'vote', v_me);
        END IF;
        RETURN QUERY SELECT * FROM public.get_message_polls(ARRAY[p_poll_id]);
        RETURN;
    END IF;

    DELETE FROM public.message_poll_votes v
     WHERE v.poll_id = p_poll_id
       AND v.user_id = v_me
       AND v.option_id <> ALL (v_choice);
    GET DIAGNOSTICS v_removed = ROW_COUNT;

    INSERT INTO public.message_poll_votes AS v (poll_id, option_id, user_id)
    SELECT p_poll_id, o, v_me FROM unnest(v_choice) AS o
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_added = ROW_COUNT;

    IF v_removed + v_added > 0 THEN
        PERFORM public.broadcast_message_poll_event(p_poll_id, 'poll:vote');
        PERFORM public.queue_message_poll_federation(p_poll_id, 'state');
    END IF;

    RETURN QUERY SELECT * FROM public.get_message_polls(ARRAY[p_poll_id]);
END;
$$;

REVOKE ALL ON FUNCTION public.vote_message_poll(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vote_message_poll(uuid, uuid[]) TO authenticated, service_role;

-- As 20261010700001 (end_message_poll). Ending a poll held here queues its end for the copies; the
-- author ending a copy, a poll in a channel hosted elsewhere, queues the request for the host.
CREATE FUNCTION public.end_message_poll(p_poll_id uuid)
RETURNS TABLE(poll_id uuid, message_id uuid, question text, allow_multiple boolean,
              expires_at timestamp with time zone, closed boolean, total_voters integer,
              options jsonb, my_option_ids uuid[], is_author boolean, remote boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_closed boolean;
    v_remote boolean;
    v_author uuid;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT g.closed, g.remote INTO v_closed, v_remote FROM public.get_message_polls(ARRAY[p_poll_id]) g;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'POLL_NOT_FOUND: poll not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT m.user_id INTO v_author
      FROM public.message_polls p JOIN public.messages m ON m.id = p.message_id
     WHERE p.id = p_poll_id;
    IF v_author IS DISTINCT FROM v_me THEN
        RAISE EXCEPTION 'Only the author ends a poll' USING ERRCODE = '42501';
    END IF;

    IF NOT v_closed THEN
        UPDATE public.message_polls p SET expires_at = now() WHERE p.id = p_poll_id;
        PERFORM public.broadcast_message_poll_event(p_poll_id, 'poll:ended');
        PERFORM public.queue_message_poll_federation(p_poll_id, CASE WHEN v_remote THEN 'end' ELSE 'state' END);
    END IF;

    RETURN QUERY SELECT * FROM public.get_message_polls(ARRAY[p_poll_id]);
END;
$$;

REVOKE ALL ON FUNCTION public.end_message_poll(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_message_poll(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Federated writes
-- ---------------------------------------------------------------------------

-- The poll of a message stored from a Note. The message's content already holds the poll part
-- naming p_poll_id. Question and answers are trimmed and cut to 300 and 100 characters; a poll
-- with fewer than 2 or more than 10 answers, an empty question or answer, a second poll for the
-- message or a poll held here in an end-to-end encrypted channel is not stored. p_votes: counts by
-- answer position, for a copy. Returns the poll id, or NULL when nothing was stored.
CREATE OR REPLACE FUNCTION public.store_federated_message_poll(
    p_message_id uuid,
    p_poll_id uuid,
    p_question text,
    p_options text[],
    p_allow_multiple boolean,
    p_expires_at timestamp with time zone,
    p_remote boolean,
    p_ap_id text,
    p_votes integer[] DEFAULT NULL,
    p_voters integer DEFAULT 0)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_message record;
    v_question text := left(btrim(COALESCE(p_question, '')), 300);
    v_options text[];
BEGIN
    SELECT m.id, m.user_id, m.channel_id, m.content INTO v_message
      FROM public.messages m WHERE m.id = p_message_id;
    IF NOT FOUND
       OR NOT (v_message.content @> jsonb_build_array(jsonb_build_object('type', 'poll', 'pollId', p_poll_id))) THEN
        RETURN NULL;
    END IF;

    SELECT array_agg(left(btrim(COALESCE(u.o, '')), 100) ORDER BY u.ord) INTO v_options
      FROM unnest(p_options) WITH ORDINALITY AS u(o, ord);
    IF char_length(v_question) = 0
       OR COALESCE(cardinality(v_options), 0) NOT BETWEEN 2 AND 10
       OR EXISTS (SELECT 1 FROM unnest(v_options) AS o WHERE char_length(o) = 0) THEN
        RETURN NULL;
    END IF;

    IF p_remote IS NOT TRUE AND v_message.channel_id IS NOT NULL
       AND public.channel_messages_encrypted(v_message.channel_id) THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.message_polls (id, message_id, question, allow_multiple, expires_at, created_by,
                                      remote, ap_id, remote_voters)
    VALUES (p_poll_id, p_message_id, v_question, COALESCE(p_allow_multiple, false), p_expires_at,
            v_message.user_id, COALESCE(p_remote, false), NULLIF(p_ap_id, ''),
            CASE WHEN p_remote THEN GREATEST(COALESCE(p_voters, 0), 0) ELSE 0 END)
    ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.message_poll_options (poll_id, "position", text, remote_votes)
    SELECT p_poll_id, (u.ord - 1)::smallint, u.o,
           CASE WHEN p_remote THEN GREATEST(COALESCE(p_votes[u.ord], 0), 0) ELSE 0 END
      FROM unnest(v_options) WITH ORDINALITY AS u(o, ord);

    RETURN p_poll_id;
END;
$$;

REVOKE ALL ON FUNCTION public.store_federated_message_poll(uuid, uuid, text, text[], boolean, timestamp with time zone, boolean, text, integer[], integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_federated_message_poll(uuid, uuid, text, text[], boolean, timestamp with time zone, boolean, text, integer[], integer)
    TO service_role;

-- The holder's counts and end on a copy. p_votes by answer position, applied when it names every
-- answer; p_expires_at, the holder's end (its close time for a poll ended early), when given.
-- False when p_poll_id names no copy.
CREATE OR REPLACE FUNCTION public.apply_federated_message_poll_state(
    p_poll_id uuid,
    p_votes integer[],
    p_voters integer,
    p_expires_at timestamp with time zone)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_closed boolean;
BEGIN
    UPDATE public.message_polls p
       SET remote_voters = GREATEST(COALESCE(p_voters, p.remote_voters), 0),
           expires_at = COALESCE(p_expires_at, p.expires_at)
     WHERE p.id = p_poll_id AND p.remote
    RETURNING p.expires_at IS NOT NULL AND p.expires_at <= now() INTO v_closed;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF p_votes IS NOT NULL
       AND cardinality(p_votes) = (SELECT count(*) FROM public.message_poll_options o WHERE o.poll_id = p_poll_id) THEN
        UPDATE public.message_poll_options o
           SET remote_votes = GREATEST(COALESCE(p_votes[o."position" + 1], 0), 0)
         WHERE o.poll_id = p_poll_id;
    END IF;

    PERFORM public.broadcast_message_poll_event(p_poll_id, CASE WHEN v_closed THEN 'poll:ended' ELSE 'poll:vote' END);
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_federated_message_poll_state(uuid, integer[], integer, timestamp with time zone)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_federated_message_poll_state(uuid, integer[], integer, timestamp with time zone)
    TO service_role;

-- One answer of a voter from another instance on a poll held here, the answer named by its text.
-- The voter views the channel and its history back to the message (can_view_channel,
-- federation_history_cutoffs), or is a current participant of the conversation, and is not
-- blocked by the author nor suspended. A single-choice poll takes one answer per voter, a
-- multiple-choice poll each answer once; a vote is final. Returns 'recorded', or why not:
-- 'not_found', 'closed', 'forbidden', 'invalid', 'duplicate'.
CREATE OR REPLACE FUNCTION public.record_federated_message_poll_vote(p_poll_id uuid, p_voter_id uuid, p_answer text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_poll record;
    v_voter record;
    v_option uuid;
    v_cutoff timestamptz;
BEGIN
    SELECT p.id, p.allow_multiple, p.expires_at, p.remote, m.user_id AS author_id, m.channel_id,
           m.conversation_id, m.created_at, m.is_deleted, c.server_id
      INTO v_poll
      FROM public.message_polls p
      JOIN public.messages m ON m.id = p.message_id
      LEFT JOIN public.channels c ON c.id = m.channel_id
     WHERE p.id = p_poll_id;
    IF NOT FOUND OR v_poll.remote OR v_poll.is_deleted IS TRUE THEN
        RETURN 'not_found';
    END IF;
    IF v_poll.expires_at IS NOT NULL AND v_poll.expires_at <= now() THEN
        RETURN 'closed';
    END IF;

    SELECT pr.id, pr.federated_id, pr.is_suspended INTO v_voter FROM public.profiles pr WHERE pr.id = p_voter_id;
    IF NOT FOUND OR v_voter.is_suspended IS TRUE THEN
        RETURN 'forbidden';
    END IF;

    IF v_poll.channel_id IS NOT NULL THEN
        IF NOT public.can_view_channel(p_voter_id, v_poll.channel_id) THEN
            RETURN 'forbidden';
        END IF;
        v_cutoff := (public.federation_history_cutoffs(v_poll.server_id, v_voter.federated_id)
                      ->> v_poll.channel_id::text)::timestamptz;
        IF v_cutoff IS NOT NULL AND v_poll.created_at < v_cutoff AND v_poll.author_id IS DISTINCT FROM p_voter_id THEN
            RETURN 'forbidden';
        END IF;
    ELSIF NOT EXISTS (
        SELECT 1 FROM public.conversation_participants cp
         WHERE cp.conversation_id = v_poll.conversation_id
           AND cp.user_id = p_voter_id
           AND cp.left_at IS NULL) THEN
        RETURN 'forbidden';
    END IF;

    IF EXISTS (SELECT 1 FROM public.user_blocks b
                WHERE b.blocker_id = v_poll.author_id AND b.blocked_user_id = p_voter_id) THEN
        RETURN 'forbidden';
    END IF;

    SELECT o.id INTO v_option
      FROM public.message_poll_options o
     WHERE o.poll_id = p_poll_id AND o.text = p_answer
     ORDER BY o."position"
     LIMIT 1;
    IF v_option IS NULL THEN
        RETURN 'invalid';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('message_poll_vote:' || p_poll_id::text || ':' || p_voter_id::text, 0));

    IF EXISTS (SELECT 1 FROM public.message_poll_votes v
                WHERE v.poll_id = p_poll_id
                  AND v.user_id = p_voter_id
                  AND (NOT v_poll.allow_multiple OR v.option_id = v_option)) THEN
        RETURN 'duplicate';
    END IF;

    INSERT INTO public.message_poll_votes (poll_id, option_id, user_id) VALUES (p_poll_id, v_option, p_voter_id);
    PERFORM public.broadcast_message_poll_event(p_poll_id, 'poll:vote');
    PERFORM public.queue_message_poll_federation(p_poll_id, 'state');
    RETURN 'recorded';
END;
$$;

REVOKE ALL ON FUNCTION public.record_federated_message_poll_vote(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_federated_message_poll_vote(uuid, uuid, text) TO service_role;

-- The author, on another instance, ends a poll held here. False when p_actor_id is not the
-- author of an open poll held here.
CREATE OR REPLACE FUNCTION public.end_federated_message_poll(p_poll_id uuid, p_actor_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.message_polls p
       SET expires_at = now()
      FROM public.messages m
     WHERE p.id = p_poll_id
       AND m.id = p.message_id
       AND p.remote IS FALSE
       AND m.user_id = p_actor_id
       AND m.is_deleted IS NOT TRUE
       AND (p.expires_at IS NULL OR p.expires_at > now());
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    PERFORM public.broadcast_message_poll_event(p_poll_id, 'poll:ended');
    PERFORM public.queue_message_poll_federation(p_poll_id, 'state');
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.end_federated_message_poll(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_federated_message_poll(uuid, uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
