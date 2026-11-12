-- Import insert functions: how the bridge writes Discord history into Harmony. All are SECURITY
-- DEFINER and granted to the service role alone. Each import call first runs bridge_import_guard,
-- then sets the transaction-local flag harmony.history_import (20261110900004), so the rows leave
-- none of the side effects of live messages.
--
--   bridge_import_guard(bot, import)        the job, locked; import_not_found / import_not_running
--   bridge_import_messages(bot, import, [ImportMessage])  -> {inserted: [{discord_message_id, id}], skipped: [id],
--                                                            rejected: [{discord_message_id, reason}]}
--   bridge_import_present_ids(bot, import, [id])          -> the Discord ids the job's channel already holds
--   bridge_import_thread(bot, import, thread)             -> Harmony thread id (idempotent per Discord thread)
--   bridge_import_link_replies(bot, import)               -> number of replies linked
--   bridge_import_link_replies_core(channel, ids)         shared by the batch and the replies phase; no role
--                                                         can call it, only the definer wrappers (owner) do
--
-- A message that breaks a check (too long for the instance limit, empty content) is not a failed
-- job: its insert runs in its own sub-block, the id lands in `rejected` (reason too_long or
-- check_violation) and in `skipped`, and the batch carries on.
--
-- Errors (the message is the code; DETAIL names the subject): import_not_found P0002,
-- import_not_running 55000 (DETAIL = the state), invalid_message / invalid_thread 22023.
--
-- A job whose pair was removed, is no longer importable, or whose channel became encrypted is set
-- to failed (error pair_removed | pair_not_importable | channel_encrypted). That write must commit,
-- so the guard does not raise for it (a raise would roll it back): it returns the failed row, and
-- each function answers "not running" in its own shape: messages returns
-- {inserted: [], skipped: [], not_running: true, state, error}; thread and link_replies return NULL.
-- The next call finds the job failed and raises import_not_running.
--
-- Imported rows never federated, so their later edits, deletes and pins must not either: the
-- message edit, delete and pin federation triggers return early for metadata.history_import = true,
-- and the thread delete trigger for a thread that never federated (no author, no ap_id, skipped).

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.bridge_import_guard(p_bot_id uuid, p_import_id uuid)
RETURNS public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.discord_bridge_imports;
    v_pair public.discord_bridge_channels;
    v_error text;
BEGIN
    SELECT i.* INTO v_job
      FROM public.discord_bridge_imports i
      JOIN public.discord_bridges b ON b.id = i.bridge_id
     WHERE i.id = p_import_id AND b.bot_id = p_bot_id
       FOR UPDATE OF i;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'import_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_job.state <> 'running' THEN
        RAISE EXCEPTION 'import_not_running' USING ERRCODE = '55000', DETAIL = v_job.state;
    END IF;

    SELECT p.* INTO v_pair
      FROM public.discord_bridge_channels p
     WHERE p.bridge_id = v_job.bridge_id AND p.harmony_channel_id = v_job.harmony_channel_id;
    IF NOT FOUND OR v_pair.discord_channel_id <> v_job.discord_channel_id THEN
        v_error := 'pair_removed';
    ELSIF v_pair.direction NOT IN ('both', 'to_harmony') THEN
        v_error := 'pair_not_importable';
    ELSIF public.channel_messages_encrypted(v_job.harmony_channel_id) THEN
        v_error := 'channel_encrypted';
    END IF;

    IF v_error IS NOT NULL THEN
        UPDATE public.discord_bridge_imports i
           SET state = 'failed', error = v_error, updated_at = now(), finished_at = now()
         WHERE i.id = v_job.id
        RETURNING * INTO v_job;
    END IF;
    RETURN v_job;
END;
$$;

