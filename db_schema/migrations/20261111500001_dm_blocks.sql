-- A block between two accounts holds in direct messages, both ways.
--
-- dm_block_between(a, b): an unexpired user_blocks row in either direction.
-- dm_conversation_blocked(conversation, sender): the conversation is direct and its other active
-- participant and the sender are blocked between them.
--
-- dm_start_guard raises DM_NOT_ALLOWED when either account blocks the other, staff included, with the
-- hint of a dm_policy refusal: a refused sender cannot tell a block from a setting. It guards a new
-- direct conversation, a new group and an addition to a group.
--
-- dm_recipients_allowing leaves out every recipient blocked between it and the remote sender, so a
-- federated DM or group invite reaches none of them.
--
-- a_messages_dm_block_guard: a message with an author in a blocked direct conversation raises
-- DM_UNDELIVERABLE, for every role. Authorless rows pass; start_dm_call_message raises the same for
-- its call notice.
--
-- messages_insert_member: a group conversation takes a member's message whoever in it blocks the
-- member, as Discord does; the blocker's client collapses it. A block no longer refuses the row.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.dm_block_between(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_blocks b
         WHERE ((b.blocker_id = p_a AND b.blocked_user_id = p_b)
             OR (b.blocker_id = p_b AND b.blocked_user_id = p_a))
           AND (b.expires_at IS NULL OR b.expires_at > now()))
$$;

CREATE OR REPLACE FUNCTION public.dm_conversation_blocked(p_conversation_id uuid, p_sender uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.conversations c
          JOIN public.conversation_participants cp ON cp.conversation_id = c.id
         WHERE c.id = p_conversation_id
           AND c.type = 'direct'
           AND cp.user_id <> p_sender
           AND cp.left_at IS NULL
           AND public.dm_block_between(p_sender, cp.user_id))
$$;

-- As 20261109200001_instance_write_limits.sql, with the block check first.
CREATE OR REPLACE FUNCTION public.dm_start_guard(p_sender uuid, p_recipient uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_relation text;
    v_cfg jsonb;
    v_new boolean;
    v_limit integer;
BEGIN
    IF public.dm_block_between(p_sender, p_recipient) THEN
        RAISE EXCEPTION 'DM_NOT_ALLOWED'
            USING ERRCODE = 'P0001', HINT = 'This person limits who can start a conversation with them.';
    END IF;

    IF EXISTS (SELECT 1 FROM public.profiles p
                WHERE p.id = p_sender AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE)) THEN
        RETURN;
    END IF;

    v_relation := public.dm_relation(p_sender, p_recipient);
    IF NOT public.dm_policy_allows(p_recipient, v_relation) THEN
        RAISE EXCEPTION 'DM_NOT_ALLOWED'
            USING ERRCODE = 'P0001', HINT = 'This person limits who can start a conversation with them.';
    END IF;
    IF v_relation IN ('conversation', 'following') OR public.antispam_account_exempt(p_sender) THEN
        RETURN;
    END IF;

    v_cfg := public.antispam_settings();
    SELECT p.created_at > now() - make_interval(hours => GREATEST(public.antispam_int(v_cfg -> 'new_account_hours', 24), 1))
      INTO v_new
      FROM public.profiles p WHERE p.id = p_sender;
    -- A public server's members are one join away, so a shared server counts for a new account.
    IF v_relation = 'server' AND v_new IS NOT TRUE THEN
        RETURN;
    END IF;
    v_limit := public.antispam_int(v_cfg -> 'account_stranger_dms_per_hour', 0);
    IF v_new IS TRUE AND public.antispam_int(v_cfg -> 'new_account_stranger_dms_per_hour', 0) > 0 THEN
        v_limit := public.antispam_int(v_cfg -> 'new_account_stranger_dms_per_hour', 0);
    END IF;
    IF v_limit <= 0 THEN
        RETURN;
    END IF;

    PERFORM public.antispam_rate_check(p_sender, 'stranger_dm', v_limit, 3600,
                                       'An account can start a limited number of new conversations per hour.');
    INSERT INTO public.automod_recent_activity (user_id, kind) VALUES (p_sender, 'stranger_dm');
END;
$$;

-- As 20261109200001_instance_write_limits.sql, without the recipients blocked with the sender.
CREATE OR REPLACE FUNCTION public.dm_recipients_allowing(p_sender uuid, p_recipients uuid[])
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_agg(r), '{}'::uuid[])
      FROM unnest(p_recipients) r
     WHERE public.dm_policy_allows(r, public.dm_relation(p_sender, r))
       AND NOT public.dm_block_between(p_sender, r)
