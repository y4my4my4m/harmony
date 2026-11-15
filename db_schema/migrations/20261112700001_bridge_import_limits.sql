-- History import: the instance switch, limits the server enforces, and refusals per message.
--
-- instance_config
--   bridge_history_import              "off" (default) | "self_run". Public: bridge settings read it.
--   bridge_import_max_running          1    imports running at once on the instance. 0 is no limit.
--   bridge_import_messages_per_minute  600  messages one import stores per minute. 0 is no limit.
--
-- An import runs only with bridge_history_import = self_run and a bridge of mode self: a bridge the
-- server's owner runs with their own Discord application. Never the instance bot, never a hosted
-- bridge. discord_bridge_import_block(bridge) names the reason: instance_off | bridge_mode.
--
-- discord_bridge_imports gains
--   authors_skipped      messages the bridge left out for their author (left the guild, opted out);
--                        the bridge patches the run's total
--   automod_skipped      messages a blocking AutoMod rule refused
--   requested_by_remote  {id, username} of the Discord member who ran the command
--   rate_window_start, rate_window_count   the current minute of bridge_import_admit
--
-- Functions of 20261110900003 and 20261110900005, redefined:
--   discord_bridge_import_start_internal  takes p_requested_by_remote; refuses while import is
--                                         blocked; a reset clears the new counters
--   discord_bridge_import_update          key authors_skipped; error cut to 200 characters; a move
--                                         to running is refused while blocked or at the running cap
--   bridge_import_guard                   a job whose import became blocked is set to failed,
--                                         error import_disabled
--   bridge_import_messages                a message that cannot be stored is rejected alone and
--                                         the batch carries on. Reasons: invalid, future_date,
--                                         opted_out, automod, too_long, check_violation
--   bridge_import_thread                  created_at never after now(); an opted-out starter is
--                                         not named
-- New, service role:
--   bridge_import_admit(bot, import, count) -> {admitted} | {admitted: false, retry_after}
--                                              | {admitted: false, not_running, state, error}
--   bridge_import_automod_hit(...)          owner only
-- New, instance admins:
--   bridge_import_status() -> {running, queued, imported}
--
-- Running cap: a job counts while running and patched or fed within 10 minutes. A running job
-- silent for longer is set to paused when another job asks for the slot; its bridge resumes it
-- through the same check.
--
-- AutoMod: imported rows skip automod_message_guard (20261110900004). With exempt_bots off a live
-- relayed row meets the keyword, preset, invite and link rules; the import applies the blocking
-- ones of those. Flood, duplicate, mention and new-member rules judge live traffic and do not apply.
-- Nothing is recorded per refused message beyond automod_skipped.
--
-- Errors (the message is the code): import_disabled 0A000 (DETAIL = the reason), import_busy 53400
-- (DETAIL = seconds to wait), and those of the earlier migrations.

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('bridge_history_import', '"off"'::jsonb,
        'Discord history import: off, or self_run for bridges a server owner runs with their own Discord application. Never the instance bot.'),
       ('bridge_import_max_running', '1'::jsonb, 'History imports running at once on the instance. 0 is no limit.'),
       ('bridge_import_messages_per_minute', '600'::jsonb, 'Messages one history import stores per minute. 0 is no limit.')
ON CONFLICT (config_key) DO NOTHING;

DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('bridge_history_import' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'bridge_history_import'::text));
    END IF;
END;
$do$;

