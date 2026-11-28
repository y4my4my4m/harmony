-- Matrix bridge: channel bindings of a Matrix bridge bot, and members who keep their messages off a
-- server's bridges.
--
-- bots.bridge_platform              'matrix' or NULL. Set by configure_matrix_bridge, cleared by
--                                   unconfigure_matrix_bridge once the bot has no binding left.
--                                   bot_type is never written. Clients cannot change it
--                                   (a_bots_bridge_platform_guard, 42501).
-- bridge_channels                   (bot_id, channel_id) a Matrix bot relays; room_id the bound
--                                   Matrix room (one channel per room), sender_mode 'ghost' | 'relay'.
--                                   Service role only.
-- bridge_channel_platform(bot, channel) -> 'matrix' | 'discord' | NULL
--   'matrix'   bridge_platform 'matrix', an active bot, a bridge_channels row, and an active
--              read + send install whose allowlist holds the channel (NULL allowlist: every channel).
--   'discord'  bot_type 'bridge' and BotRestAPI.lookupBridgePair of bot-gateway (1.9.8): a
--              discord_bridge_channels row of the bot's discord_bridges row for the channel; or, for
--              a bot with no discord_bridges row, a v1 discord_bridge_pairings row of the channel's
--              server whose created_by or the server owner is the bot's owner or the install's
--              installed_by.
--
-- Authenticated:
--   configure_matrix_bridge(bot, server, channels)  the bot's owner, who manages the server
--                                   (can_manage_discord_bridge). An active bot that is no Discord
--                                   bridge (no discord_bridges row; not bot_type 'bridge' installed
--                                   on a server whose v1 pairing trusts it), an active scoped read +
--                                   send install, text channels of the server in the allowlist.
--                                   Replaces the bot's bindings in the server; a kept channel keeps
--                                   its room and mode.
--   unconfigure_matrix_bridge(bot, server)  the bot's owner or a manager of the server: removes the
--                                   bot's bindings in the server. true when any went.
--   get_server_matrix_bridges(server)  managers: jsonb array of the server's bindings.
--   set_matrix_bridge_sender_mode(bot, channel, mode)  managers, an active binding: the binding.
-- Service role:
--   matrix_bridge_bind_room(bot, channel, room, initial mode)  the first room wins; another room
--                                   needs the binding removed first (22023); a room bound elsewhere
--                                   is refused (23505). A manager's mode outlives the initial one.
--   matrix_bridge_room(bot, channel)  {room_id, sender_mode}.
--   matrix_bridge_channel_members(bot, channel, limit, after)  local accepted members who view the
--                                   channel and have not opted out of 'matrix', by id after `after`,
--                                   at most limit (1 to 1000). An open channel reads the membership
--                                   in id order; a restricted one evaluates channel_viewer_ids once.
-- Errors: 42501 for a caller without the right or a pair that is not an active Matrix pair, 22023
-- for invalid input, P0002 for a missing binding.
--
-- Member opt-out (Harmony members whose messages a server's bridges of a platform do not relay):
--   bridge_member_optouts            (server_id, user_id, platform). A member reads their own rows;
--                                    no client writes. Kept through leave, kick, ban and rejoin;
--                                    gone with the server or the profile.
--   bridge_member_privacy(server)    {discord: {bridged, opted_out}, matrix: {bridged, opted_out}}.
--                                    bridged: the server has a discord_bridges row or a v1 pairing
--                                    (discord), a bridge_channels row in one of its channels
--                                    (matrix); false for a caller who is not an accepted member or
--                                    the owner.
--   set_bridge_member_optout(server, platform, opted_out)  the same answer. Opting out needs
--                                    accepted membership; opting in does not.
--   bridge_member_optout_ids(server, platform) -> {user_ids}   service role.
--   bridge_member_relay_allowed(bot, channel, user) -> boolean service role. false when
--                                    bridge_channel_platform(bot, channel) is a platform the user
--                                    opted out of in the channel's server. No membership check.
-- The database filters no delivery: bot-gateway withholds creates, updates and reaction adds of an
-- opted-out member from bridge readers of that platform.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS bridge_platform text;
ALTER TABLE public.bots DROP CONSTRAINT IF EXISTS bots_bridge_platform_check;
ALTER TABLE public.bots ADD CONSTRAINT bots_bridge_platform_check CHECK (bridge_platform = 'matrix');

CREATE TABLE IF NOT EXISTS public.bridge_channels (
    bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    platform text NOT NULL,
    room_id text,
    sender_mode text NOT NULL DEFAULT 'relay',
    sender_mode_set_by_manager boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_id, channel_id),
    CONSTRAINT bridge_channels_platform_check CHECK (platform = 'matrix'),
    -- Matrix room ids are opaque: room version 12 drops the ':server' suffix.
    CONSTRAINT bridge_channels_room_id_check
        CHECK (char_length(room_id) BETWEEN 2 AND 255 AND room_id ~ '^![^[:space:][:cntrl:]/]+$'),
    CONSTRAINT bridge_channels_sender_mode_check CHECK (sender_mode IN ('ghost', 'relay')),
    CONSTRAINT bridge_channels_room_id_key UNIQUE (room_id)
);

