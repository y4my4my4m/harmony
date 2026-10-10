-- Polls in chat messages.
--
-- A poll is a message in a server channel or a DM whose content is
--   [{type 'poll', pollId, question, options, allowMultiple, expiresAt},
--    {type 'text', text '📊 <question>\n1. <answer>\n2. <answer>...'}]
-- message_polls, message_poll_options and message_poll_votes hold the poll, its 2 to 10
-- answers and the votes. The text part is the poll for every reader that renders text only:
-- AutoMod, the length limit, search, push previews, bots and bridges, federation and clients
-- older than polls. Clients that render the poll part hide it.
--
-- create_message_poll is SECURITY INVOKER: the message insert runs the client guards (RLS,
-- slowmode, timeouts, AutoMod, rules acceptance, channel encryption) as any send does. AutoMod
-- dropping the row returns NULL with the block recorded. An end-to-end encrypted channel or DM
-- refuses polls: the question and answers would be plaintext. Answers are 1 to 100 characters
-- and distinct, the question 1 to 300; a poll lasts 1 hour to 7 days.
--
-- harmony.message_poll_id, set by create_message_poll for its own transaction, is the only
-- way a poll part enters messages and a row enters message_polls or message_poll_options from
-- a client role. A client cannot set a harmony.* setting through PostgREST. Client edits of a
-- poll message are refused; soft deletion is not.
--
-- Votes are written by vote_message_poll and read as counts through get_message_polls, which
-- answers for polls whose message the caller can view (can_view_channel, or a current DM
-- participant) and is not deleted. An empty answer list removes the caller's vote. The author
-- ends a poll early with end_message_poll. A vote or an end is broadcast as 'poll_event' on the
-- message's topic, channel-messages-<id> or dm-conversation-<id>, with the new counts.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.message_polls (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    message_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
    question text NOT NULL,
    allow_multiple boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_polls_question_length
        CHECK (char_length(btrim(question)) >= 1 AND char_length(question) <= 300)
);

CREATE INDEX IF NOT EXISTS message_polls_created_by_idx ON public.message_polls (created_by);

CREATE TABLE IF NOT EXISTS public.message_poll_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    poll_id uuid NOT NULL REFERENCES public.message_polls(id) ON DELETE CASCADE,
    "position" smallint NOT NULL,
    text text NOT NULL,
    CONSTRAINT message_poll_options_position_range CHECK ("position" BETWEEN 0 AND 9),
    CONSTRAINT message_poll_options_text_length
        CHECK (char_length(btrim(text)) >= 1 AND char_length(text) <= 100),
    CONSTRAINT message_poll_options_poll_position_key UNIQUE (poll_id, "position"),
    CONSTRAINT message_poll_options_poll_id_id_key UNIQUE (poll_id, id)
);

CREATE TABLE IF NOT EXISTS public.message_poll_votes (
    poll_id uuid NOT NULL REFERENCES public.message_polls(id) ON DELETE CASCADE,
    option_id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (poll_id, option_id, user_id),
    -- The answer belongs to the voted poll.
    CONSTRAINT message_poll_votes_option_fkey FOREIGN KEY (poll_id, option_id)
        REFERENCES public.message_poll_options (poll_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS message_poll_votes_user_poll_idx ON public.message_poll_votes (user_id, poll_id);

REVOKE ALL ON public.message_polls, public.message_poll_options, public.message_poll_votes
    FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.message_polls, public.message_poll_options TO authenticated;
GRANT ALL ON public.message_polls, public.message_poll_options, public.message_poll_votes TO service_role;

ALTER TABLE public.message_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_poll_votes ENABLE ROW LEVEL SECURITY;

-- A poll is visible with its message (messages RLS).
DROP POLICY IF EXISTS message_polls_select_visible ON public.message_polls;
CREATE POLICY message_polls_select_visible ON public.message_polls
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.messages m WHERE m.id = message_polls.message_id));

