-- Voice and video encryption per channel, independent of the server's message encryption mode.
--
-- server_encryption_settings.voice_encryption_mode
--   disabled   per channel: channel_encryption_settings.voice_encrypted decides; new channels
--              start off
--   required   on in every channel; a channel cannot turn it off
-- encryption_mode no longer takes part in voice resolution. Relaxing 'required' to 'disabled'
-- leaves every channel row it wrote on, as relaxing a required message mode does.
--
-- effective_channel_encryption
--   voice_encrypted  voice_mode = 'required' OR channel_encryption_settings.voice_encrypted
--   voice_locked     voice_mode = 'required'
-- set_channel_encryption refuses voice off under 'required' (22023) and accepts voice on under
-- every message mode. Permission checks, message rules and system messages are unchanged.
--
-- Convergence: a row with voice_encrypted = true under encryption_mode 'disabled' (or no policy
-- row) and voice_encryption_mode 'disabled' resolved off before this file; it is written off so
-- the effective state of every channel is unchanged.

BEGIN;

SET LOCAL lock_timeout = '3s';

UPDATE public.channel_encryption_settings ces
   SET voice_encrypted = false,
       updated_at = now()
  FROM public.channels c
  LEFT JOIN public.server_encryption_settings ses ON ses.server_id = c.server_id
 WHERE c.id = ces.channel_id
   AND ces.voice_encrypted
   AND COALESCE(ses.encryption_mode, 'disabled') = 'disabled'
   AND COALESCE(ses.voice_encryption_mode, 'disabled') <> 'required';

-- Mirrors 20261008300001_discord_bridges.sql except voice_encrypted and voice_locked.
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
       AND p.is_active IS TRUE;

    IF v_bridges = 0 AND v_v1_named
       AND EXISTS (SELECT 1 FROM public.discord_bridge_pairings WHERE server_id = v_server_id) THEN
        v_bridges := 1;
    END IF;

    v_bridges := v_bridges + (SELECT count(*)::integer
                                FROM public.discord_bridge_channels dbc
                               WHERE dbc.harmony_channel_id = p_channel_id);

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

