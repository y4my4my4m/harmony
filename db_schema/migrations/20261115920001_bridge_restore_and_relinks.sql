-- Bridge review, loop rounds 1 to 3.
--
--   message_parts_relinked        whether new message parts differ from the old only by re-signed
--                                 links (same URL before the query) or a file copied into storage
--                                 (a path where there was none): what a link refresh or a mirror
--                                 swap changes.
--   guard_bridge_author_optout    as 20261112600001; takes the author's lock shared, and a silent
--                                 update that only re-signs or mirrors links passes. Link refresh
--                                 and the mirror worker kept failing on the messages an opted-out
--                                 member left on Harmony, whose files then expired with Discord's
--                                 signed links.
--   bridge_author_lock_key        advisory lock key of one remote author of a server's bridge.
--   guard_bridge_reaction_optout  as 20261115500001; takes the author's lock shared.
--   bridge_privacy_set_optout     as 20261115500001; an opt-out takes the author's lock exclusive.
--   bridge_privacy_erase          as 20261115900001; the same, before the opt-out row.
--   bridge_privacy_remove_remote_user  as 20261115900001; the same. A relayed message or reaction
--                                 that passed its guard before the opt-out committed could commit
--                                 after the erase read: it stayed, and the erase ended as done.
--   bridge_import_messages        as 20261115910001; takes the shared lock of every author of the
--                                 batch, in order, before any row lock. The guard took it per row,
--                                 after the job and thread rows, which an erase holding the lock
--                                 then updates: the two deadlocked.
--   bridge_import_server_emoji    as 20261112500001; a rename of a live row keeps bridge_removed_at.
--   bridge_remove_server_emoji    as 20261112500001; refuses an emoji a person restored after the
--                                 bridge removed it (a live row with bridge_removed_at set: the
--                                 bridge's own restore clears it). A mirror sync took it away again.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.message_parts_relinked(p_old jsonb, p_new jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_typeof(p_old) = 'array' AND jsonb_typeof(p_new) = 'array'
       AND jsonb_array_length(p_old) = jsonb_array_length(p_new)
       AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_old) WITH ORDINALITY o(part, i)
             JOIN jsonb_array_elements(p_new) WITH ORDINALITY n(part, i) USING (i)
            WHERE NOT (o.part = n.part OR (
                      jsonb_typeof(o.part) = 'object' AND jsonb_typeof(n.part) = 'object'
                  AND o.part ->> 'type' IN ('file', 'url') AND n.part ->> 'type' IN ('file', 'url')
                  AND (o.part - 'url' - 'path' - 'fileType' - 'type') = (n.part - 'url' - 'path' - 'fileType' - 'type')
                  AND (split_part(o.part ->> 'url', '?', 1) = split_part(n.part ->> 'url', '?', 1)
                       OR (n.part ? 'path' AND NOT o.part ? 'path')))));
$$;
REVOKE ALL ON FUNCTION public.message_parts_relinked(jsonb, jsonb) FROM PUBLIC, anon, authenticated;