DROP POLICY IF EXISTS message_polls_insert_author ON public.message_polls;
CREATE POLICY message_polls_insert_author ON public.message_polls
    FOR INSERT TO authenticated
    WITH CHECK (
        id::text = current_setting('harmony.message_poll_id', true)
        AND created_by = (SELECT public.get_current_profile_id())
        AND EXISTS (
            SELECT 1 FROM public.messages m
             WHERE m.id = message_polls.message_id
               AND m.user_id = message_polls.created_by
               AND m.content @> jsonb_build_array(
                       jsonb_build_object('type', 'poll', 'pollId', message_polls.id))));

DROP POLICY IF EXISTS message_poll_options_select_visible ON public.message_poll_options;
CREATE POLICY message_poll_options_select_visible ON public.message_poll_options
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.message_polls p WHERE p.id = message_poll_options.poll_id));

DROP POLICY IF EXISTS message_poll_options_insert_author ON public.message_poll_options;
CREATE POLICY message_poll_options_insert_author ON public.message_poll_options
    FOR INSERT TO authenticated
    WITH CHECK (
        poll_id::text = current_setting('harmony.message_poll_id', true)
        AND EXISTS (
            SELECT 1 FROM public.message_polls p
             WHERE p.id = message_poll_options.poll_id
               AND p.created_by = (SELECT public.get_current_profile_id())));

-- Votes have no client policy: they are read as counts through get_message_polls.
DROP POLICY IF EXISTS message_poll_votes_service_role ON public.message_poll_votes;
CREATE POLICY message_poll_votes_service_role ON public.message_poll_votes
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Poll parts in messages
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_message_poll_parts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_new jsonb;
    v_old jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    v_new := COALESCE(jsonb_path_query_array(NEW.content, '$[*] ? (@.type == "poll")'), '[]'::jsonb);

    IF TG_OP = 'INSERT' THEN
        IF jsonb_array_length(v_new) = 0
           OR (jsonb_array_length(v_new) = 1
               AND v_new #>> '{0,pollId}' = current_setting('harmony.message_poll_id', true)) THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'POLL_PART_FORBIDDEN: polls are posted with create_message_poll'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.content IS NOT DISTINCT FROM OLD.content THEN
        RETURN NEW;
    END IF;

    v_old := COALESCE(jsonb_path_query_array(OLD.content, '$[*] ? (@.type == "poll")'), '[]'::jsonb);
    IF jsonb_array_length(v_old) = 0 AND jsonb_array_length(v_new) = 0 THEN
        RETURN NEW;
    END IF;
    -- Soft deletion replaces the content.
    IF NEW.is_deleted IS TRUE AND OLD.is_deleted IS NOT TRUE AND jsonb_array_length(v_new) = 0 THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'POLL_MESSAGE_IMMUTABLE: a poll message cannot be edited'
        USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_message_poll_parts() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_poll_guard ON public.messages;
CREATE TRIGGER a_messages_poll_guard
    BEFORE INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.guard_message_poll_parts();

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- Polls by id, at most 100, that the caller can view: counts, the caller's answers, and whether
-- the caller wrote the poll.
CREATE OR REPLACE FUNCTION public.get_message_polls(p_poll_ids uuid[])
RETURNS TABLE (
    poll_id uuid,
    message_id uuid,
    question text,
    allow_multiple boolean,
    expires_at timestamp with time zone,
    closed boolean,
    total_voters integer,
    options jsonb,
    my_option_ids uuid[],
    is_author boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH me AS (SELECT public.get_current_profile_id() AS id)
    SELECT p.id,
           p.message_id,
           p.question,
           p.allow_multiple,
           p.expires_at,
           p.expires_at IS NOT NULL AND p.expires_at <= now(),
           (SELECT count(DISTINCT v.user_id)::integer
              FROM public.message_poll_votes v WHERE v.poll_id = p.id),
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'id', o.id,
                       'position', o."position",
                       'text', o.text,
                       'votes', (SELECT count(*) FROM public.message_poll_votes v
                                  WHERE v.poll_id = p.id AND v.option_id = o.id))
                       ORDER BY o."position"), '[]'::jsonb)
              FROM public.message_poll_options o WHERE o.poll_id = p.id),
           COALESCE((SELECT array_agg(v.option_id ORDER BY v.option_id)
                       FROM public.message_poll_votes v
                      WHERE v.poll_id = p.id AND v.user_id = me.id), '{}'::uuid[]),
           m.user_id IS NOT DISTINCT FROM me.id
      FROM me
      JOIN public.message_polls p ON p.id = ANY (p_poll_ids[1:100])
      JOIN public.messages m ON m.id = p.message_id
     WHERE me.id IS NOT NULL
       AND m.is_deleted IS NOT TRUE
       AND ((m.channel_id IS NOT NULL AND public.can_view_channel(me.id, m.channel_id))
            OR (m.conversation_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = m.conversation_id
                       AND cp.user_id = me.id
                       AND cp.left_at IS NULL)));
