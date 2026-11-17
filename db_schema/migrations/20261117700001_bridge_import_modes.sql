-- History import through every kind of bridge, and Harmony-side consent for private channels.
--
-- instance_config bridge_history_import
--   "off" (default)   no import
--   "self_run"        bridges of mode self: run by the server's owner with their own Discord application
--   "all"             every bridge: self-run, own-bot hosted and the instance bot. Discord's developer
--                     terms bind the owner of the application that reads the history; through the
--                     instance bot that is the instance operator.
--
-- discord_bridge_import_block(bridge), redefined: instance_off unless the switch is self_run or all;
-- bridge_mode only under self_run, for a bridge of another mode or none.
--
-- discord_bridge_imports.private_approved
--   true when the Harmony-side start of the job carried consent for Discord channels hidden from
--   @everyone. The bridge imports such a channel for a job requested_via 'harmony' only with it
--   (2.8.0); a Discord-side start is the invoker's own approval and stores false.
--
-- discord_bridge_import_start_internal gains p_private_approved (default false), recorded on every
-- row the call queues; a queued row keeps its other fields and takes the new consent.
-- discord_bridge_import_start gains p_include_private (default false), passed through.

BEGIN;

SET LOCAL lock_timeout = '3s';

UPDATE public.instance_config
   SET description = 'Discord history import: off; self_run for bridges a server owner runs with their own Discord application; all for every bridge, the instance bot included.'
 WHERE config_key = 'bridge_history_import';

ALTER TABLE public.discord_bridge_imports
    ADD COLUMN IF NOT EXISTS private_approved boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.discord_bridge_imports.private_approved IS
    'The Harmony-side start consented to Discord channels hidden from @everyone. Read by the bridge for jobs requested_via harmony.';

CREATE OR REPLACE FUNCTION public.discord_bridge_import_block(p_bridge_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH s AS (
        SELECT COALESCE((SELECT ic.config_value #>> '{}' FROM public.instance_config ic
                          WHERE ic.config_key = 'bridge_history_import'), 'off') AS mode
    )
    SELECT CASE
        WHEN s.mode NOT IN ('self_run', 'all') THEN 'instance_off'
        WHEN NOT EXISTS (SELECT 1 FROM public.discord_bridges b WHERE b.id = p_bridge_id) THEN 'bridge_mode'
        WHEN s.mode = 'self_run'
         AND (SELECT b.mode FROM public.discord_bridges b WHERE b.id = p_bridge_id) IS DISTINCT FROM 'self' THEN 'bridge_mode'
    END
    FROM s;
$$;

DROP FUNCTION IF EXISTS public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.discord_bridge_import_start_internal(
    p_bridge_id uuid,
    p_discord_channel_ids text[],
    p_via text,
    p_requested_by uuid,
    p_requested_by_remote jsonb DEFAULT NULL,
    p_private_approved boolean DEFAULT false)
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
    v_private boolean;
BEGIN
    IF p_via IS NULL OR p_via NOT IN ('harmony', 'discord') THEN
        RAISE EXCEPTION 'invalid_patch' USING ERRCODE = '22023', DETAIL = 'requested_via';
    END IF;
    v_private := p_via = 'harmony' AND p_private_approved IS TRUE;

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
                (bridge_id, harmony_channel_id, discord_channel_id, requested_via, requested_by, requested_by_remote,
                 private_approved)
            VALUES (p_bridge_id, v_pair.harmony_channel_id, v_pair.discord_channel_id, p_via, p_requested_by, v_remote,
                    v_private)
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
                   private_approved = v_private,
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
                   private_approved = v_private,
                   updated_at = now(),
                   finished_at = NULL
             WHERE id = v_row.id
            RETURNING * INTO v_row;
        ELSIF v_row.state = 'queued' AND v_private AND NOT v_row.private_approved THEN
            -- Not yet picked up: the consent applies to the run it is waiting for.
            UPDATE public.discord_bridge_imports
               SET private_approved = true,
                   updated_at = now()
             WHERE id = v_row.id
            RETURNING * INTO v_row;
        END IF;

        RETURN NEXT v_row;
    END LOOP;
    RETURN;
END;
$$;

DROP FUNCTION IF EXISTS public.discord_bridge_import_start(uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.discord_bridge_import_start(
    p_bridge_id uuid,
    p_harmony_channel_ids uuid[] DEFAULT NULL,
    p_include_private boolean DEFAULT false)
RETURNS SETOF public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
    v_discord_ids text[];
    v_missing uuid;
BEGIN
    IF p_harmony_channel_ids IS NOT NULL THEN
        SELECT array_agg(p.discord_channel_id) INTO v_discord_ids
          FROM public.discord_bridge_channels p
         WHERE p.bridge_id = v_bridge.id AND p.harmony_channel_id = ANY (p_harmony_channel_ids);
        -- array_agg over no rows is NULL, which the internal start reads as "every pair".
        v_discord_ids := COALESCE(v_discord_ids, ARRAY[]::text[]);

        SELECT h INTO v_missing
          FROM unnest(p_harmony_channel_ids) h
         WHERE NOT EXISTS (SELECT 1 FROM public.discord_bridge_channels p
                            WHERE p.bridge_id = v_bridge.id AND p.harmony_channel_id = h)
         LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION 'pair_not_importable' USING ERRCODE = '22023', DETAIL = v_missing::text;
        END IF;
    END IF;

    RETURN QUERY
    SELECT * FROM public.discord_bridge_import_start_internal(
        v_bridge.id, v_discord_ids, 'harmony', public.get_current_profile_id(), NULL, p_include_private IS TRUE);
END;
$$;

REVOKE ALL ON FUNCTION public.discord_bridge_import_block(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discord_bridge_import_block(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb, boolean)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb, boolean)
    TO service_role;

REVOKE ALL ON FUNCTION public.discord_bridge_import_start(uuid, uuid[], boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.discord_bridge_import_start(uuid, uuid[], boolean) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
