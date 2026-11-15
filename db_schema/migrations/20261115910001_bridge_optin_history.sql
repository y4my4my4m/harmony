-- Bridge privacy: opting back in is forward-looking.
--
-- A member who opted out, or whom a manager removed, had what the bridge brought erased or left
-- out. After they opt back in, or the manager restores them, history import brought it back.
--
--   bridge_remote_optins           when a remote user's last opt-out of a server's bridge ended.
--   bridge_privacy_note_optin      AFTER DELETE trigger on bridge_remote_optouts: records the end.
--                                  A row deleted with its server records nothing.
--   bridge_import_messages         as 20261112700001; a message written before its author's last
--                                  opt-in is rejected with reason 'before_opt_in'.
--   bridge_import_thread           as 20261115500001; a thread started before its author's last
--                                  opt-in is imported as 'Thread', without the author.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.bridge_remote_optins (
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    platform text NOT NULL,
    remote_user_id text NOT NULL,
    opted_in_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, platform, remote_user_id)
);

COMMENT ON TABLE public.bridge_remote_optins IS
    'When a remote user''s last opt-out of a server''s bridge ended. History import leaves out what they wrote before.';

REVOKE ALL ON public.bridge_remote_optins FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bridge_remote_optins TO service_role;

ALTER TABLE public.bridge_remote_optins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bridge_remote_optins_service_role ON public.bridge_remote_optins;
CREATE POLICY bridge_remote_optins_service_role ON public.bridge_remote_optins
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.bridge_privacy_note_optin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- A cascade from the server's deletion runs after the server row is gone.
    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = OLD.server_id) THEN
        INSERT INTO public.bridge_remote_optins AS i (server_id, platform, remote_user_id, opted_in_at)
        VALUES (OLD.server_id, OLD.platform, OLD.remote_user_id, now())
        ON CONFLICT (server_id, platform, remote_user_id) DO UPDATE SET opted_in_at = EXCLUDED.opted_in_at;
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.bridge_privacy_note_optin() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_bridge_remote_optouts_note_optin ON public.bridge_remote_optouts;
CREATE TRIGGER a_bridge_remote_optouts_note_optin
    AFTER DELETE ON public.bridge_remote_optouts
    FOR EACH ROW EXECUTE FUNCTION public.bridge_privacy_note_optin();

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
    v_reason text;
    v_new_ids uuid[] := ARRAY[]::uuid[];
    v_inserted jsonb := '[]'::jsonb;
    v_skipped jsonb := '[]'::jsonb;
    v_rejected jsonb := '[]'::jsonb;
    v_err_msg text;
    v_n_ins integer := 0;
    v_n_skip integer := 0;
    v_n_pins_skipped integer := 0;
    v_n_automod integer := 0;
    v_max_pins constant integer := 50;
    v_server uuid;
    v_category uuid;
    v_compiled jsonb;