-- Points the imported replies named by p_ids (all of the channel's when NULL) at their targets,
-- where the target now exists. updated_at stays: it is the Discord edit time.
CREATE OR REPLACE FUNCTION public.bridge_import_link_replies_core(p_channel_id uuid, p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_prev text := current_setting('harmony.silent_content_update', true);
    v_count integer;
BEGIN
    PERFORM set_config('harmony.silent_content_update', 'true', true);
    UPDATE public.messages m
       SET reply_to = t.id
      FROM public.messages t
     WHERE m.channel_id = p_channel_id
       AND (p_ids IS NULL OR m.id = ANY (p_ids))
       AND m.metadata ->> 'history_import' = 'true'
       AND m.metadata ? 'discord_reply_to'
       AND m.reply_to IS NULL
       AND t.channel_id = p_channel_id
       AND t.metadata ? 'discord_message_id'
       AND t.is_deleted IS NOT TRUE
       AND t.metadata ->> 'discord_message_id' = m.metadata ->> 'discord_reply_to'
       AND t.id <> m.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM set_config('harmony.silent_content_update', COALESCE(v_prev, ''), true);
    RETURN v_count;
END;
$$;

-- The Discord ids among p_ids that the job's channel already holds as live rows. The WHERE repeats
-- the predicate of messages_channel_discord_message_id_unique so the lookup is an index probe.
-- Read-only; the job's state is not checked (the route reads it itself).
CREATE OR REPLACE FUNCTION public.bridge_import_present_ids(p_bot_id uuid, p_import_id uuid, p_ids text[])
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
BEGIN
    SELECT i.harmony_channel_id INTO v_channel
      FROM public.discord_bridge_imports i
      JOIN public.discord_bridges b ON b.id = i.bridge_id
     WHERE i.id = p_import_id AND b.bot_id = p_bot_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'import_not_found' USING ERRCODE = 'P0002';
    END IF;

    RETURN COALESCE((
        SELECT array_agg(DISTINCT m.metadata ->> 'discord_message_id')
          FROM public.messages m
         WHERE m.channel_id = v_channel
           AND m.metadata ? 'discord_message_id'
           AND m.metadata ->> 'discord_message_id' = ANY (p_ids)
           AND m.is_deleted IS NOT TRUE
    ), ARRAY[]::text[]);
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_import_messages(p_bot_id uuid, p_import_id uuid, p_messages jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.discord_bridge_imports;
    v_msg jsonb;
    v_did text;
    v_reply_did text;
    v_created timestamptz;
    v_edited timestamptz;
    v_thread uuid;
    v_reply uuid;
    v_wants_pin boolean;
    v_pin boolean;
    v_id uuid;
    v_new_ids uuid[] := ARRAY[]::uuid[];
    v_inserted jsonb := '[]'::jsonb;
    v_skipped jsonb := '[]'::jsonb;
    v_rejected jsonb := '[]'::jsonb;
    v_err_msg text;
    v_n_ins integer := 0;
    v_n_skip integer := 0;
    v_n_pins_skipped integer := 0;
    v_max_pins constant integer := 50;
BEGIN
    v_job := public.bridge_import_guard(p_bot_id, p_import_id);
    IF v_job.state <> 'running' THEN
        RETURN jsonb_build_object('inserted', '[]'::jsonb, 'skipped', '[]'::jsonb,
                                  'rejected', '[]'::jsonb, 'not_running', true, 'state', v_job.state, 'error', v_job.error);
    END IF;
    IF p_messages IS NULL OR jsonb_typeof(p_messages) <> 'array' THEN
        RAISE EXCEPTION 'invalid_message' USING ERRCODE = '22023', DETAIL = 'messages';
    END IF;

    PERFORM set_config('harmony.history_import', 'true', true);

    FOR v_msg IN SELECT e.value FROM jsonb_array_elements(p_messages) WITH ORDINALITY e(value, ord) ORDER BY e.ord LOOP
        v_did := v_msg ->> 'discord_message_id';
        IF jsonb_typeof(v_msg) <> 'object' OR v_did IS NULL OR v_did !~ '^[0-9]{1,20}$'
           OR jsonb_typeof(v_msg -> 'content') <> 'array' OR (v_msg ->> 'created_at') IS NULL THEN
            RAISE EXCEPTION 'invalid_message' USING ERRCODE = '22023', DETAIL = COALESCE(v_did, '');
        END IF;
        v_created := (v_msg ->> 'created_at')::timestamptz;
        v_edited := NULLIF(v_msg ->> 'edited_at', '')::timestamptz;
        v_reply_did := NULLIF(v_msg ->> 'reply_to_discord_message_id', '');
        v_thread := NULLIF(v_msg ->> 'thread_id', '')::uuid;

        IF v_thread IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.threads t WHERE t.id = v_thread AND t.channel_id = v_job.harmony_channel_id) THEN
            RAISE EXCEPTION 'invalid_thread' USING ERRCODE = '22023', DETAIL = v_did;
        END IF;

        v_reply := NULL;
        IF v_reply_did IS NOT NULL THEN
            SELECT m.id INTO v_reply
              FROM public.messages m
             WHERE m.channel_id = v_job.harmony_channel_id
               AND m.metadata ? 'discord_message_id'
               AND m.metadata ->> 'discord_message_id' = v_reply_did
               AND m.is_deleted IS NOT TRUE;
        END IF;

        v_wants_pin := COALESCE((v_msg ->> 'pinned')::boolean, false);
        v_pin := false;
        IF v_wants_pin THEN
            v_pin := (SELECT count(*) FROM public.messages m
                       WHERE m.channel_id = v_job.harmony_channel_id AND m.is_pinned = true) < v_max_pins;
        END IF;

        v_id := NULL;
        BEGIN
        INSERT INTO public.messages
            (created_at, updated_at, bot_id, channel_id, thread_id, reply_to, content, is_pinned, pinned_at, metadata)
        VALUES (v_created, COALESCE(v_edited, v_created), p_bot_id, v_job.harmony_channel_id, v_thread, v_reply,
                v_msg -> 'content', v_pin, CASE WHEN v_pin THEN v_created END,
                jsonb_build_object(
                    'discord_user', CASE WHEN jsonb_typeof(v_msg -> 'discord_user') = 'object'
                                         THEN v_msg -> 'discord_user' ELSE '{}'::jsonb END,
                    'discord_message_id', v_did,
                    'history_import', true,
                    'bot', true,
                    'created_via', 'history_import')
                || CASE WHEN v_reply_did IS NOT NULL
                        THEN jsonb_build_object('discord_reply_to', v_reply_did) ELSE '{}'::jsonb END)
        ON CONFLICT (channel_id, (metadata ->> 'discord_message_id'))
            WHERE channel_id IS NOT NULL AND metadata ? 'discord_message_id' AND is_deleted IS NOT TRUE
        DO NOTHING
        RETURNING id INTO v_id;
        EXCEPTION WHEN check_violation THEN
            -- Undone with the sub-block: no row, no counter. The reason is the length check's or any other.
            GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
            v_id := NULL;
            v_rejected := v_rejected || jsonb_build_object('discord_message_id', v_did,
                'reason', CASE WHEN v_err_msg LIKE 'Message text exceeds%' THEN 'too_long' ELSE 'check_violation' END);
        END;

        IF v_id IS NULL THEN
            v_n_skip := v_n_skip + 1;
            v_skipped := v_skipped || to_jsonb(v_did);
        ELSE
            v_n_ins := v_n_ins + 1;
            v_new_ids := v_new_ids || v_id;
            v_inserted := v_inserted || jsonb_build_object('discord_message_id', v_did, 'id', v_id);
            IF v_wants_pin AND NOT v_pin THEN
                v_n_pins_skipped := v_n_pins_skipped + 1;
            END IF;
        END IF;
    END LOOP;

    -- A reply whose target comes later in this batch.
    IF v_n_ins > 0 THEN
        PERFORM public.bridge_import_link_replies_core(v_job.harmony_channel_id, v_new_ids);
    END IF;

    UPDATE public.discord_bridge_imports i
       SET imported_count = i.imported_count + v_n_ins,
           skipped_count = i.skipped_count + v_n_skip,
           pins_skipped = i.pins_skipped + v_n_pins_skipped,
           updated_at = now()
     WHERE i.id = v_job.id;

    RETURN jsonb_build_object('inserted', v_inserted, 'skipped', v_skipped, 'rejected', v_rejected);
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_import_thread(p_bot_id uuid, p_import_id uuid, p_thread jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.discord_bridge_imports;
    v_did text := p_thread ->> 'discord_thread_id';
    v_name text := left(btrim(COALESCE(p_thread ->> 'name', '')), 100);
    v_created timestamptz;
    v_starter text := NULLIF(p_thread ->> 'starter_discord_message_id', '');
    v_user jsonb := p_thread -> 'discord_user';
    v_archived boolean := COALESCE((p_thread ->> 'archived')::boolean, false);
    v_locked boolean := COALESCE((p_thread ->> 'locked')::boolean, false);
    v_parent uuid;
    v_thread_id uuid;
    v_notice_id uuid;
    v_notice jsonb;
BEGIN
    v_job := public.bridge_import_guard(p_bot_id, p_import_id);
    IF v_job.state <> 'running' THEN
        RETURN NULL;
    END IF;
    IF p_thread IS NULL OR jsonb_typeof(p_thread) <> 'object' OR v_did IS NULL OR v_did !~ '^[0-9]{1,20}$'
       OR (p_thread ->> 'created_at') IS NULL THEN
        RAISE EXCEPTION 'invalid_thread' USING ERRCODE = '22023', DETAIL = COALESCE(v_did, '');
    END IF;
    IF v_name = '' THEN
        RAISE EXCEPTION 'Thread name must be 1 to 100 characters' USING ERRCODE = '22023';
    END IF;
    v_created := (p_thread ->> 'created_at')::timestamptz;

    PERFORM set_config('harmony.history_import', 'true', true);

    PERFORM pg_advisory_xact_lock(hashtext('bridge_thread:' || v_job.bridge_id::text || ':' || v_did));
    SELECT bt.thread_id INTO v_thread_id
      FROM public.discord_bridge_threads bt
     WHERE bt.bridge_id = v_job.bridge_id AND bt.discord_thread_id = v_did;
    IF v_thread_id IS NOT NULL THEN
        RETURN v_thread_id;
    END IF;

    v_notice := jsonb_build_object('type', 'thread_created', 'actor_bot_id', p_bot_id, 'thread_name', v_name,
                                   'bridge_source', 'discord', 'history_import', true, 'created_via', 'history_import');
    IF jsonb_typeof(v_user) = 'object' AND v_user ->> 'id' ~ '^[0-9]{1,20}$' THEN
        v_notice := v_notice || jsonb_build_object('discord_user', jsonb_strip_nulls(jsonb_build_object(
            'id', v_user ->> 'id',
            'username', left(v_user ->> 'username', 100),
            'display_name', left(v_user ->> 'display_name', 100),
            'avatar_url', CASE WHEN v_user ->> 'avatar_url' ~ '^https://' THEN left(v_user ->> 'avatar_url', 2048) END)));
    END IF;

    IF v_starter IS NOT NULL THEN
        SELECT m.id INTO v_parent
          FROM public.messages m
         WHERE m.channel_id = v_job.harmony_channel_id
           AND m.metadata ? 'discord_message_id'
           AND m.metadata ->> 'discord_message_id' = v_starter
           AND m.is_deleted IS NOT TRUE
           AND m.thread_id IS NULL;
    END IF;

    IF v_parent IS NOT NULL THEN
        -- One thread per message; an existing one is paired and returned.
        PERFORM pg_advisory_xact_lock(hashtext('create_thread:' || v_parent::text));
        SELECT t.id INTO v_thread_id FROM public.threads t WHERE t.parent_message_id = v_parent;

        IF v_thread_id IS NULL THEN
            INSERT INTO public.threads (channel_id, parent_message_id, name, created_by, auto_archive_duration,
                                        created_at, updated_at, archived, archived_at, locked)
            VALUES (v_job.harmony_channel_id, v_parent, v_name, NULL, 1440, v_created, v_created,
                    v_archived, CASE WHEN v_archived THEN v_created END, v_locked)
            RETURNING id INTO v_thread_id;

            -- A system row has no author (messages_system_authorless); the bot is in metadata.
            INSERT INTO public.messages (created_at, channel_id, content, is_system, metadata)
            VALUES (v_created, v_job.harmony_channel_id,
                    '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                    v_notice || jsonb_build_object('thread_id', v_thread_id));
        END IF;
    ELSE
        v_thread_id := gen_random_uuid();
        INSERT INTO public.messages (created_at, channel_id, content, is_system, metadata)
        VALUES (v_created, v_job.harmony_channel_id,
                '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                v_notice || jsonb_build_object('thread_id', v_thread_id, 'standalone', true))
        RETURNING id INTO v_notice_id;

        INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, auto_archive_duration,
                                    created_at, updated_at, archived, archived_at, locked)
        VALUES (v_thread_id, v_job.harmony_channel_id, v_notice_id, v_name, NULL, 1440, v_created, v_created,
                v_archived, CASE WHEN v_archived THEN v_created END, v_locked);
    END IF;

    INSERT INTO public.discord_bridge_threads (thread_id, bridge_id, discord_thread_id)
    VALUES (v_thread_id, v_job.bridge_id, v_did)
    ON CONFLICT (thread_id) DO NOTHING;

    RETURN v_thread_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_import_link_replies(p_bot_id uuid, p_import_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.discord_bridge_imports;
BEGIN
    v_job := public.bridge_import_guard(p_bot_id, p_import_id);
    IF v_job.state <> 'running' THEN
        RETURN NULL;
    END IF;
    PERFORM set_config('harmony.history_import', 'true', true);
    RETURN public.bridge_import_link_replies_core(v_job.harmony_channel_id, NULL);
END;
$$;

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_import_guard(uuid, uuid)',
        'public.bridge_import_present_ids(uuid, uuid, text[])',
        'public.bridge_import_messages(uuid, uuid, jsonb)',
        'public.bridge_import_thread(uuid, uuid, jsonb)',
        'public.bridge_import_link_replies(uuid, uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

-- The reply linker acts on any channel it is given: only the wrappers above, which run as the
-- owner, call it. Not even the service role may.
REVOKE ALL ON FUNCTION public.bridge_import_link_replies_core(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- Federation triggers, as 20261110900004, with the guard widened to imported rows.

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF public.is_history_import() OR COALESCE(NEW.metadata ->> 'history_import', '') = 'true' THEN
        RETURN NEW;
    END IF;
    IF current_setting('harmony.silent_content_update', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;

        IF NEW.encrypted IS TRUE OR OLD.encrypted IS TRUE
           OR public.channel_messages_encrypted(NEW.channel_id) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-edit',
            jsonb_build_object(
                'type', 'update',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
    v_deleter UUID;
BEGIN
    IF public.is_history_import() OR COALESCE(NEW.metadata ->> 'history_import', '') = 'true' THEN
        RETURN NEW;
    END IF;
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN RETURN NEW; END IF;

        IF NEW.federation_status = 'skipped'
           AND NOT (NEW.metadata ? 'federated')
           AND (NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id)) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
            v_deleter := public.get_current_profile_id();
            IF v_deleter IS NOT NULL AND v_deleter IS DISTINCT FROM NEW.user_id THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-delete',
            jsonb_build_object(
                'type', 'delete',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'ap_id', NEW.metadata->>'ap_id',
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_pin_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server_id uuid;
BEGIN
    IF public.is_history_import() OR COALESCE(NEW.metadata ->> 'history_import', '') = 'true' THEN
        RETURN NULL;
    END IF;
    IF NEW.channel_id IS NULL OR NEW.is_deleted IS TRUE
       OR NEW.is_pinned IS NOT DISTINCT FROM OLD.is_pinned THEN
        RETURN NULL;
    END IF;

    -- Notices other than member events have no Note (LIVE_SYSTEM_NOTE_TYPES, systemNotes.ts).
    IF NEW.is_system IS TRUE
       AND COALESCE(NEW.metadata ->> 'type', '') NOT IN ('member_join', 'member_leave', 'member_kick', 'member_ban') THEN
        RETURN NULL;
    END IF;

    IF NEW.encrypted IS TRUE OR public.channel_messages_encrypted(NEW.channel_id) THEN
        RETURN NULL;
    END IF;

    SELECT c.server_id INTO v_server_id
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = NEW.channel_id
       AND s.is_local_server IS TRUE
       AND s.federation_enabled IS TRUE;
    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-channel-pin',
        jsonb_build_object(
            'type', 'update',
            'message_id', NEW.id,
            'channel_id', NEW.channel_id,
            'server_id', v_server_id,
            'pinned', NEW.is_pinned IS TRUE
        ),
        5, 5, 900
    );
    RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_queue_thread_delete_federation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_server_id uuid;
BEGIN
    IF public.is_history_import()
       OR (OLD.created_by IS NULL AND OLD.ap_id IS NULL AND OLD.federation_status = 'skipped') THEN
        RETURN NULL;
    END IF;
    SELECT s.id INTO v_server_id
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = OLD.channel_id
       AND s.is_local_server IS TRUE
       AND s.federation_enabled IS TRUE;
    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-thread',
        jsonb_build_object(
            'type', 'delete', 'thread_id', OLD.id, 'ap_id', OLD.ap_id,
            'channel_id', OLD.channel_id, 'server_id', v_server_id, 'server_is_local', true,
            'created_by', OLD.created_by
        ), 5, 5, 900
    );
    RETURN NULL;
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