-- Mirrors 20261001000001_channel_encryption_settings.sql except the voice floor and the voice
-- before/after resolution.
CREATE OR REPLACE FUNCTION public.set_channel_encryption(
    p_channel_id uuid,
    p_messages_encrypted boolean DEFAULT NULL,
    p_voice_encrypted boolean DEFAULT NULL,
    p_history_visibility text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_server_id uuid;
    v_owner uuid;
    v_is_local boolean;
    v_mode text;
    v_voice_mode text;
    v_row public.channel_encryption_settings;
    v_messages_before boolean;
    v_messages_after boolean;
    v_voice_before boolean;
    v_voice_after boolean;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT c.server_id, s.owner, s.is_local_server
      INTO v_server_id, v_owner, v_is_local
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;

    IF v_server_id IS NULL THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT (
        public.is_current_user_admin()
        OR v_owner = v_caller
        OR (
            EXISTS (SELECT 1 FROM public.user_servers us
                     WHERE us.server_id = v_server_id
                       AND us.user_id = v_caller
                       AND us.status = 'accepted')
            AND public.has_permission(v_caller, v_server_id, 'MANAGE_CHANNELS', p_channel_id)
        )
    ) THEN
        RAISE EXCEPTION 'Missing MANAGE_CHANNELS permission for this channel' USING ERRCODE = '42501';
    END IF;

    IF v_is_local IS NOT TRUE THEN
        RAISE EXCEPTION 'Encryption settings apply to channels of local servers only' USING ERRCODE = '22023';
    END IF;

    IF p_history_visibility IS NOT NULL AND p_history_visibility NOT IN ('joined', 'shared') THEN
        RAISE EXCEPTION 'Unknown history visibility: %', p_history_visibility USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(ses.encryption_mode, 'disabled'), COALESCE(ses.voice_encryption_mode, 'disabled')
      INTO v_mode, v_voice_mode
      FROM (SELECT 1) one
      LEFT JOIN public.server_encryption_settings ses ON ses.server_id = v_server_id;

    IF p_messages_encrypted IS TRUE AND v_mode = 'disabled' THEN
        RAISE EXCEPTION 'End-to-end encryption is disabled for this server' USING ERRCODE = '22023';
    END IF;
    IF p_messages_encrypted IS FALSE AND v_mode IN ('required', 'required_local_only') THEN
        RAISE EXCEPTION 'This server requires end-to-end encryption in every channel' USING ERRCODE = '22023';
    END IF;
    IF p_voice_encrypted IS FALSE AND v_voice_mode = 'required' THEN
        RAISE EXCEPTION 'This server requires end-to-end encrypted voice in every channel' USING ERRCODE = '22023';
    END IF;

    PERFORM public.seed_channel_encryption_settings(ARRAY[p_channel_id]);

    SELECT * INTO v_row
      FROM public.channel_encryption_settings
     WHERE channel_id = p_channel_id
       FOR UPDATE;

    v_messages_before := public.channel_messages_encrypted(p_channel_id);
    v_voice_before := v_voice_mode = 'required' OR v_row.voice_encrypted;

    UPDATE public.channel_encryption_settings
       SET messages_encrypted = COALESCE(p_messages_encrypted, messages_encrypted),
           voice_encrypted = COALESCE(p_voice_encrypted, voice_encrypted),
           history_visibility = COALESCE(p_history_visibility, history_visibility),
           enabled_at = CASE
                          WHEN p_messages_encrypted IS TRUE AND NOT messages_encrypted THEN now()
                          WHEN p_messages_encrypted IS FALSE THEN NULL
                          ELSE enabled_at
                        END,
           enabled_by = CASE
                          WHEN p_messages_encrypted IS TRUE AND NOT messages_encrypted THEN v_caller
                          WHEN p_messages_encrypted IS FALSE THEN NULL
                          ELSE enabled_by
                        END,
           updated_at = now()
     WHERE channel_id = p_channel_id
    RETURNING * INTO v_row;

    v_messages_after := public.channel_messages_encrypted(p_channel_id);
    v_voice_after := v_voice_mode = 'required' OR v_row.voice_encrypted;

    IF v_messages_after AND NOT v_messages_before THEN
        PERFORM public.bump_room_epoch(p_channel_id::text, 'encryption_enabled');
    END IF;

    IF v_messages_after IS DISTINCT FROM v_messages_before THEN
        INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
        VALUES (
            p_channel_id,
            v_caller,
            jsonb_build_array(jsonb_build_object(
                'type', 'text',
                'text', CASE WHEN v_messages_after THEN 'turned on end-to-end encryption'
                             ELSE 'turned off end-to-end encryption' END)),
            true,
            jsonb_build_object('type', CASE WHEN v_messages_after THEN 'channel_encryption_enabled'
                                            ELSE 'channel_encryption_disabled' END)
        );
    END IF;

    IF v_voice_after IS DISTINCT FROM v_voice_before THEN
        INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
        VALUES (
            p_channel_id,
            v_caller,
            jsonb_build_array(jsonb_build_object(
                'type', 'text',
                'text', CASE WHEN v_voice_after THEN 'turned on end-to-end encryption for voice and video'
                             ELSE 'turned off end-to-end encryption for voice and video' END)),
            true,
            jsonb_build_object('type', CASE WHEN v_voice_after THEN 'channel_voice_encryption_enabled'
                                            ELSE 'channel_voice_encryption_disabled' END)
        );
    END IF;

    RETURN public.effective_channel_encryption(p_channel_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_channel_encryption(uuid, boolean, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_channel_encryption(uuid, boolean, boolean, text) TO authenticated;

COMMENT ON COLUMN public.server_encryption_settings.voice_encryption_mode IS
'disabled: each voice channel decides (channel_encryption_settings.voice_encrypted). required: every voice channel encrypts call media end to end.';

COMMIT;