BEGIN
    v_job := public.bridge_import_guard(p_bot_id, p_import_id);
    IF v_job.state <> 'running' THEN
        RETURN jsonb_build_object('inserted', '[]'::jsonb, 'skipped', '[]'::jsonb,
                                  'rejected', '[]'::jsonb, 'not_running', true, 'state', v_job.state, 'error', v_job.error);
    END IF;
    IF p_messages IS NULL OR jsonb_typeof(p_messages) <> 'array' THEN
        RAISE EXCEPTION 'invalid_message' USING ERRCODE = '22023', DETAIL = 'messages';
    END IF;

    -- The server's rules for relayed content, when bots are not exempt.
    SELECT c.server_id, c.category,
           CASE WHEN st.enabled IS TRUE AND NOT COALESCE((st.compiled ->> 'exempt_bots')::boolean, true)
                THEN st.compiled END
      INTO v_server, v_category, v_compiled
      FROM public.channels c
      LEFT JOIN public.server_automod_settings st ON st.server_id = c.server_id
     WHERE c.id = v_job.harmony_channel_id;

    PERFORM set_config('harmony.history_import', 'true', true);

    FOR v_msg IN SELECT e.value FROM jsonb_array_elements(p_messages) WITH ORDINALITY e(value, ord) ORDER BY e.ord LOOP
        v_did := CASE WHEN jsonb_typeof(v_msg) = 'object' THEN v_msg ->> 'discord_message_id' END;
        -- An entry without a usable id has nothing to answer under.
        CONTINUE WHEN v_did IS NULL OR v_did !~ '^[0-9]{1,20}$';

        v_id := NULL;
        v_reason := NULL;
        v_wants_pin := false;
        v_pin := false;
        BEGIN
            IF jsonb_typeof(v_msg -> 'content') <> 'array' OR (v_msg ->> 'created_at') IS NULL THEN
                RAISE EXCEPTION 'invalid_message' USING ERRCODE = '22023';
            END IF;
            v_created := (v_msg ->> 'created_at')::timestamptz;
            v_edited := NULLIF(v_msg ->> 'edited_at', '')::timestamptz;
            v_reply_did := NULLIF(v_msg ->> 'reply_to_discord_message_id', '');
            v_thread := NULLIF(v_msg ->> 'thread_id', '')::uuid;
            v_wants_pin := COALESCE((v_msg ->> 'pinned')::boolean, false);

            IF v_thread IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM public.threads t WHERE t.id = v_thread AND t.channel_id = v_job.harmony_channel_id) THEN
                RAISE EXCEPTION 'invalid_thread' USING ERRCODE = '22023';
            END IF;

            IF v_created > now() + interval '1 minute' OR v_edited > now() + interval '1 minute' THEN
                v_reason := 'future_date';
            -- An author opted out again is refused at the insert, as opted_out.
            ELSIF EXISTS (
                      SELECT 1 FROM public.bridge_remote_optins i
                       WHERE i.server_id = v_server AND i.platform = 'discord'
                         AND i.remote_user_id = v_msg #>> '{discord_user,id}'
                         AND i.opted_in_at > v_created)
                  AND NOT EXISTS (
                      SELECT 1 FROM public.bridge_remote_optouts o
                       WHERE o.server_id = v_server AND o.platform = 'discord'
                         AND o.remote_user_id = v_msg #>> '{discord_user,id}') THEN
                v_reason := 'before_opt_in';
            ELSIF v_compiled IS NOT NULL AND public.bridge_import_automod_hit(
                      v_compiled, v_server, v_job.harmony_channel_id, v_category, v_msg -> 'content') IS NOT NULL THEN
                v_reason := 'automod';
                v_n_automod := v_n_automod + 1;
            ELSE
                v_reply := NULL;
                IF v_reply_did IS NOT NULL THEN
                    SELECT m.id INTO v_reply
                      FROM public.messages m
                     WHERE m.channel_id = v_job.harmony_channel_id
                       AND m.metadata ? 'discord_message_id'
                       AND m.metadata ->> 'discord_message_id' = v_reply_did
                       AND m.is_deleted IS NOT TRUE;
                END IF;

                IF v_wants_pin THEN
                    v_pin := (SELECT count(*) FROM public.messages m
                               WHERE m.channel_id = v_job.harmony_channel_id AND m.is_pinned = true) < v_max_pins;
                END IF;

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
            END IF;
        EXCEPTION
            -- Undone with the sub-block: no row, no counter. Lock and cancel errors are not caught.
            WHEN check_violation THEN
                GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
                v_id := NULL;
                v_reason := CASE WHEN v_err_msg = 'BRIDGE_AUTHOR_OPTED_OUT' THEN 'opted_out'
                                 WHEN v_err_msg LIKE 'Message text exceeds%' THEN 'too_long'
                                 ELSE 'check_violation' END;
            WHEN data_exception OR not_null_violation OR foreign_key_violation
                 OR insufficient_privilege OR raise_exception THEN
                v_id := NULL;
                v_reason := 'invalid';
        END;

        IF v_reason IS NOT NULL THEN
            v_rejected := v_rejected || jsonb_build_object('discord_message_id', v_did, 'reason', v_reason);
        END IF;

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
           automod_skipped = i.automod_skipped + v_n_automod,
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
    v_opted boolean;
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
    v_created := LEAST((p_thread ->> 'created_at')::timestamptz, now());

    PERFORM set_config('harmony.history_import', 'true', true);

    PERFORM pg_advisory_xact_lock(hashtext('bridge_thread:' || v_job.bridge_id::text || ':' || v_did));
    SELECT bt.thread_id INTO v_thread_id
      FROM public.discord_bridge_threads bt
     WHERE bt.bridge_id = v_job.bridge_id AND bt.discord_thread_id = v_did;
    IF v_thread_id IS NOT NULL THEN
        RETURN v_thread_id;
    END IF;

    -- The title is the author's text: the thread of an opted-out author, or one started before its
    -- author's last opt-in, is imported under a plain name.
    v_opted := jsonb_typeof(v_user) = 'object' AND (EXISTS (
        SELECT 1
          FROM public.bridge_remote_optouts o
          JOIN public.discord_bridges b ON b.server_id = o.server_id
         WHERE b.id = v_job.bridge_id AND o.platform = 'discord' AND o.remote_user_id = v_user ->> 'id')
        OR EXISTS (
        SELECT 1
          FROM public.bridge_remote_optins i
          JOIN public.discord_bridges b ON b.server_id = i.server_id
         WHERE b.id = v_job.bridge_id AND i.platform = 'discord' AND i.remote_user_id = v_user ->> 'id'
           AND i.opted_in_at > v_created));
    IF v_opted THEN
        v_name := 'Thread';
    END IF;

    v_notice := jsonb_build_object('type', 'thread_created', 'actor_bot_id', p_bot_id, 'thread_name', v_name,
                                   'bridge_source', 'discord', 'history_import', true, 'created_via', 'history_import');
    IF jsonb_typeof(v_user) = 'object' AND v_user ->> 'id' ~ '^[0-9]{1,20}$' AND NOT v_opted THEN
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

COMMIT;

NOTIFY pgrst, 'reload schema';