$$;

REVOKE ALL ON FUNCTION public.get_message_polls(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_polls(uuid[]) TO authenticated, service_role;

-- Whether a poll posted to the channel or DM would be plaintext in an end-to-end encrypted one.
-- A DM the caller is not in reads as unencrypted; the message insert refuses it.
CREATE OR REPLACE FUNCTION public.message_poll_target_encrypted(p_channel_id uuid, p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_channel_id IS NOT NULL THEN public.channel_messages_encrypted(p_channel_id)
        ELSE EXISTS (
            SELECT 1
              FROM public.conversation_encryption_settings s
              JOIN public.conversation_participants cp
                ON cp.conversation_id = s.conversation_id
               AND cp.user_id = public.get_current_profile_id()
             WHERE s.conversation_id = p_conversation_id
               AND s.encryption_enabled IS TRUE)
    END;
$$;

REVOKE ALL ON FUNCTION public.message_poll_target_encrypted(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.message_poll_target_encrypted(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

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

    INSERT INTO public.message_polls (id, message_id, question, allow_multiple, expires_at, created_by)
    VALUES (v_poll_id, v_message.id, v_question, COALESCE(p_allow_multiple, false), v_expires_at, v_me);

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

-- Counts of a poll on its message's realtime topic. Delivery is best-effort.
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
    v_topic text;
BEGIN
    SELECT p.message_id, m.channel_id, m.conversation_id, p.expires_at
      INTO v_message_id, v_channel_id, v_conversation_id, v_expires_at
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
            'total_voters', (SELECT count(DISTINCT v.user_id)
                               FROM public.message_poll_votes v WHERE v.poll_id = p_poll_id),
            'options', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                   'id', o.id,
                                   'votes', (SELECT count(*) FROM public.message_poll_votes v
                                              WHERE v.poll_id = p_poll_id AND v.option_id = o.id))
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

-- The caller's answers become p_option_ids; empty or NULL removes the vote.
CREATE OR REPLACE FUNCTION public.vote_message_poll(p_poll_id uuid, p_option_ids uuid[])
RETURNS TABLE (
    poll_id uuid,
    message_id uuid,
    question text,
    allow_multiple boolean,
    expires_at timestamp with time zone,
    closed boolean,
    total_voters integer,
    options jsonb,
    my_option_ids uuid[],
    is_author boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_allow_multiple boolean;
    v_closed boolean;
    v_author uuid;
    v_choice uuid[];
    v_removed integer;
    v_added integer;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT g.allow_multiple, g.closed INTO v_allow_multiple, v_closed
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
    END IF;

    RETURN QUERY SELECT * FROM public.get_message_polls(ARRAY[p_poll_id]);
END;
$$;

REVOKE ALL ON FUNCTION public.vote_message_poll(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vote_message_poll(uuid, uuid[]) TO authenticated, service_role;

-- The author closes the poll now. An ended poll is returned as it is.
CREATE OR REPLACE FUNCTION public.end_message_poll(p_poll_id uuid)
RETURNS TABLE (
    poll_id uuid,
    message_id uuid,
    question text,
    allow_multiple boolean,
    expires_at timestamp with time zone,
    closed boolean,
    total_voters integer,
    options jsonb,
    my_option_ids uuid[],
    is_author boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_closed boolean;
    v_author uuid;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT g.closed INTO v_closed FROM public.get_message_polls(ARRAY[p_poll_id]) g;
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
    END IF;

    RETURN QUERY SELECT * FROM public.get_message_polls(ARRAY[p_poll_id]);
END;
$$;

REVOKE ALL ON FUNCTION public.end_message_poll(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_message_poll(uuid) TO authenticated, service_role;

COMMIT;