ALTER TABLE public.discord_bridge_imports
    ADD COLUMN IF NOT EXISTS authors_skipped integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS automod_skipped integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS requested_by_remote jsonb,
    ADD COLUMN IF NOT EXISTS rate_window_start timestamptz,
    ADD COLUMN IF NOT EXISTS rate_window_count integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.discord_bridge_import_block(p_bridge_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN COALESCE((SELECT ic.config_value #>> '{}' FROM public.instance_config ic
                        WHERE ic.config_key = 'bridge_history_import'), 'off') <> 'self_run' THEN 'instance_off'
        WHEN (SELECT b.mode FROM public.discord_bridges b WHERE b.id = p_bridge_id) IS DISTINCT FROM 'self' THEN 'bridge_mode'
    END;
$$;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.discord_bridge_import_start_internal(uuid, text[], text, uuid);

CREATE OR REPLACE FUNCTION public.discord_bridge_import_start_internal(
    p_bridge_id uuid,
    p_discord_channel_ids text[],
    p_via text,
    p_requested_by uuid,
    p_requested_by_remote jsonb DEFAULT NULL)
RETURNS SETOF public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id text;
    v_pair public.discord_bridge_channels;
    v_row public.discord_bridge_imports;
    v_block text;
    v_remote jsonb;
BEGIN
    IF p_via IS NULL OR p_via NOT IN ('harmony', 'discord') THEN
        RAISE EXCEPTION 'invalid_patch' USING ERRCODE = '22023', DETAIL = 'requested_via';
    END IF;

    PERFORM 1 FROM public.discord_bridges WHERE id = p_bridge_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Discord bridge not found' USING ERRCODE = 'P0002';
    END IF;

    v_block := public.discord_bridge_import_block(p_bridge_id);
    IF v_block IS NOT NULL THEN
        RAISE EXCEPTION 'import_disabled' USING ERRCODE = '0A000', DETAIL = v_block;
    END IF;

    IF jsonb_typeof(p_requested_by_remote) = 'object' AND p_requested_by_remote ->> 'id' ~ '^[0-9]{1,20}$' THEN
        v_remote := jsonb_strip_nulls(jsonb_build_object(
            'id', p_requested_by_remote ->> 'id',
            'username', left(regexp_replace(p_requested_by_remote ->> 'username', '[[:cntrl:]]', ' ', 'g'), 100)));
    END IF;

    IF p_discord_channel_ids IS NOT NULL THEN
        FOREACH v_id IN ARRAY p_discord_channel_ids LOOP
            IF v_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.discord_bridge_channels p
                 WHERE p.bridge_id = p_bridge_id
                   AND p.discord_channel_id = v_id
                   AND p.direction IN ('both', 'to_harmony')
                   AND NOT public.channel_messages_encrypted(p.harmony_channel_id)) THEN
                RAISE EXCEPTION 'pair_not_importable' USING ERRCODE = '22023', DETAIL = COALESCE(v_id, '');
            END IF;
        END LOOP;
    END IF;

    FOR v_pair IN
        SELECT p.*
          FROM public.discord_bridge_channels p
         WHERE p.bridge_id = p_bridge_id
           AND p.direction IN ('both', 'to_harmony')
           AND NOT public.channel_messages_encrypted(p.harmony_channel_id)
           AND (p_discord_channel_ids IS NULL OR p.discord_channel_id = ANY (p_discord_channel_ids))
         ORDER BY p.created_at, p.id
    LOOP
        SELECT * INTO v_row
          FROM public.discord_bridge_imports i
         WHERE i.bridge_id = p_bridge_id AND i.harmony_channel_id = v_pair.harmony_channel_id
           FOR UPDATE;

        IF NOT FOUND THEN
            INSERT INTO public.discord_bridge_imports
                (bridge_id, harmony_channel_id, discord_channel_id, requested_via, requested_by, requested_by_remote)
            VALUES (p_bridge_id, v_pair.harmony_channel_id, v_pair.discord_channel_id, p_via, p_requested_by, v_remote)
            RETURNING * INTO v_row;
        ELSIF v_row.discord_channel_id <> v_pair.discord_channel_id OR v_row.state = 'done' THEN
            UPDATE public.discord_bridge_imports
               SET discord_channel_id = v_pair.discord_channel_id,
                   state = 'queued',
                   phase = 'messages',
                   cancel_requested = false,
                   start_discord_message_id = NULL,
                   start_at = NULL,
                   reached_discord_message_id = NULL,
                   reached_at = NULL,
                   channel_created_at = NULL,
                   threads_total = NULL,
                   threads_done = 0,
                   thread_cursor = NULL,
                   imported_count = 0,
                   skipped_count = 0,
                   pins_skipped = 0,
                   authors_skipped = 0,
                   automod_skipped = 0,
                   error = NULL,
                   requested_via = p_via,
                   requested_by = p_requested_by,
                   requested_by_remote = v_remote,
                   updated_at = now(),
                   finished_at = NULL
             WHERE id = v_row.id
            RETURNING * INTO v_row;
        ELSIF v_row.state IN ('failed', 'cancelled', 'paused') THEN
            UPDATE public.discord_bridge_imports
               SET state = 'queued',
                   cancel_requested = false,
                   error = NULL,
                   requested_via = p_via,
                   requested_by = p_requested_by,
                   requested_by_remote = v_remote,
                   updated_at = now(),
                   finished_at = NULL
             WHERE id = v_row.id
            RETURNING * INTO v_row;
        END IF;

        RETURN NEXT v_row;
    END LOOP;
    RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_import_update(
    p_bridge_id uuid,
    p_import_id uuid,
    p_patch jsonb)
