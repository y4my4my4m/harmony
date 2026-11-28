-- Managed Matrix bridges (20261126100001) where the instance counts bots and bridges.
--
--   create_bot                          as 20261109200001; the bot of a matrix_bridges row does not
--                                       count toward max_bots_per_user.
--   bot_rate_limit_check                check_and_increment_bot_rate_limit with a route limit (p_limit)
--                                       apart from p_floor, the limit per window the overall ceiling
--                                       never reads below. Service role.
--   check_and_increment_bot_rate_limit  as 20261109200001, p_floor being the route's limit; the bot of a
--                                       matrix_bridges row has bridge_requests_per_minute.
--   effective_channel_encryption        as 20261021300001; bridge_count also counts the channel's
--                                       active Matrix pairs, of managed and custom bots. A bot that
--                                       relays the channel to Matrix does not count as a bot there,
--                                       and a managed bridge's bot counts in its paired channels only.
--
-- Owners and grants unchanged.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.create_bot(
    p_username text,
    p_display_name text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_bot_type text DEFAULT 'bot',
    p_is_public boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_owner uuid := public.get_current_profile_id();
    v_max integer;
    v_bot public.bots;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_bot_type IS NULL OR p_bot_type NOT IN ('bot', 'bridge') THEN
        RAISE EXCEPTION 'Unsupported bot type: %', p_bot_type USING ERRCODE = '22023';
    END IF;

    v_max := public.instance_count_cap('max_bots_per_user', 25);
    IF v_max > 0 AND NOT public.antispam_account_exempt(v_owner)
       AND (SELECT count(*) FROM public.bots b
             WHERE b.owner_id = v_owner
               AND b.bot_type <> 'integration'
               AND NOT EXISTS (SELECT 1 FROM public.discord_bridges d WHERE d.bot_id = b.id)
               AND NOT EXISTS (SELECT 1 FROM public.matrix_bridges m WHERE m.bot_id = b.id)) >= v_max THEN
        RAISE EXCEPTION 'BOT_LIMIT_REACHED:%', v_max
            USING ERRCODE = 'P0001', HINT = format('An account can own at most %s bots.', v_max);
    END IF;

    INSERT INTO public.bots (username, display_name, bio, bot_type, is_public, owner_id)
    VALUES (p_username,
            COALESCE(NULLIF(btrim(p_display_name), ''), p_username),
            NULLIF(btrim(p_bio), ''),
            p_bot_type,
            COALESCE(p_is_public, true),
            v_owner)
    RETURNING * INTO v_bot;

    RETURN jsonb_build_object('bot', to_jsonb(v_bot))
        || public.issue_bot_token(v_bot.id, 'Default Token');
END;
$$;

CREATE OR REPLACE FUNCTION public.bot_rate_limit_check(
    p_bot_id uuid,
    p_bucket text,
    p_limit integer,
    p_window_seconds integer,
    p_floor integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_wait integer := public.bot_rate_limit_take(p_bot_id, p_bucket, p_limit, p_window_seconds);
    v_overall integer;
BEGIN
    SELECT public.antispam_int(
               public.antispam_settings() -> CASE WHEN EXISTS (SELECT 1 FROM public.discord_bridges d WHERE d.bot_id = b.id)
                                                    OR EXISTS (SELECT 1 FROM public.matrix_bridges m WHERE m.bot_id = b.id)
                                                  THEN 'bridge_requests_per_minute'
                                                  ELSE 'bot_requests_per_minute' END, 0)
      INTO v_overall
      FROM public.bots b
     WHERE b.id = p_bot_id
       AND NOT public.antispam_account_exempt(b.owner_id);

    IF v_overall > 0 THEN
        v_wait := GREATEST(v_wait, public.bot_rate_limit_take(
            p_bot_id, 'overall',
            GREATEST(v_overall, ceil(p_floor * 60.0 / GREATEST(p_window_seconds, 1))::integer), 60));
    END IF;
    RETURN v_wait;
END;
$$;

REVOKE ALL ON FUNCTION public.bot_rate_limit_check(uuid, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_rate_limit_check(uuid, text, integer, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.check_and_increment_bot_rate_limit(
    p_bot_id uuid,
    p_bucket text,
    p_limit integer DEFAULT 100,
    p_window_seconds integer DEFAULT 60
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN public.bot_rate_limit_check(p_bot_id, p_bucket, p_limit, p_window_seconds, p_limit);
END;
$$;

CREATE OR REPLACE FUNCTION public.effective_channel_encryption(p_channel_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_server_id uuid;
    v_owner uuid;
    v_mode text;
    v_voice_mode text;
    v_row public.channel_encryption_settings;
    v_messages boolean;
    v_bots integer;
    v_bridges integer;
    v_v1_named boolean;
BEGIN
    IF v_caller IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT c.server_id, s.owner INTO v_server_id, v_owner
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;

    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_owner IS DISTINCT FROM v_caller
       AND NOT public.is_current_user_admin()
       AND NOT EXISTS (
           SELECT 1 FROM public.user_servers us
            WHERE us.server_id = v_server_id
              AND us.user_id = v_caller
              AND us.status = 'accepted')
    THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(ses.encryption_mode, 'disabled'), COALESCE(ses.voice_encryption_mode, 'disabled')
      INTO v_mode, v_voice_mode
      FROM (SELECT 1) one
      LEFT JOIN public.server_encryption_settings ses ON ses.server_id = v_server_id;

    SELECT * INTO v_row FROM public.channel_encryption_settings WHERE channel_id = p_channel_id;

    v_messages := public.channel_messages_encrypted(p_channel_id);

    SELECT count(*) FILTER (WHERE b.bot_type IS DISTINCT FROM 'bridge'),
           count(*) FILTER (WHERE b.bot_type = 'bridge' AND db.id IS NULL),
           COALESCE(bool_or(db.id IS NULL AND b.username ~* '^discord[-_]?bridge$'), false)
      INTO v_bots, v_bridges, v_v1_named
      FROM public.bot_server_permissions p
      JOIN public.bots b ON b.id = p.bot_id
      LEFT JOIN public.discord_bridges db ON db.bot_id = b.id
     WHERE p.server_id = v_server_id
       AND p.is_active IS TRUE
       AND NOT EXISTS (SELECT 1 FROM public.matrix_bridges mb WHERE mb.bot_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM public.bridge_channels bc
                        WHERE bc.bot_id = b.id AND bc.channel_id = p_channel_id);

    IF v_bridges = 0 AND v_v1_named
       AND EXISTS (SELECT 1 FROM public.discord_bridge_pairings WHERE server_id = v_server_id) THEN
        v_bridges := 1;
    END IF;

    v_bridges := v_bridges + (SELECT count(*)::integer
                                FROM public.discord_bridge_channels dbc
                               WHERE dbc.harmony_channel_id = p_channel_id)
                           + (SELECT count(*)::integer
                                FROM public.bridge_channels bc
                               WHERE bc.channel_id = p_channel_id
                                 AND public.bridge_channel_platform(bc.bot_id, bc.channel_id) = 'matrix');

    RETURN jsonb_build_object(
        'channel_id', p_channel_id,
        'server_id', v_server_id,
        'server_mode', v_mode,
        'voice_mode', v_voice_mode,
        'messages_encrypted', v_messages,
        'voice_encrypted', v_voice_mode = 'required' OR COALESCE(v_row.voice_encrypted, false),
        'messages_locked', v_mode <> 'optional',
        'voice_locked', v_voice_mode = 'required',
        'history_visibility', COALESCE(v_row.history_visibility, 'joined'),
        'enabled_at', CASE WHEN v_messages THEN v_row.enabled_at END,
        'enabled_by', CASE WHEN v_messages THEN v_row.enabled_by END,
        'bot_count', v_bots,
        'bridge_count', v_bridges
    );
END;
$$;

REVOKE ALL ON FUNCTION public.effective_channel_encryption(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.effective_channel_encryption(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