$$;

CREATE OR REPLACE FUNCTION public.guard_dm_block()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.dm_conversation_blocked(NEW.conversation_id, NEW.user_id) THEN
        RAISE EXCEPTION 'DM_UNDELIVERABLE'
            USING ERRCODE = 'P0001', HINT = 'This message could not be delivered.';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_messages_dm_block_guard ON public.messages;
CREATE TRIGGER a_messages_dm_block_guard
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.conversation_id IS NOT NULL AND NEW.user_id IS NOT NULL)
    EXECUTE FUNCTION public.guard_dm_block();

-- As 20261026100001_system_events.sql, refused in a blocked direct conversation.
CREATE OR REPLACE FUNCTION public.start_dm_call_message(p_conversation_id uuid, p_call_type text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_call_type IS NULL OR p_call_type NOT IN ('voice', 'video') THEN
        RAISE EXCEPTION 'call type is voice or video' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
            SELECT 1 FROM public.conversation_participants cp
             WHERE cp.conversation_id = p_conversation_id
               AND cp.user_id = v_caller
               AND cp.left_at IS NULL) THEN
        RAISE EXCEPTION 'Conversation not found' USING ERRCODE = 'P0002';
    END IF;
    IF public.dm_conversation_blocked(p_conversation_id, v_caller) THEN
        RAISE EXCEPTION 'DM_UNDELIVERABLE'
            USING ERRCODE = 'P0001', HINT = 'This message could not be delivered.';
    END IF;

    INSERT INTO public.messages (conversation_id, content, is_system, metadata)
    VALUES (p_conversation_id,
            '[{"type": "text", "text": "started a call"}]'::jsonb, true,
            jsonb_build_object('type', 'call_started', 'actor_id', v_caller, 'call_type', p_call_type,
                               'started_at', now(), 'participants', jsonb_build_array(v_caller)))
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- As 20261110100001_room_and_broadcast_boundaries.sql, without the block clause.
DROP POLICY IF EXISTS "messages_insert_member" ON public.messages;
CREATE POLICY "messages_insert_member" ON public.messages
    FOR INSERT
    WITH CHECK (
        user_id = (SELECT public.get_current_profile_id())
        AND (
            (channel_id IS NOT NULL
             AND conversation_id IS NULL
             AND channel_id IN (SELECT public.current_user_viewable_channel_ids())
             AND (thread_id IS NULL OR EXISTS (
                 SELECT 1 FROM public.threads t
                  WHERE t.id = messages.thread_id AND t.channel_id = messages.channel_id
             ))
             AND public.has_permission(
                 (SELECT public.get_current_profile_id()),
                 (SELECT c.server_id FROM public.channels c WHERE c.id = messages.channel_id),
                 CASE WHEN thread_id IS NULL THEN 'SEND_MESSAGES' ELSE 'SEND_MESSAGES_IN_THREADS' END,
                 channel_id))
            OR (conversation_id IS NOT NULL
                AND channel_id IS NULL
                AND thread_id IS NULL
                AND EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = messages.conversation_id
                       AND cp.user_id = (SELECT public.get_current_profile_id())
                       AND cp.left_at IS NULL
                ))
        )
    );

DO $do$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.dm_block_between(uuid, uuid)'::regprocedure,
        'public.dm_conversation_blocked(uuid, uuid)'::regprocedure,
        'public.guard_dm_block()'::regprocedure,
        'public.dm_start_guard(uuid, uuid)'::regprocedure,
        'public.dm_recipients_allowing(uuid, uuid[])'::regprocedure
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$do$;

-- Prod definers have mixed owners, postgres and supabase_admin. A definer runs as its owner, and a
-- non-superuser owner has no EXECUTE on a helper with PUBLIC revoked.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT h.helper, pg_get_userbyid(p.proowner) AS owner
          FROM (VALUES
                  ('dm_block_between(uuid, uuid)',
                   ARRAY['dm_start_guard', 'dm_recipients_allowing', 'dm_conversation_blocked']),
                  ('dm_conversation_blocked(uuid, uuid)', ARRAY['guard_dm_block', 'start_dm_call_message'])
               ) AS h(helper, callers)
          JOIN pg_proc p ON p.proname = ANY (h.callers) AND p.pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I', r.helper, r.owner);
    END LOOP;
END
$$;

COMMIT;