CREATE INDEX IF NOT EXISTS bridge_channels_channel_idx ON public.bridge_channels (channel_id);

COMMENT ON TABLE public.bridge_channels IS
    'Channels a Matrix bridge bot relays, and the Matrix room of each. Written through configure_matrix_bridge and matrix_bridge_bind_room.';

REVOKE ALL ON public.bridge_channels FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bridge_channels TO service_role;
ALTER TABLE public.bridge_channels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bridge_channels_service_role ON public.bridge_channels;
CREATE POLICY bridge_channels_service_role ON public.bridge_channels
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.bridge_member_optouts (
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    platform text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, user_id, platform),
    CONSTRAINT bridge_member_optouts_platform_check CHECK (platform ~ '^[a-z][a-z0-9_]{1,31}$')
);

CREATE INDEX IF NOT EXISTS bridge_member_optouts_user_idx ON public.bridge_member_optouts (user_id);

COMMENT ON TABLE public.bridge_member_optouts IS
    'Members whose messages a server''s bridges of a platform do not relay. Written through set_bridge_member_optout.';

REVOKE ALL ON public.bridge_member_optouts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bridge_member_optouts TO authenticated;
GRANT ALL ON public.bridge_member_optouts TO service_role;
ALTER TABLE public.bridge_member_optouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bridge_member_optouts_service_role ON public.bridge_member_optouts;
CREATE POLICY bridge_member_optouts_service_role ON public.bridge_member_optouts
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS bridge_member_optouts_select_own ON public.bridge_member_optouts;
CREATE POLICY bridge_member_optouts_select_own ON public.bridge_member_optouts
    FOR SELECT TO authenticated
    USING (user_id = (SELECT public.get_current_profile_id()));

-- authenticated holds table-wide UPDATE on bots; the column is written by the definer functions.
CREATE OR REPLACE FUNCTION public.refuse_client_bridge_platform()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    RAISE EXCEPTION 'bridge_platform is set through configure_matrix_bridge' USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.refuse_client_bridge_platform() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_bots_bridge_platform_guard ON public.bots;
CREATE TRIGGER a_bots_bridge_platform_guard
    BEFORE UPDATE OF bridge_platform ON public.bots
    FOR EACH ROW
    WHEN (CURRENT_USER = ANY (ARRAY['authenticated'::name, 'anon'::name])
          AND NEW.bridge_platform IS DISTINCT FROM OLD.bridge_platform)
    EXECUTE FUNCTION public.refuse_client_bridge_platform();