-- Advisory lock key of one remote author of a server's bridge. A relayed write takes it shared
-- (the guards below), an opt-out, erase or removal exclusive: the write commits before the erase
-- reads, or sees the opt-out.
CREATE OR REPLACE FUNCTION public.bridge_author_lock_key(p_server_id uuid, p_platform text, p_remote_user_id text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT hashtextextended('bridge_author:' || p_server_id::text || ':' || p_platform || ':' || p_remote_user_id, 0);
$$;
REVOKE ALL ON FUNCTION public.bridge_author_lock_key(uuid, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_bridge_author_optout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_remote text := NEW.metadata #>> '{discord_user,id}';
    v_server uuid;
BEGIN
    IF v_remote IS NULL THEN
        RETURN NEW;
    END IF;
    -- A link refresh or a mirror swap keeps the author's words.
    IF TG_OP = 'UPDATE'
       AND current_setting('harmony.silent_content_update', true) = 'true'
       AND public.message_parts_relinked(OLD.content, NEW.content) THEN
        RETURN NEW;
    END IF;
    SELECT c.server_id INTO v_server
      FROM public.channels c
     WHERE c.id = COALESCE(NEW.channel_id,
                           (SELECT t.channel_id FROM public.threads t WHERE t.id = NEW.thread_id));
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(public.bridge_author_lock_key(v_server, 'discord', v_remote));
    IF EXISTS (
        SELECT 1 FROM public.bridge_remote_optouts o
         WHERE o.server_id = v_server AND o.platform = 'discord' AND o.remote_user_id = v_remote) THEN
        RAISE EXCEPTION 'BRIDGE_AUTHOR_OPTED_OUT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_bridge_author_optout() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_bridge_reaction_optout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_remote text := NEW.metadata #>> '{discord_user,id}';
    v_server uuid;
BEGIN
    IF v_remote IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT c.server_id INTO v_server
      FROM public.channels c
     WHERE c.id = COALESCE(NEW.channel_id,
                           (SELECT m.channel_id FROM public.messages m WHERE m.id = NEW.message_id));
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(public.bridge_author_lock_key(v_server, 'discord', v_remote));
    IF EXISTS (
        SELECT 1 FROM public.bridge_remote_optouts o
         WHERE o.server_id = v_server AND o.platform = 'discord' AND o.remote_user_id = v_remote) THEN
        RAISE EXCEPTION 'BRIDGE_AUTHOR_OPTED_OUT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_bridge_reaction_optout() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.bridge_privacy_set_optout(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_opted_out boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_remote_user_id IS NULL OR p_opted_out IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    IF p_opted_out THEN
        PERFORM pg_advisory_xact_lock(public.bridge_author_lock_key(p_server_id, p_platform, p_remote_user_id));
        INSERT INTO public.bridge_remote_optouts AS o (server_id, platform, remote_user_id, source, self_opted_out)
        VALUES (p_server_id, p_platform, p_remote_user_id, 'self', true)
        ON CONFLICT (server_id, platform, remote_user_id)
            DO UPDATE SET self_opted_out = true WHERE NOT o.self_opted_out;
    ELSE
        -- The user's own choice only: a manager's or admin's removal stays.
        DELETE FROM public.bridge_remote_optouts o
         WHERE o.server_id = p_server_id AND o.platform = p_platform
           AND o.remote_user_id = p_remote_user_id AND o.source = 'self';
        IF NOT FOUND THEN
            UPDATE public.bridge_remote_optouts o
               SET self_opted_out = false
             WHERE o.server_id = p_server_id AND o.platform = p_platform
               AND o.remote_user_id = p_remote_user_id AND o.self_opted_out;
        END IF;
    END IF;
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN public.bridge_privacy_status(p_server_id, p_platform, p_remote_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_privacy_erase(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_server_id IS NULL OR p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(public.bridge_author_lock_key(p_server_id, p_platform, p_remote_user_id));
    INSERT INTO public.bridge_remote_optouts AS o (server_id, platform, remote_user_id, source, self_opted_out)
    VALUES (p_server_id, p_platform, p_remote_user_id, 'self', true)
    ON CONFLICT (server_id, platform, remote_user_id)
        DO UPDATE SET self_opted_out = true WHERE NOT o.self_opted_out;
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN jsonb_build_object('opted_out', true)
           || public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id, 'self',
                  public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, p_limit));
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_privacy_remove_remote_user(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_admin boolean := public.is_current_user_admin();
BEGIN
    IF NOT (v_admin OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can remove a bridged user' USING ERRCODE = '42501';
    END IF;
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    -- The row records the manager's removal beside the user's own opt-out (self_opted_out), which
    -- stays: each is lifted by its own side.
    PERFORM pg_advisory_xact_lock(public.bridge_author_lock_key(p_server_id, p_platform, p_remote_user_id));
    INSERT INTO public.bridge_remote_optouts AS o (server_id, platform, remote_user_id, source, created_by)
    VALUES (p_server_id, p_platform, p_remote_user_id,
            CASE WHEN public.can_manage_discord_bridge(p_server_id) THEN 'manager' ELSE 'admin' END,
            public.get_current_profile_id())
    ON CONFLICT (server_id, platform, remote_user_id)
        DO UPDATE SET source = EXCLUDED.source, created_by = EXCLUDED.created_by WHERE o.source = 'self';
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN public.bridge_privacy_mark_pending(p_server_id, p_platform, p_remote_user_id, 'manager',
               public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, 200));
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
    v_author text;
BEGIN
    -- Every author's lock, in order, before any row lock (the job row here, a thread's row per
    -- thread message): an erase takes its author's lock and then updates those rows.
    SELECT b.server_id INTO v_server
      FROM public.discord_bridge_imports i
      JOIN public.discord_bridges b ON b.id = i.bridge_id
     WHERE i.id = p_import_id;
    IF v_server IS NOT NULL AND jsonb_typeof(p_messages) = 'array' THEN
        FOR v_author IN
            SELECT DISTINCT e.value #>> '{discord_user,id}'
              FROM jsonb_array_elements(p_messages) e
             WHERE jsonb_typeof(e.value) = 'object' AND e.value #>> '{discord_user,id}' IS NOT NULL
             ORDER BY 1
        LOOP
            PERFORM pg_advisory_xact_lock_shared(public.bridge_author_lock_key(v_server, 'discord', v_author));
        END LOOP;
    END IF;

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

CREATE OR REPLACE FUNCTION public.bridge_import_server_emoji(
  p_bot_id uuid,
  p_server_id uuid,
  p_discord_emoji_id text,
  p_name text,
  p_url text,
  p_update boolean DEFAULT false
)
RETURNS TABLE(status text, id uuid, name text, url text, discord_emoji_id text, removed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Output columns share names with emojis columns; references mean the table.
#variable_conflict use_column
DECLARE
  v_row public.emojis%ROWTYPE;
  v_cap integer;
BEGIN
  PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);
  IF p_discord_emoji_id IS NULL OR p_discord_emoji_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'invalid Discord emoji id' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9_]{1,32}$' THEN
    RAISE EXCEPTION 'invalid emoji name' USING ERRCODE = '22023';
  END IF;

  v_cap := public.server_emoji_limit();

  SELECT * INTO v_row FROM public.emojis e
   WHERE e.server_id = p_server_id AND e.discord_emoji_id = p_discord_emoji_id
     FOR UPDATE;
  IF FOUND THEN
    IF NOT p_update
       OR (v_row.deleted_at IS NULL AND v_row.name::text = p_name) THEN
      RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name::text, v_row.url::text,
                          v_row.discord_emoji_id, (v_row.deleted_at IS NOT NULL);
      RETURN;
    END IF;
    IF v_row.deleted_at IS NOT NULL AND v_row.bridge_removed_at IS DISTINCT FROM v_row.deleted_at THEN
      RAISE EXCEPTION 'EMOJI_REMOVED: the bridge restores only emoji it removed' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('server_emojis:' || p_server_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM public.emojis e2
       WHERE e2.server_id = p_server_id AND e2.id <> v_row.id AND e2.deleted_at IS NULL
         AND lower(e2.name::text) = lower(p_name)
    ) THEN
      RAISE EXCEPTION 'An emoji named % exists', p_name USING ERRCODE = '23505';
    END IF;
    IF v_row.deleted_at IS NOT NULL AND v_cap > 0
       AND (SELECT count(*) FROM public.emojis e3
             WHERE e3.server_id = p_server_id AND e3.deleted_at IS NULL) >= v_cap THEN
      RAISE EXCEPTION 'SERVER_EMOJI_LIMIT: at most % emojis per server', v_cap USING ERRCODE = '23514';
    END IF;

    UPDATE public.emojis e
       SET name = p_name, deleted_at = NULL, deleted_by = NULL,
           -- A rename of a live row keeps the mark of a person's restore.
           bridge_removed_at = CASE WHEN e.deleted_at IS NULL THEN e.bridge_removed_at END,
           updated_at = now()
     WHERE e.id = v_row.id
    RETURNING * INTO v_row;
    RETURN QUERY SELECT 'updated'::text, v_row.id, v_row.name::text, v_row.url::text,
                        v_row.discord_emoji_id, false;
    RETURN;
  END IF;

  UPDATE public.emojis e SET discord_emoji_id = p_discord_emoji_id, updated_at = now()
   WHERE e.id = (
     SELECT e2.id FROM public.emojis e2
      WHERE e2.server_id = p_server_id AND e2.discord_emoji_id IS NULL AND e2.deleted_at IS NULL
        AND lower(e2.name::text) = lower(p_name)
      ORDER BY e2.created_at
      LIMIT 1
   )
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN QUERY SELECT 'linked'::text, v_row.id, v_row.name::text, v_row.url::text,
                        v_row.discord_emoji_id, false;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('server_emojis:' || p_server_id::text, 0));
  -- An import of the same Discord emoji that held the lock has committed its row by now.
  SELECT * INTO v_row FROM public.emojis e
   WHERE e.server_id = p_server_id AND e.discord_emoji_id = p_discord_emoji_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name::text, v_row.url::text,
                        v_row.discord_emoji_id, (v_row.deleted_at IS NOT NULL);
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.emojis e2
     WHERE e2.server_id = p_server_id AND e2.deleted_at IS NULL
       AND lower(e2.name::text) = lower(p_name)
  ) THEN
    RAISE EXCEPTION 'An emoji named % exists', p_name USING ERRCODE = '23505';
  END IF;
  IF v_cap > 0 AND (SELECT count(*) FROM public.emojis e3
                     WHERE e3.server_id = p_server_id AND e3.deleted_at IS NULL) >= v_cap THEN
    RAISE EXCEPTION 'SERVER_EMOJI_LIMIT: at most % emojis per server', v_cap USING ERRCODE = '23514';
  END IF;

  IF p_url IS NULL OR p_url !~ '^https?://' THEN
    RAISE EXCEPTION 'invalid emoji url' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.emojis (name, url, server_id, scope, discord_emoji_id)
  VALUES (p_name, p_url, p_server_id, 'server', p_discord_emoji_id)
  ON CONFLICT (server_id, discord_emoji_id) WHERE discord_emoji_id IS NOT NULL DO NOTHING
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.emojis e
     WHERE e.server_id = p_server_id AND e.discord_emoji_id = p_discord_emoji_id;
    RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name::text, v_row.url::text,
                        v_row.discord_emoji_id, (v_row.deleted_at IS NOT NULL);
    RETURN;
  END IF;
  RETURN QUERY SELECT 'created'::text, v_row.id, v_row.name::text, v_row.url::text,
                      v_row.discord_emoji_id, false;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_remove_server_emoji(
  p_bot_id uuid,
  p_server_id uuid,
  p_emoji_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.emojis%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);

  SELECT * INTO v_row FROM public.emojis e
   WHERE e.id = p_emoji_id AND e.server_id = p_server_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'emoji not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.emoji_is_bridge_import(v_row)
     OR (v_row.bridge_removed_at IS NOT NULL AND v_row.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'EMOJI_NOT_LINKED: the bridge removes only emoji it imported' USING ERRCODE = '42501';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RETURN 'existing';
  END IF;

  UPDATE public.emojis e
     SET deleted_at = v_now, deleted_by = NULL, bridge_removed_at = v_now, updated_at = v_now
   WHERE e.id = v_row.id;
  DELETE FROM public.emoji_favorites f WHERE f.emoji_id = v_row.id::text;
  RETURN 'removed';
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