RETURNS public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    c_keys constant text[] := ARRAY['state', 'phase', 'start_discord_message_id', 'start_at',
        'reached_discord_message_id', 'reached_at', 'channel_created_at', 'threads_total',
        'threads_done', 'thread_cursor', 'error', 'authors_skipped'];
    c_stale constant interval := interval '10 minutes';
    v_bad text;
    v_row public.discord_bridge_imports;
    v_state text;
    v_cursor jsonb;
    v_block text;
    v_max integer;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'invalid_patch' USING ERRCODE = '22023', DETAIL = 'patch';
    END IF;
    SELECT k INTO v_bad FROM jsonb_object_keys(p_patch) k WHERE k <> ALL (c_keys) LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'invalid_patch' USING ERRCODE = '22023', DETAIL = v_bad;
    END IF;

    SELECT * INTO v_row
      FROM public.discord_bridge_imports i
     WHERE i.id = p_import_id AND i.bridge_id = p_bridge_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'import_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF p_patch ? 'state' THEN
        v_state := p_patch ->> 'state';
        -- running -> running is an idempotent no-op: a restarted bridge resumes a job left running
        -- and begins by patching that state. Every other same-state write is invalid.
        IF NOT (   (v_row.state = 'running' AND v_state = 'running')
                OR (v_row.state = 'queued' AND v_state = 'running')
                OR (v_row.state = 'running' AND v_state IN ('paused', 'done', 'failed'))
                OR (v_row.state = 'running' AND v_state = 'cancelled' AND v_row.cancel_requested)
                OR (v_row.state = 'paused' AND v_state = 'running')) THEN
            RAISE EXCEPTION 'invalid_transition'
                USING ERRCODE = '55000', DETAIL = v_row.state || ' -> ' || COALESCE(v_state, 'null');
        END IF;

        IF v_state = 'running' AND v_row.state <> 'running' THEN
            v_block := public.discord_bridge_import_block(p_bridge_id);
            IF v_block IS NOT NULL THEN
                RAISE EXCEPTION 'import_disabled' USING ERRCODE = '0A000', DETAIL = v_block;
            END IF;

            v_max := public.instance_count_cap('bridge_import_max_running', 1);
            IF v_max > 0 THEN
                -- One job at a time decides: two bridges asking at once would both see a free slot.
                PERFORM pg_advisory_xact_lock(hashtext('bridge_import_running'));
                UPDATE public.discord_bridge_imports i
                   SET state = 'paused', updated_at = now()
                 WHERE i.state = 'running' AND i.id <> v_row.id AND i.updated_at < now() - c_stale;
                IF (SELECT count(*) FROM public.discord_bridge_imports i
                     WHERE i.state = 'running' AND i.id <> v_row.id) >= v_max THEN
                    RAISE EXCEPTION 'import_busy' USING ERRCODE = '53400', DETAIL = '30';
                END IF;
            END IF;
        END IF;
    END IF;

    v_cursor := p_patch -> 'thread_cursor';
    IF jsonb_typeof(v_cursor) = 'null' THEN
        v_cursor := NULL;
    END IF;

    UPDATE public.discord_bridge_imports i
       SET state = COALESCE(v_state, i.state),
           phase = CASE WHEN p_patch ? 'phase' THEN p_patch ->> 'phase' ELSE i.phase END,
           start_discord_message_id = CASE WHEN p_patch ? 'start_discord_message_id'
               THEN p_patch ->> 'start_discord_message_id' ELSE i.start_discord_message_id END,
           start_at = CASE WHEN p_patch ? 'start_at'
               THEN (p_patch ->> 'start_at')::timestamptz ELSE i.start_at END,
           reached_discord_message_id = CASE WHEN p_patch ? 'reached_discord_message_id'
               THEN p_patch ->> 'reached_discord_message_id' ELSE i.reached_discord_message_id END,
           reached_at = CASE WHEN p_patch ? 'reached_at'
               THEN (p_patch ->> 'reached_at')::timestamptz ELSE i.reached_at END,
           channel_created_at = CASE WHEN p_patch ? 'channel_created_at'
               THEN (p_patch ->> 'channel_created_at')::timestamptz ELSE i.channel_created_at END,
           threads_total = CASE WHEN p_patch ? 'threads_total'
               THEN (p_patch ->> 'threads_total')::integer ELSE i.threads_total END,
           threads_done = CASE WHEN p_patch ? 'threads_done'
               THEN (p_patch ->> 'threads_done')::integer ELSE i.threads_done END,
           thread_cursor = CASE WHEN p_patch ? 'thread_cursor' THEN v_cursor ELSE i.thread_cursor END,
           error = CASE WHEN p_patch ? 'error' THEN left(p_patch ->> 'error', 200) ELSE i.error END,
           authors_skipped = CASE WHEN p_patch ? 'authors_skipped'
               THEN GREATEST((p_patch ->> 'authors_skipped')::integer, 0) ELSE i.authors_skipped END,
           updated_at = now(),
           finished_at = CASE WHEN v_state IN ('done', 'failed', 'cancelled') THEN now()
                              ELSE i.finished_at END
     WHERE i.id = v_row.id
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

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
    IF public.discord_bridge_import_block(v_job.bridge_id) IS NOT NULL THEN
        v_error := 'import_disabled';
    ELSIF v_pair.id IS NULL OR v_pair.discord_channel_id <> v_job.discord_channel_id THEN
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