-- ---------------------------------------------------------------------------
-- Platform of a bot in a channel
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_channel_platform(p_bot_id uuid, p_channel_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT CASE
             WHEN b.bridge_platform = 'matrix'
                  AND b.is_active IS TRUE
                  AND EXISTS (SELECT 1 FROM public.bridge_channels bc
                               WHERE bc.bot_id = b.id AND bc.channel_id = c.id AND bc.platform = 'matrix')
                  AND EXISTS (SELECT 1 FROM public.bot_server_permissions p
                               WHERE p.bot_id = b.id AND p.server_id = c.server_id
                                 AND p.is_active IS TRUE AND p.read_messages IS TRUE AND p.send_messages IS TRUE
                                 AND (p.allowed_channel_ids IS NULL OR c.id = ANY (p.allowed_channel_ids)))
               THEN 'matrix'
             WHEN b.bot_type = 'bridge'
                  AND CASE WHEN EXISTS (SELECT 1 FROM public.discord_bridges db WHERE db.bot_id = b.id)
                           THEN EXISTS (SELECT 1
                                          FROM public.discord_bridges db
                                          JOIN public.discord_bridge_channels dc ON dc.bridge_id = db.id
                                         WHERE db.bot_id = b.id AND dc.harmony_channel_id = c.id)
                           ELSE EXISTS (SELECT 1
                                          FROM public.discord_bridge_pairings dp
                                          JOIN public.servers s ON s.id = dp.server_id
                                          LEFT JOIN public.bot_server_permissions p
                                                 ON p.bot_id = b.id AND p.server_id = dp.server_id
                                         WHERE dp.server_id = c.server_id
                                           AND (b.owner_id IN (dp.created_by, s.owner)
                                                OR p.installed_by IN (dp.created_by, s.owner)))
                      END
               THEN 'discord'
           END
      FROM public.bots b, public.channels c
     WHERE b.id = p_bot_id AND c.id = p_channel_id;
$$;

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.configure_matrix_bridge(p_bot_id uuid, p_server_id uuid, p_channel_ids uuid[])
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_bot public.bots;
    v_install public.bot_server_permissions;
    v_channels uuid[];
BEGIN
    IF p_channel_ids IS NULL OR array_position(p_channel_ids, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'p_channel_ids must be an array without nulls' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_bot FROM public.bots b WHERE b.id = p_bot_id FOR UPDATE;
    IF NOT FOUND OR v_me IS NULL OR v_bot.owner_id IS DISTINCT FROM v_me THEN
        RAISE EXCEPTION 'Only the bot''s owner configures its Matrix bridge' USING ERRCODE = '42501';
    END IF;
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'MANAGE_SERVER required' USING ERRCODE = '42501';
    END IF;
    IF v_bot.is_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Active bot required' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.discord_bridges db WHERE db.bot_id = p_bot_id)
       OR (v_bot.bot_type = 'bridge' AND EXISTS (
               SELECT 1
                 FROM public.discord_bridge_pairings dp
                 JOIN public.servers s ON s.id = dp.server_id
                 JOIN public.bot_server_permissions p
                   ON p.bot_id = p_bot_id AND p.server_id = dp.server_id
                WHERE v_bot.owner_id IN (dp.created_by, s.owner)
                   OR p.installed_by IN (dp.created_by, s.owner))) THEN
        RAISE EXCEPTION 'A Discord bridge bot cannot bridge Matrix' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_install
      FROM public.bot_server_permissions p
     WHERE p.bot_id = p_bot_id AND p.server_id = p_server_id
       FOR SHARE;
    IF NOT FOUND OR v_install.is_active IS NOT TRUE OR v_install.read_messages IS NOT TRUE
       OR v_install.send_messages IS NOT TRUE OR v_install.allowed_channel_ids IS NULL THEN
        RAISE EXCEPTION 'Active scoped read and send install required' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_channels FROM unnest(p_channel_ids) x;
    IF EXISTS (SELECT 1 FROM unnest(v_channels) x
                WHERE NOT (x = ANY (v_install.allowed_channel_ids))
                   OR NOT EXISTS (SELECT 1 FROM public.channels c
                                   WHERE c.id = x AND c.server_id = p_server_id AND c.type = 0)) THEN
        RAISE EXCEPTION 'Channels must be text channels of the server in the install allowlist' USING ERRCODE = '22023';
    END IF;

    UPDATE public.bots b SET bridge_platform = 'matrix'
     WHERE b.id = p_bot_id AND b.bridge_platform IS DISTINCT FROM 'matrix';
    DELETE FROM public.bridge_channels bc
     USING public.channels c
     WHERE bc.bot_id = p_bot_id AND c.id = bc.channel_id AND c.server_id = p_server_id
       AND NOT (bc.channel_id = ANY (v_channels));
    INSERT INTO public.bridge_channels (bot_id, channel_id, platform)
    SELECT p_bot_id, x, 'matrix' FROM unnest(v_channels) x
    ON CONFLICT (bot_id, channel_id) DO NOTHING;
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.unconfigure_matrix_bridge(p_bot_id uuid, p_server_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_count integer;
BEGIN
    PERFORM 1 FROM public.bots b WHERE b.id = p_bot_id FOR UPDATE;
    IF v_me IS NULL OR NOT (
           EXISTS (SELECT 1 FROM public.bots b WHERE b.id = p_bot_id AND b.owner_id = v_me)
           OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only the bot''s owner or a manager of the server removes its Matrix bridge'
            USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.bridge_channels bc
     USING public.channels c
     WHERE bc.bot_id = p_bot_id AND c.id = bc.channel_id AND c.server_id = p_server_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE public.bots b SET bridge_platform = NULL
     WHERE b.id = p_bot_id AND b.bridge_platform IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.bridge_channels bc WHERE bc.bot_id = p_bot_id);
    RETURN v_count > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_binding_json(p_bot_id uuid, p_channel_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
               'bot_id', bc.bot_id,
               'bot_username', b.username,
               'bot_display_name', COALESCE(b.display_name, b.username),
               'channel_id', bc.channel_id,
               'channel_name', c.name,
               'room_id', bc.room_id,
               'sender_mode', bc.sender_mode,
               'sender_mode_set_by_manager', bc.sender_mode_set_by_manager,
               'active', COALESCE(public.bridge_channel_platform(bc.bot_id, bc.channel_id) = 'matrix', false))
      FROM public.bridge_channels bc
      JOIN public.channels c ON c.id = bc.channel_id
      JOIN public.bots b ON b.id = bc.bot_id
     WHERE bc.bot_id = p_bot_id AND bc.channel_id = p_channel_id;
$$;

CREATE OR REPLACE FUNCTION public.get_server_matrix_bridges(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'MANAGE_SERVER required' USING ERRCODE = '42501';
    END IF;
    RETURN (SELECT COALESCE(jsonb_agg(public.matrix_bridge_binding_json(bc.bot_id, bc.channel_id)
                                      ORDER BY c.name, bc.channel_id, bc.bot_id), '[]'::jsonb)
              FROM public.bridge_channels bc
              JOIN public.channels c ON c.id = bc.channel_id
             WHERE c.server_id = p_server_id);
END;
$$;

-- sender_mode_set_by_manager tells a manager's relay from the default relay.
CREATE OR REPLACE FUNCTION public.set_matrix_bridge_sender_mode(p_bot_id uuid, p_channel_id uuid, p_sender_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel_id;
    IF v_server IS NULL OR NOT public.can_manage_discord_bridge(v_server) THEN
        RAISE EXCEPTION 'MANAGE_SERVER required' USING ERRCODE = '42501';
    END IF;
    IF p_sender_mode IS NULL OR p_sender_mode NOT IN ('ghost', 'relay') THEN
        RAISE EXCEPTION 'Invalid Matrix sender mode' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.bridge_channels bc
     WHERE bc.bot_id = p_bot_id AND bc.channel_id = p_channel_id
       FOR UPDATE;
    IF NOT FOUND OR public.bridge_channel_platform(p_bot_id, p_channel_id) IS DISTINCT FROM 'matrix' THEN
        RAISE EXCEPTION 'No active Matrix binding' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.bridge_channels bc
       SET sender_mode = p_sender_mode, sender_mode_set_by_manager = true
     WHERE bc.bot_id = p_bot_id AND bc.channel_id = p_channel_id;
    RETURN public.matrix_bridge_binding_json(p_bot_id, p_channel_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Service role
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.matrix_bridge_bind_room(
    p_bot_id uuid, p_channel_id uuid, p_room_id text, p_initial_sender_mode text DEFAULT 'relay')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_binding public.bridge_channels;
BEGIN
    SELECT * INTO v_binding FROM public.bridge_channels bc
     WHERE bc.bot_id = p_bot_id AND bc.channel_id = p_channel_id
       FOR UPDATE;
    IF NOT FOUND OR public.bridge_channel_platform(p_bot_id, p_channel_id) IS DISTINCT FROM 'matrix' THEN
        RAISE EXCEPTION 'Active Matrix binding required' USING ERRCODE = '42501';
    END IF;
    IF p_room_id IS NULL OR char_length(p_room_id) NOT BETWEEN 2 AND 255
       OR p_room_id !~ '^![^[:space:][:cntrl:]/]+$'
       OR p_initial_sender_mode IS NULL OR p_initial_sender_mode NOT IN ('ghost', 'relay') THEN
        RAISE EXCEPTION 'Invalid Matrix room id or sender mode' USING ERRCODE = '22023';
    END IF;
    IF v_binding.room_id IS NOT NULL AND v_binding.room_id <> p_room_id THEN
        RAISE EXCEPTION 'Remove the binding before assigning another Matrix room' USING ERRCODE = '22023';
    END IF;
    IF v_binding.room_id IS NULL THEN
        IF EXISTS (SELECT 1 FROM public.bridge_channels bc WHERE bc.room_id = p_room_id) THEN
            RAISE EXCEPTION 'The Matrix room is bound to another channel' USING ERRCODE = '23505';
        END IF;
        UPDATE public.bridge_channels bc
           SET room_id = p_room_id,
               sender_mode = CASE WHEN bc.sender_mode_set_by_manager THEN bc.sender_mode ELSE p_initial_sender_mode END
         WHERE bc.bot_id = p_bot_id AND bc.channel_id = p_channel_id
        RETURNING * INTO v_binding;
    END IF;
    RETURN jsonb_build_object('room_id', v_binding.room_id, 'sender_mode', v_binding.sender_mode);
END;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_room(p_bot_id uuid, p_channel_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_binding public.bridge_channels;
BEGIN
    SELECT * INTO v_binding FROM public.bridge_channels bc
     WHERE bc.bot_id = p_bot_id AND bc.channel_id = p_channel_id;
    IF NOT FOUND OR public.bridge_channel_platform(p_bot_id, p_channel_id) IS DISTINCT FROM 'matrix' THEN
        RAISE EXCEPTION 'Active Matrix binding required' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object('room_id', v_binding.room_id, 'sender_mode', v_binding.sender_mode);
END;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_channel_members(
    p_bot_id uuid, p_channel_id uuid, p_limit integer DEFAULT 1000, p_after uuid DEFAULT NULL)
RETURNS TABLE (id uuid, username text, display_name text, avatar_url text, nickname text, domain text, is_local boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
    v_server uuid;
BEGIN
    IF public.bridge_channel_platform(p_bot_id, p_channel_id) IS DISTINCT FROM 'matrix' THEN
        RAISE EXCEPTION 'Active Matrix binding required' USING ERRCODE = '42501';
    END IF;
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel_id;

    IF NOT public.channel_is_restricted(p_channel_id) THEN
        -- Every accepted member views an open channel (can_view_channel).
        RETURN QUERY
        SELECT p.id, p.username, COALESCE(NULLIF(us.nickname, ''), p.display_name, p.username),
               p.avatar_url, us.nickname, p.domain, p.is_local
          FROM public.user_servers us
          JOIN public.profiles p ON p.id = us.user_id
         WHERE us.server_id = v_server AND us.status = 'accepted'
           AND (p_after IS NULL OR us.user_id > p_after)
           AND p.is_local IS TRUE AND p.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.bridge_member_optouts o
                            WHERE o.server_id = v_server AND o.user_id = us.user_id AND o.platform = 'matrix')
         ORDER BY us.user_id
         LIMIT v_limit;
    ELSE
        RETURN QUERY
        SELECT p.id, p.username, COALESCE(NULLIF(us.nickname, ''), p.display_name, p.username),
               p.avatar_url, us.nickname, p.domain, p.is_local
          FROM public.channel_viewer_ids(p_channel_id) v(user_id)
          JOIN public.user_servers us ON us.server_id = v_server AND us.user_id = v.user_id
          JOIN public.profiles p ON p.id = us.user_id
         WHERE us.status = 'accepted'
           AND (p_after IS NULL OR v.user_id > p_after)
           AND p.is_local IS TRUE AND p.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.bridge_member_optouts o
                            WHERE o.server_id = v_server AND o.user_id = us.user_id AND o.platform = 'matrix')
         ORDER BY v.user_id
         LIMIT v_limit;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Member opt-out
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_member_privacy(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_member boolean;
BEGIN
    v_member := v_me IS NOT NULL AND (
        EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_me)
        OR EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted'));
    RETURN jsonb_build_object(
        'discord', jsonb_build_object(
            'bridged', v_member AND (
                EXISTS (SELECT 1 FROM public.discord_bridges b WHERE b.server_id = p_server_id)
                OR EXISTS (SELECT 1 FROM public.discord_bridge_pairings dp WHERE dp.server_id = p_server_id)),
            'opted_out', EXISTS (SELECT 1 FROM public.bridge_member_optouts o
                                  WHERE o.server_id = p_server_id AND o.user_id = v_me AND o.platform = 'discord')),
        'matrix', jsonb_build_object(
            'bridged', v_member AND EXISTS (
                SELECT 1 FROM public.bridge_channels bc
                  JOIN public.channels c ON c.id = bc.channel_id
                 WHERE c.server_id = p_server_id),
            'opted_out', EXISTS (SELECT 1 FROM public.bridge_member_optouts o
                                  WHERE o.server_id = p_server_id AND o.user_id = v_me AND o.platform = 'matrix')));
END;
$$;

CREATE OR REPLACE FUNCTION public.set_bridge_member_optout(p_server_id uuid, p_platform text, p_opted_out boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;
    IF p_platform IS NULL OR p_platform NOT IN ('discord', 'matrix') OR p_opted_out IS NULL THEN
        RAISE EXCEPTION 'A platform (discord, matrix) and a boolean are required' USING ERRCODE = '22023';
    END IF;
    IF p_opted_out THEN
        IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                        WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted') THEN
            RAISE EXCEPTION 'Accepted membership required' USING ERRCODE = '42501';
        END IF;
        INSERT INTO public.bridge_member_optouts (server_id, user_id, platform)
        VALUES (p_server_id, v_me, p_platform)
        ON CONFLICT (server_id, user_id, platform) DO NOTHING;
    ELSE
        DELETE FROM public.bridge_member_optouts o
         WHERE o.server_id = p_server_id AND o.user_id = v_me AND o.platform = p_platform;
    END IF;
    RETURN public.bridge_member_privacy(p_server_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_member_optout_ids(p_server_id uuid, p_platform text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object('user_ids', COALESCE(jsonb_agg(o.user_id ORDER BY o.user_id), '[]'::jsonb))
      FROM public.bridge_member_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform;
$$;

CREATE OR REPLACE FUNCTION public.bridge_member_relay_allowed(p_bot_id uuid, p_channel_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT NOT EXISTS (
        SELECT 1
          FROM public.channels c
          JOIN public.bridge_member_optouts o ON o.server_id = c.server_id
         WHERE c.id = p_channel_id
           AND o.user_id = p_user_id
           AND o.platform = public.bridge_channel_platform(p_bot_id, p_channel_id));
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.configure_matrix_bridge(uuid, uuid, uuid[])',
        'public.unconfigure_matrix_bridge(uuid, uuid)',
        'public.get_server_matrix_bridges(uuid)',
        'public.set_matrix_bridge_sender_mode(uuid, uuid, text)',
        'public.bridge_member_privacy(uuid)',
        'public.set_bridge_member_optout(uuid, text, boolean)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_channel_platform(uuid, uuid)',
        'public.matrix_bridge_bind_room(uuid, uuid, text, text)',
        'public.matrix_bridge_room(uuid, uuid)',
        'public.matrix_bridge_channel_members(uuid, uuid, integer, uuid)',
        'public.bridge_member_optout_ids(uuid, text)',
        'public.bridge_member_relay_allowed(uuid, uuid, uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    REVOKE ALL ON FUNCTION public.matrix_bridge_binding_json(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