-- Admits p_count messages into the job's current minute, or says how long to wait. A minute
-- always admits its first batch, so a rate below the batch size still moves.
CREATE OR REPLACE FUNCTION public.bridge_import_admit(p_bot_id uuid, p_import_id uuid, p_count integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.discord_bridge_imports;
    v_rate integer;
    v_start timestamptz;
    v_used integer;
    v_count integer := GREATEST(COALESCE(p_count, 0), 0);
BEGIN
    v_job := public.bridge_import_guard(p_bot_id, p_import_id);
    IF v_job.state <> 'running' THEN
        RETURN jsonb_build_object('admitted', false, 'not_running', true, 'state', v_job.state, 'error', v_job.error);
    END IF;

    v_rate := public.instance_count_cap('bridge_import_messages_per_minute', 600);
    v_start := v_job.rate_window_start;
    v_used := v_job.rate_window_count;
    IF v_start IS NULL OR v_start <= now() - interval '60 seconds' THEN
        v_start := now();
        v_used := 0;
    END IF;
    IF v_rate > 0 AND v_used > 0 AND v_used + v_count > v_rate THEN
        RETURN jsonb_build_object('admitted', false,
            'retry_after', GREATEST(ceil(60 - extract(epoch FROM now() - v_start))::integer, 1));
    END IF;

    UPDATE public.discord_bridge_imports i
       SET rate_window_start = v_start, rate_window_count = v_used + v_count, updated_at = now()
     WHERE i.id = v_job.id;
    RETURN jsonb_build_object('admitted', true);
END;
$$;

-- ---------------------------------------------------------------------------
-- AutoMod for imported content
-- ---------------------------------------------------------------------------

-- The match of the first blocking keyword, keyword_preset, invites or links rule of p_compiled
-- (server_automod_settings.compiled) that p_content meets in the channel, else NULL. The rule
-- evaluation of automod_check_message (20261110400001) for those types.
CREATE OR REPLACE FUNCTION public.bridge_import_automod_hit(
    p_compiled jsonb,
    p_server_id uuid,
    p_channel_id uuid,
    p_category uuid,
    p_content jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rule jsonb;
    v_cfg jsonb;
    v_type text;
    v_hit text;
    v_raw text;
    v_urls text[];
    v_norm text;
    v_subject text;
    v_re text;
    v_hosts text[];
    v_hosts_done boolean := false;
    v_host text;
    v_domain text;
    v_listed boolean;
BEGIN
    IF jsonb_typeof(p_content) <> 'array' OR jsonb_typeof(p_compiled -> 'rules') <> 'array' THEN
        RETURN NULL;
    END IF;

    SELECT string_agg(CASE WHEN e ->> 'type' = 'text' THEN e ->> 'text' ELSE e ->> 'label' END, E'\n')
               FILTER (WHERE (e ->> 'type' = 'text' AND e ->> 'text' IS NOT NULL)
                          OR (e ->> 'type' = 'url' AND jsonb_typeof(e -> 'label') = 'string')),
           array_agg(e ->> 'url') FILTER (WHERE e ->> 'type' IN ('url', 'embed') AND e ->> 'url' IS NOT NULL)
      INTO v_raw, v_urls
      FROM jsonb_array_elements(p_content) e;

    FOR v_rule IN SELECT r FROM jsonb_array_elements(p_compiled -> 'rules') r LOOP
        v_type := v_rule ->> 'type';
        v_cfg := v_rule -> 'c';
        v_hit := NULL;

        CONTINUE WHEN NOT COALESCE((v_rule -> 'a' ->> 'block')::boolean, false);
        CONTINUE WHEN v_type NOT IN ('keyword', 'keyword_preset', 'invites', 'links');
        IF (v_rule -> 'xc') ? p_channel_id::text
           OR (p_category IS NOT NULL AND (v_rule -> 'xc') ? p_category::text) THEN
            CONTINUE;
        END IF;

        IF v_type IN ('keyword', 'keyword_preset') THEN
            CONTINUE WHEN v_raw IS NULL;
            IF v_norm IS NULL THEN
                v_norm := public.automod_normalize(v_raw);
            END IF;
            v_subject := v_norm;
            IF v_cfg ? 'allow' THEN
                v_subject := regexp_replace(v_subject, v_cfg ->> 'allow', ' ', 'g');
            END IF;
            IF v_cfg ? 'pattern' AND v_subject ~ (v_cfg ->> 'pattern') THEN
                v_hit := COALESCE((regexp_match(v_subject, v_cfg ->> 'pattern'))[1], 'keyword');
            END IF;
            IF v_hit IS NULL AND v_cfg ? 'regex' THEN
                FOR v_re IN SELECT jsonb_array_elements_text(v_cfg -> 'regex') LOOP
                    IF v_raw ~* v_re THEN
                        v_hit := COALESCE((regexp_match(v_raw, v_re, 'i'))[1], 'regex');
                    ELSIF v_subject ~* v_re THEN
                        v_hit := COALESCE((regexp_match(v_subject, v_re, 'i'))[1], 'regex');
                    END IF;
                    EXIT WHEN v_hit IS NOT NULL;
                END LOOP;
            END IF;

        ELSIF v_type = 'invites' THEN
            CONTINUE WHEN v_raw IS NULL AND v_urls IS NULL;
            v_hit := public.automod_foreign_invite(v_raw, v_urls, p_server_id);

        ELSE
            CONTINUE WHEN v_raw IS NULL AND v_urls IS NULL;
            IF NOT v_hosts_done THEN
                v_hosts := public.automod_link_hosts(v_raw, v_urls);
                v_hosts_done := true;
            END IF;
            FOREACH v_host IN ARRAY COALESCE(v_hosts, ARRAY[]::text[]) LOOP
                v_listed := false;
                FOR v_domain IN SELECT jsonb_array_elements_text(v_cfg -> 'domains') LOOP
                    IF v_host = v_domain OR right(v_host, char_length(v_domain) + 1) = '.' || v_domain THEN
                        v_listed := true;
                        EXIT;
                    END IF;
                END LOOP;
                IF (v_cfg ->> 'mode' = 'allow_list' AND NOT v_listed)
                   OR (v_cfg ->> 'mode' = 'block_list' AND v_listed) THEN
                    v_hit := v_host;
                    EXIT;
                END IF;
            END LOOP;
        END IF;

        IF v_hit IS NOT NULL THEN
            RETURN v_hit;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Inserts
-- ---------------------------------------------------------------------------

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

    v_notice := jsonb_build_object('type', 'thread_created', 'actor_bot_id', p_bot_id, 'thread_name', v_name,
                                   'bridge_source', 'discord', 'history_import', true, 'created_via', 'history_import');
    IF jsonb_typeof(v_user) = 'object' AND v_user ->> 'id' ~ '^[0-9]{1,20}$'
       AND NOT EXISTS (SELECT 1
                         FROM public.bridge_remote_optouts o
                         JOIN public.discord_bridges b ON b.server_id = o.server_id
                        WHERE b.id = v_job.bridge_id AND o.platform = 'discord'
                          AND o.remote_user_id = v_user ->> 'id') THEN
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

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_import_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Only instance admins can read the import totals' USING ERRCODE = '42501';
    END IF;
    RETURN (
        SELECT jsonb_build_object(
            'running', count(*) FILTER (WHERE i.state = 'running'),
            'queued', count(*) FILTER (WHERE i.state IN ('queued', 'paused')),
            'imported', COALESCE(sum(i.imported_count), 0))
          FROM public.discord_bridge_imports i);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_import_block(uuid)',
        'public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb)',
        'public.discord_bridge_import_update(uuid, uuid, jsonb)',
        'public.bridge_import_guard(uuid, uuid)',
        'public.bridge_import_admit(uuid, uuid, integer)',
        'public.bridge_import_messages(uuid, uuid, jsonb)',
        'public.bridge_import_thread(uuid, uuid, jsonb)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_import_automod_hit(jsonb, uuid, uuid, uuid, jsonb)
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.bridge_import_status() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bridge_import_status() TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
