-- Matrix bridge set up from the app. One managed bridge per server, relaying as a Harmony bot this
-- file provisions; custom Matrix bots (configure_matrix_bridge, 20261117900001) stay beside it.
--
-- Modes
--   self      the community runs the bridge program. matrix_bridge_setup_code returns a one-time
--             code; the gateway's POST /bridge/v2/matrix/redeem trades it for the bridge bot's token
--             (matrix_bridge_redeem_code). The Matrix credentials never reach Harmony.
--   hosted    20261126100003; instance  20261126100004. matrix_bridge_admit_mode refuses a mode this
--             instance does not offer (0A000).
--
-- matrix_bridges
--   bot_id         the bridge bot, owned by the creating member, bridge_platform 'matrix', installed
--                  on the server with read_messages and send_messages and no manage_* flag. The
--                  install's allowed_channel_ids is the set of paired channels. NULL after the bot is
--                  deleted elsewhere; the next setup code or pair provisions a new one. A setup code
--                  passes the bot of an owner who no longer manages the server to the caller.
--                  bot_type stays 'bot': the readers of 'bridge' take the bot for a Discord bridge
--                  (bridge_channel_platform's v1 pairings, effective_channel_encryption's v1 count,
--                  the app's Discord guide and its manage_channels default). Matrix readers read
--                  bridge_platform.
--   connection     'application_service' | 'account', as the bridge last reported it.
--   status         the bridge's last report: {ready, user_id, homeserver, server_name, pending,
--                  failed, problems:[{code, detail}]}.
--   snapshot       {rooms:[{room_id, name, alias, encrypted, can_send, invited, members}]}, the
--                  rooms the bridge last saw while connected to its homeserver.
--   updated_at     last configuration change: mode, bot_id, a pair added, removed or changed (its
--                  room, bound, alias, direction, sender mode), an opt-out of a Matrix person or of a
--                  member (bridge_member_optouts). Reports move last_seen_at and
--                  the pairs' state only. The gateway polls this column and sends
--                  BRIDGE_CONFIG_UPDATE on change.
-- matrix_bridge_setup_codes  code_hash is hex SHA-256 of the UTF-8 code 'MX-XXXX-XXXX-XXXX'
--                  (alphabet A-Z minus I and O, 2-9: 60 bits), as discord_bridge_setup_codes. The
--                  plaintext is returned once and not stored. A code lives 30 minutes, redeems once,
--                  needs its issuer to manage the server still, and a new code deletes the bridge's
--                  earlier ones. 'HB-' codes and 'MX-' codes do not normalise to each other: the
--                  other platform's redeem matches no row and consumes nothing.
-- bridge_channels  a managed bridge owns the rows of its bot_id.
--   room_bound     the bridge bound room_id (matrix_bridge_bind_room) or a code posted in the room
--                  did. false: a manager named room_id or an alias, or the room was linked elsewhere
--                  since; such a row is no room to any reader. A room is bound to one channel, and one
--                  bot's rows name it once. A custom bot's row is true, room_id NULL until it binds.
--   room_proof     'code': the room was linked by a code posted in it
--   direction      'both' | 'to_harmony' | 'to_matrix', enforced by the bridge
--   room_alias     '#name:server' a manager named; the bridge resolves it and binds room_id. NULL for
--                  a room named by its id.
--   state, state_error  'joining' | 'ready' | 'error' and a reason, reported by the bridge. 'ready' is
--                  stored for a bound row alone.
-- An instance bridge's rooms are linked by code only (20261126100004): matrix_bridge_pair changes the
-- direction and sender mode of an existing pair, matrix_bridge_bind_room binds nothing new, and the
-- configuration names bound rooms alone.
--
-- Deleting a bridge, directly or with its server, deletes its codes and pairs and retires its bot:
-- deleted when it authored no message, otherwise deactivated with its tokens revoked and its install
-- removed (messages.bot_id cascades: deleting the bot would delete the bridged history). As
-- discord_bridges_retire_bot.
--
-- Authenticated, managers of the server (can_manage_discord_bridge):
--   matrix_bridge_create(server, mode), matrix_bridge_pair, matrix_bridge_unpair,
--   matrix_bridge_state(server)     the state (matrix_bridge_json)
--   matrix_bridge_setup_code        {code, expires_at}
--   matrix_bridge_delete
-- Service role (gateway): matrix_bridge_redeem_code, matrix_bridge_report_status,
--   matrix_bridge_config, matrix_bridge_channel_member, matrix_bridge_send_check.
--
-- Of 20261117900001, redefined:
--   configure_matrix_bridge, unconfigure_matrix_bridge, set_matrix_bridge_sender_mode
--                                   refuse the bot of a matrix_bridges row (22023)
--   get_server_matrix_bridges       without the managed bot's rows; room_id of a bound row alone
--   matrix_bridge_bind_room         locks the bridge before the pair, the order of the pairing
--                                   functions, and one bind of a room at a time; a pair named by
--                                   alias and not bound yet binds only under that alias
--                                   (p_room_alias), one named by id only that room
--   matrix_bridge_room              of an unbound row {room_id: null, sender_mode, room_bound: false}
--   bridge_member_privacy           matrix.bridged also for a server with a matrix_bridges row
-- bridge_privacy_changed (20261112600001) moves matrix_bridges.updated_at as well.
--
-- Errors: 42501 caller lacks MANAGE_SERVER or authentication; P0002 bridge or server absent; 22023
-- invalid argument; 23505 duplicate bridge, or a room bound elsewhere; 0A000 a mode not offered.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.matrix_bridges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL UNIQUE REFERENCES public.servers(id) ON DELETE CASCADE,
    bot_id uuid UNIQUE REFERENCES public.bots(id) ON DELETE SET NULL,
    mode text NOT NULL,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    connection text,
    status jsonb NOT NULL DEFAULT '{}'::jsonb,
    snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    bridge_version text,
    last_seen_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT matrix_bridges_mode_check CHECK (mode IN ('self', 'hosted', 'instance')),
    CONSTRAINT matrix_bridges_connection_check CHECK (connection IN ('application_service', 'account')),
    CONSTRAINT matrix_bridges_version_check CHECK (char_length(bridge_version) <= 64),
    CONSTRAINT matrix_bridges_report_check
        CHECK (jsonb_typeof(status) = 'object' AND jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS matrix_bridges_created_by_idx
    ON public.matrix_bridges (created_by) WHERE created_by IS NOT NULL;

COMMENT ON TABLE public.matrix_bridges IS
    'Managed Matrix bridge, one per server. Written through the matrix_bridge_* functions.';
COMMENT ON COLUMN public.matrix_bridges.updated_at IS
    'Last configuration change (mode, bot, pairs, opt-outs); reports move last_seen_at.';

CREATE TABLE IF NOT EXISTS public.matrix_bridge_setup_codes (
    code_hash text PRIMARY KEY,
    bridge_id uuid NOT NULL REFERENCES public.matrix_bridges(id) ON DELETE CASCADE,
    created_by uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CONSTRAINT matrix_bridge_setup_codes_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS matrix_bridge_setup_codes_bridge_idx
    ON public.matrix_bridge_setup_codes (bridge_id);
CREATE INDEX IF NOT EXISTS matrix_bridge_setup_codes_created_by_idx
    ON public.matrix_bridge_setup_codes (created_by) WHERE created_by IS NOT NULL;

COMMENT ON TABLE public.matrix_bridge_setup_codes IS
    'One-time setup codes of self-run Matrix bridges, hashed. Service role only.';

ALTER TABLE public.bridge_channels ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'both';
ALTER TABLE public.bridge_channels ADD COLUMN IF NOT EXISTS room_alias text;
ALTER TABLE public.bridge_channels ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE public.bridge_channels ADD COLUMN IF NOT EXISTS state_error text;
ALTER TABLE public.bridge_channels ADD COLUMN IF NOT EXISTS room_bound boolean NOT NULL DEFAULT true;
ALTER TABLE public.bridge_channels ADD COLUMN IF NOT EXISTS room_proof text;

ALTER TABLE public.bridge_channels DROP CONSTRAINT IF EXISTS bridge_channels_direction_check;
ALTER TABLE public.bridge_channels ADD CONSTRAINT bridge_channels_direction_check
    CHECK (direction IN ('both', 'to_harmony', 'to_matrix'));
ALTER TABLE public.bridge_channels DROP CONSTRAINT IF EXISTS bridge_channels_room_alias_check;
ALTER TABLE public.bridge_channels ADD CONSTRAINT bridge_channels_room_alias_check
    CHECK (char_length(room_alias) <= 255 AND room_alias ~ '^#[^:[:space:][:cntrl:]]+:[^[:space:][:cntrl:]]+$');
ALTER TABLE public.bridge_channels DROP CONSTRAINT IF EXISTS bridge_channels_state_check;
ALTER TABLE public.bridge_channels ADD CONSTRAINT bridge_channels_state_check
    CHECK (state IN ('joining', 'ready', 'error'));
ALTER TABLE public.bridge_channels DROP CONSTRAINT IF EXISTS bridge_channels_state_error_check;
ALTER TABLE public.bridge_channels ADD CONSTRAINT bridge_channels_state_error_check
    CHECK (char_length(state_error) <= 300);

ALTER TABLE public.bridge_channels DROP CONSTRAINT IF EXISTS bridge_channels_room_proof_check;
ALTER TABLE public.bridge_channels ADD CONSTRAINT bridge_channels_room_proof_check
    CHECK (room_proof = 'code');

CREATE UNIQUE INDEX IF NOT EXISTS bridge_channels_bound_room_key
    ON public.bridge_channels (room_id) WHERE room_bound;
CREATE UNIQUE INDEX IF NOT EXISTS bridge_channels_bot_room_key
    ON public.bridge_channels (bot_id, room_id);
ALTER TABLE public.bridge_channels DROP CONSTRAINT IF EXISTS bridge_channels_room_id_key;

-- An alias can move to another room, so it names a room for one bridge only.
CREATE UNIQUE INDEX IF NOT EXISTS bridge_channels_bot_alias_key
    ON public.bridge_channels (bot_id, room_alias) WHERE room_alias IS NOT NULL;

COMMENT ON TABLE public.bridge_channels IS
    'Channels a Matrix bridge bot relays, and the Matrix room of each. Written through configure_matrix_bridge, matrix_bridge_pair and matrix_bridge_bind_room.';

-- ---------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.matrix_bridges, public.matrix_bridge_setup_codes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.matrix_bridges, public.matrix_bridge_setup_codes TO service_role;

ALTER TABLE public.matrix_bridges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matrix_bridge_setup_codes ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['matrix_bridges', 'matrix_bridge_setup_codes'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role', t);
        EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role', t);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.matrix_bridges_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF ROW(NEW.mode, NEW.bot_id) IS DISTINCT FROM ROW(OLD.mode, OLD.bot_id) THEN
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS matrix_bridges_touch ON public.matrix_bridges;
CREATE TRIGGER matrix_bridges_touch
    BEFORE UPDATE ON public.matrix_bridges
    FOR EACH ROW EXECUTE FUNCTION public.matrix_bridges_touch();

-- A managed bot's pairs changed: its bridge's updated_at, then the allowlist of its install. The
-- first statement locks the bridge row, so the second reads the pairs of every earlier change.
CREATE OR REPLACE FUNCTION public.matrix_bridge_channels_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.matrix_bridges;
BEGIN
    FOR v_bridge IN
        UPDATE public.matrix_bridges b
           SET updated_at = now()
         WHERE b.bot_id IN (NEW.bot_id, OLD.bot_id)
        RETURNING b.*
    LOOP
        UPDATE public.bot_server_permissions p
           SET allowed_channel_ids = a.ids
          FROM (SELECT COALESCE(array_agg(bc.channel_id ORDER BY bc.channel_id), ARRAY[]::uuid[]) AS ids
                  FROM public.bridge_channels bc
                 WHERE bc.bot_id = v_bridge.bot_id) a
         WHERE p.bot_id = v_bridge.bot_id AND p.server_id = v_bridge.server_id
           AND p.allowed_channel_ids IS DISTINCT FROM a.ids;
    END LOOP;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS matrix_bridge_channels_changed ON public.bridge_channels;
CREATE TRIGGER matrix_bridge_channels_changed
    AFTER INSERT OR DELETE OR UPDATE OF bot_id, channel_id, room_id, room_bound, room_alias, direction, sender_mode
    ON public.bridge_channels
    FOR EACH ROW EXECUTE FUNCTION public.matrix_bridge_channels_changed();

-- Members' Matrix opt-outs changed: updated_at of their servers' bridges, locked in id order.
CREATE OR REPLACE FUNCTION public.matrix_bridge_optouts_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.matrix_bridges b
       SET updated_at = now()
      FROM (SELECT l.id FROM public.matrix_bridges l
             WHERE l.server_id IN (SELECT c.server_id FROM changed c WHERE c.platform = 'matrix')
             ORDER BY l.id FOR UPDATE) locked
     WHERE b.id = locked.id;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS matrix_bridge_optouts_inserted ON public.bridge_member_optouts;
CREATE TRIGGER matrix_bridge_optouts_inserted AFTER INSERT ON public.bridge_member_optouts
    REFERENCING NEW TABLE AS changed
    FOR EACH STATEMENT EXECUTE FUNCTION public.matrix_bridge_optouts_changed();
DROP TRIGGER IF EXISTS matrix_bridge_optouts_deleted ON public.bridge_member_optouts;
CREATE TRIGGER matrix_bridge_optouts_deleted AFTER DELETE ON public.bridge_member_optouts
    REFERENCING OLD TABLE AS changed
    FOR EACH STATEMENT EXECUTE FUNCTION public.matrix_bridge_optouts_changed();
DROP TRIGGER IF EXISTS matrix_bridge_optouts_updated_from ON public.bridge_member_optouts;
CREATE TRIGGER matrix_bridge_optouts_updated_from AFTER UPDATE ON public.bridge_member_optouts
    REFERENCING OLD TABLE AS changed
    FOR EACH STATEMENT EXECUTE FUNCTION public.matrix_bridge_optouts_changed();
DROP TRIGGER IF EXISTS matrix_bridge_optouts_updated_to ON public.bridge_member_optouts;
CREATE TRIGGER matrix_bridge_optouts_updated_to AFTER UPDATE ON public.bridge_member_optouts
    REFERENCING NEW TABLE AS changed
    FOR EACH STATEMENT EXECUTE FUNCTION public.matrix_bridge_optouts_changed();

CREATE OR REPLACE FUNCTION public.matrix_bridges_retire_bot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.bot_id IS NULL THEN
        RETURN NULL;
    END IF;

    DELETE FROM public.bridge_channels WHERE bot_id = OLD.bot_id;

    IF EXISTS (SELECT 1 FROM public.messages m WHERE m.bot_id = OLD.bot_id) THEN
        UPDATE public.bot_tokens
           SET is_active = false, revoked_at = now()
         WHERE bot_id = OLD.bot_id AND is_active;
        DELETE FROM public.bot_server_permissions
         WHERE bot_id = OLD.bot_id AND server_id = OLD.server_id;
        UPDATE public.bots SET is_active = false, bridge_platform = NULL WHERE id = OLD.bot_id;
    ELSE
        DELETE FROM public.bots WHERE id = OLD.bot_id;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS matrix_bridges_retire_bot ON public.matrix_bridges;
CREATE TRIGGER matrix_bridges_retire_bot
    AFTER DELETE ON public.matrix_bridges
    FOR EACH ROW EXECUTE FUNCTION public.matrix_bridges_retire_bot();

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- The bridge row, locked, for a caller holding MANAGE_SERVER on its server.
CREATE OR REPLACE FUNCTION public.matrix_bridge_for_manager(p_bridge_id uuid)
RETURNS public.matrix_bridges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.matrix_bridges;
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM public.matrix_bridges WHERE id = p_bridge_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Matrix bridge not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_discord_bridge(v_row.server_id) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    RETURN v_row;
END;
$$;

-- The state a manager's client reads.
CREATE OR REPLACE FUNCTION public.matrix_bridge_json(p_bridge_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
               'id', b.id,
               'server_id', b.server_id,
               'bot_id', b.bot_id,
               'mode', b.mode,
               'connection', b.connection,
               'status', b.status,
               'snapshot', b.snapshot,
               'bridge_version', b.bridge_version,
               'last_seen_at', b.last_seen_at,
               'created_at', b.created_at,
               'updated_at', b.updated_at,
               'pairs', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                              'channel_id', bc.channel_id,
                              'room_id', bc.room_id,
                              'room_alias', bc.room_alias,
                              'direction', bc.direction,
                              'sender_mode', bc.sender_mode,
                              'state', bc.state,
                              'state_error', bc.state_error) ORDER BY c.name, bc.channel_id)
                     FROM public.bridge_channels bc
                     JOIN public.channels c ON c.id = bc.channel_id
                    WHERE bc.bot_id = b.bot_id), '[]'::jsonb))
      FROM public.matrix_bridges b
     WHERE b.id = p_bridge_id;
$$;

-- The install of the bridge bot: read and send, its paired channels alone. An install that
-- qualifies is not written.
CREATE OR REPLACE FUNCTION public.matrix_bridge_install_bot(p_bot_id uuid, p_server_id uuid, p_installer uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    INSERT INTO public.bot_server_permissions AS p
        (bot_id, server_id, installed_by, is_active, read_messages, send_messages,
         manage_messages, manage_channels, manage_roles, allowed_channel_ids)
    VALUES (p_bot_id, p_server_id, p_installer, true, true, true, false, false, false,
            COALESCE((SELECT array_agg(bc.channel_id ORDER BY bc.channel_id)
                        FROM public.bridge_channels bc WHERE bc.bot_id = p_bot_id), ARRAY[]::uuid[]))
    ON CONFLICT (bot_id, server_id) DO UPDATE
       SET is_active = true, read_messages = true, send_messages = true,
           allowed_channel_ids = EXCLUDED.allowed_channel_ids
     WHERE (p.is_active, p.read_messages, p.send_messages, p.allowed_channel_ids)
           IS DISTINCT FROM (true, true, true, EXCLUDED.allowed_channel_ids);
$$;

-- Raises unless this instance offers the mode to one more server. The modes' own files redefine it.
CREATE OR REPLACE FUNCTION public.matrix_bridge_admit_mode(p_mode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_mode <> 'self' THEN
        RAISE EXCEPTION 'This instance does not run Matrix bridges' USING ERRCODE = '0A000';
    END IF;
END;
$$;

-- What a pair of p_server_id may be: a text channel of it the caller sees, a direction and a sender
-- mode.
CREATE OR REPLACE FUNCTION public.matrix_bridge_check_pair(
    p_server_id uuid,
    p_channel_id uuid,
    p_caller uuid,
    p_direction text,
    p_sender_mode text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_channel_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.channels c
         WHERE c.id = p_channel_id AND c.server_id = p_server_id AND c.type = 0) THEN
        RAISE EXCEPTION 'Channel % is not a text channel of this server', p_channel_id USING ERRCODE = '22023';
    END IF;
    IF NOT public.can_view_channel(p_caller, p_channel_id) THEN
        RAISE EXCEPTION 'Channel % is not visible to the caller', p_channel_id USING ERRCODE = '42501';
    END IF;
    IF p_direction NOT IN ('both', 'to_harmony', 'to_matrix') THEN
        RAISE EXCEPTION 'direction must be both, to_harmony or to_matrix' USING ERRCODE = '22023';
    END IF;
    IF p_sender_mode NOT IN ('ghost', 'relay') THEN
        RAISE EXCEPTION 'sender mode must be ghost or relay' USING ERRCODE = '22023';
    END IF;
END;
$$;

-- New bridge bot owned by p_owner, installed on the bridge's server; returns its id.
CREATE OR REPLACE FUNCTION public.matrix_bridge_provision_bot(p_bridge_id uuid, p_owner uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_bridge public.matrix_bridges;
    v_bot uuid;
BEGIN
    SELECT * INTO v_bridge FROM public.matrix_bridges WHERE id = p_bridge_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Matrix bridge not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.bots (username, display_name, bio, bot_type, bridge_platform, is_public, owner_id)
    VALUES ('matrix-bridge-' || encode(extensions.gen_random_bytes(6), 'hex'),
            'Matrix Bridge',
            'Relays messages between this server and Matrix.',
            'bot',
            'matrix',
            false,
            p_owner)
    RETURNING id INTO v_bot;

    PERFORM public.matrix_bridge_install_bot(v_bot, v_bridge.server_id, p_owner);
    UPDATE public.matrix_bridges SET bot_id = v_bot WHERE id = p_bridge_id;
    -- The bridge host's token of the bot (20261126100003).
    IF v_bridge.mode <> 'self' THEN
        PERFORM public.matrix_bridge_vault_token(p_bridge_id);
    END IF;
    RETURN v_bot;
END;
$$;

-- Revokes the bot's active tokens and issues one through issue_bot_token; returns the plaintext.
-- The row lock on bots serialises concurrent issues, as in rotate_bot_token.
CREATE OR REPLACE FUNCTION public.matrix_bridge_issue_token(p_bot_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM 1 FROM public.bots WHERE id = p_bot_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bridge bot not found' USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.bot_tokens
       SET is_active = false, revoked_at = now()
     WHERE bot_id = p_bot_id AND is_active;

    RETURN public.issue_bot_token(p_bot_id, 'Matrix bridge') ->> 'token';
END;
$$;

-- can_manage_discord_bridge of a profile other than the caller.
CREATE OR REPLACE FUNCTION public.matrix_bridge_managed_by(p_profile_id uuid, p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_profile_id IS NOT NULL
       AND (EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = p_profile_id)
            OR (EXISTS (SELECT 1 FROM public.user_servers us
                         WHERE us.server_id = p_server_id
                           AND us.user_id = p_profile_id
                           AND us.status = 'accepted')
                AND public.has_permission(p_profile_id, p_server_id, 'MANAGE_SERVER')));
$$;

-- Canonical form '<prefix>-XXXX-XXXX-XXXX' of a typed code, as discord_bridge_normalize_code. Mirrors
-- normalizeSetupCode in bot-gateway/src/bridge/bridgeConfig.ts.
DROP FUNCTION IF EXISTS public.matrix_bridge_normalize_code(text);
CREATE OR REPLACE FUNCTION public.matrix_bridge_normalize_code(p_code text, p_prefix text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN c ~ ('^(' || p_prefix || ')?[A-Z0-9]{12}$')
                THEN p_prefix || '-' || substr(right(c, 12), 1, 4) || '-' || substr(right(c, 12), 5, 4)
                     || '-' || substr(right(c, 12), 9, 4) END
      FROM (SELECT upper(regexp_replace(COALESCE(p_code, ''),
                                        '[[:space:]\u2010-\u2015\u2212-]', '', 'g')) AS c) n;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_new_code(p_prefix text)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    c_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    v_bytes bytea := extensions.gen_random_bytes(12);
    v_chars text := '';
    i integer;
BEGIN
    -- 256 is a multiple of 32: each byte maps uniformly onto the alphabet.
    FOR i IN 0 .. 11 LOOP
        v_chars := v_chars || substr(c_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
    END LOOP;
    RETURN p_prefix || '-' || substr(v_chars, 1, 4) || '-' || substr(v_chars, 5, 4) || '-' || substr(v_chars, 9, 4);
END;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_code_hash(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
$$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.matrix_bridge_create(p_server_id uuid, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_id uuid;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_mode IS NULL OR p_mode NOT IN ('self', 'hosted', 'instance') THEN
        RAISE EXCEPTION 'mode must be self, hosted or instance' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE) THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    PERFORM public.matrix_bridge_admit_mode(p_mode);

    INSERT INTO public.matrix_bridges (server_id, mode, created_by)
    VALUES (p_server_id, p_mode, v_caller)
    ON CONFLICT (server_id) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'This server already has a Matrix bridge' USING ERRCODE = '23505';
    END IF;

    PERFORM public.matrix_bridge_provision_bot(v_id, v_caller);
    RETURN public.matrix_bridge_json(v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_setup_code(p_bridge_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.matrix_bridges := public.matrix_bridge_for_manager(p_bridge_id);
    v_caller uuid := public.get_current_profile_id();
    v_expires timestamptz := now() + interval '30 minutes';
    v_code text := public.matrix_bridge_new_code('MX');
BEGIN
    IF v_bridge.mode <> 'self' THEN
        RAISE EXCEPTION 'Setup codes are for self-run bridges' USING ERRCODE = '22023';
    END IF;
    IF v_bridge.bot_id IS NULL THEN
        PERFORM public.matrix_bridge_provision_bot(v_bridge.id, v_caller);
    ELSE
        -- A bot's owner issues tokens for it (rotate_bot_token).
        UPDATE public.bots b
           SET owner_id = v_caller
         WHERE b.id = v_bridge.bot_id
           AND NOT public.matrix_bridge_managed_by(b.owner_id, v_bridge.server_id);
    END IF;

    DELETE FROM public.matrix_bridge_setup_codes WHERE bridge_id = v_bridge.id;
    INSERT INTO public.matrix_bridge_setup_codes (code_hash, bridge_id, created_by, expires_at)
    VALUES (public.matrix_bridge_code_hash(v_code), v_bridge.id, v_caller, v_expires);

    RETURN jsonb_build_object('code', v_code, 'expires_at', v_expires);
END;
$$;

-- p_room: '!id' or '#alias:server'. Pairs the channel, or changes its pair. A pair whose room
-- changes is unbound and loses its state; one kept by its alias keeps the room the bridge bound.
CREATE OR REPLACE FUNCTION public.matrix_bridge_pair(
    p_bridge_id uuid,
    p_channel_id uuid,
    p_room text,
    p_direction text DEFAULT 'both',
    p_sender_mode text DEFAULT 'ghost')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.matrix_bridges := public.matrix_bridge_for_manager(p_bridge_id);
    v_caller uuid := public.get_current_profile_id();
    v_room text := btrim(COALESCE(p_room, ''), E' \t\r\n');
    v_direction text := COALESCE(NULLIF(btrim(p_direction), ''), 'both');
    v_mode text := COALESCE(NULLIF(btrim(p_sender_mode), ''), 'ghost');
    v_bot uuid := v_bridge.bot_id;
    v_room_id text;
    v_alias text;
    v_same boolean;
    v_row public.bridge_channels;
BEGIN
    PERFORM public.matrix_bridge_check_pair(v_bridge.server_id, p_channel_id, v_caller, v_direction, v_mode);
    IF char_length(v_room) BETWEEN 2 AND 255 AND v_room ~ '^![^[:space:][:cntrl:]/]+$' THEN
        v_room_id := v_room;
    ELSIF char_length(v_room) <= 255 AND v_room ~ '^#[^:[:space:][:cntrl:]]+:[^[:space:][:cntrl:]]+$' THEN
        v_alias := v_room;
    ELSE
        RAISE EXCEPTION 'room must be a Matrix room id (!id) or alias (#name:server)' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row FROM public.bridge_channels bc
     WHERE bc.bot_id = v_bot AND bc.channel_id = p_channel_id
       FOR UPDATE;
    IF v_bridge.mode = 'instance' AND v_row.room_id IS DISTINCT FROM v_room THEN
        RAISE EXCEPTION 'A room of this instance''s Matrix bridge is linked by a code posted in it' USING ERRCODE = '22023';
    END IF;
    IF v_alias IS NOT NULL AND v_row.room_alias = v_alias THEN
        v_room_id := v_row.room_id;
    END IF;

    IF v_bot IS NULL THEN
        v_bot := public.matrix_bridge_provision_bot(v_bridge.id, v_caller);
    END IF;

    IF EXISTS (SELECT 1 FROM public.bridge_channels bc
                WHERE bc.room_id = v_room_id AND (bc.room_bound OR bc.bot_id = v_bot)
                  AND (bc.bot_id, bc.channel_id) IS DISTINCT FROM (v_bot, p_channel_id))
       OR EXISTS (SELECT 1 FROM public.bridge_channels bc
                   WHERE bc.bot_id = v_bot AND bc.room_alias = v_alias
                     AND bc.channel_id <> p_channel_id) THEN
        RAISE EXCEPTION 'The Matrix room is paired with another channel' USING ERRCODE = '23505';
    END IF;

    v_same := (v_row.room_id, v_row.room_alias) IS NOT DISTINCT FROM (v_room_id, v_alias);
    INSERT INTO public.bridge_channels AS bc
        (bot_id, channel_id, platform, room_id, room_bound, room_alias, direction, sender_mode, sender_mode_set_by_manager)
    VALUES (v_bot, p_channel_id, 'matrix', v_room_id, false, v_alias, v_direction, v_mode, true)
    ON CONFLICT (bot_id, channel_id) DO UPDATE
       SET room_id = EXCLUDED.room_id,
           room_bound = bc.room_bound AND bc.room_id IS NOT DISTINCT FROM EXCLUDED.room_id,
           room_proof = CASE WHEN bc.room_id IS NOT DISTINCT FROM EXCLUDED.room_id THEN bc.room_proof END,
           room_alias = EXCLUDED.room_alias,
           direction = EXCLUDED.direction,
           sender_mode = EXCLUDED.sender_mode,
           sender_mode_set_by_manager = true,
           state = CASE WHEN v_same THEN bc.state END,
           state_error = CASE WHEN v_same THEN bc.state_error END;

    PERFORM public.matrix_bridge_install_bot(v_bot, v_bridge.server_id, v_caller);
    RETURN public.matrix_bridge_json(v_bridge.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_unpair(p_bridge_id uuid, p_channel_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.matrix_bridges := public.matrix_bridge_for_manager(p_bridge_id);
BEGIN
    DELETE FROM public.bridge_channels
     WHERE bot_id = v_bridge.bot_id AND channel_id = p_channel_id;
    RETURN public.matrix_bridge_json(v_bridge.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_delete(p_bridge_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.matrix_bridges := public.matrix_bridge_for_manager(p_bridge_id);
BEGIN
    DELETE FROM public.matrix_bridges WHERE id = v_bridge.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_state(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    RETURN (SELECT public.matrix_bridge_json(b.id) FROM public.matrix_bridges b WHERE b.server_id = p_server_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Gateway functions (service_role)
-- ---------------------------------------------------------------------------

-- {bridge_id, server_id, harmony_token}; NULL for a malformed, unknown, used or expired code, one
-- whose issuer no longer manages the server, or a bridge without a self-run bot. One answer for every
-- failure. The bridge row is locked before the code row, as matrix_bridge_setup_code does.
CREATE OR REPLACE FUNCTION public.matrix_bridge_redeem_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_code text := public.matrix_bridge_normalize_code(p_code, 'MX');
    v_hash text := public.matrix_bridge_code_hash(COALESCE(v_code, ''));
    v_bridge public.matrix_bridges;
    v_issuer uuid;
BEGIN
    IF v_code IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT b.* INTO v_bridge
      FROM public.matrix_bridges b
     WHERE b.id = (SELECT c.bridge_id FROM public.matrix_bridge_setup_codes c WHERE c.code_hash = v_hash)
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.matrix_bridge_setup_codes
       SET used_at = now()
     WHERE code_hash = v_hash
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING created_by INTO v_issuer;
    IF NOT FOUND
       OR v_bridge.mode <> 'self'
       OR v_bridge.bot_id IS NULL
       OR NOT public.matrix_bridge_managed_by(v_issuer, v_bridge.server_id) THEN
        RETURN NULL;
    END IF;

    RETURN jsonb_build_object(
        'bridge_id', v_bridge.id,
        'server_id', v_bridge.server_id,
        'harmony_token', public.matrix_bridge_issue_token(v_bridge.bot_id));
END;
$$;

-- Report of the bridge whose bot is p_bot_id; NULL when the bot drives none, else {ok}.
--   every report   status, connection (kept when not given), bridge_version, last_seen_at, and the
--                  state and error of each pair named in p_pairs [{channel_id, state, error}]; 'ready'
--                  leaves an unbound pair as it is
--   status.ready   also the snapshot: a bridge without its homeserver sees no rooms
CREATE OR REPLACE FUNCTION public.matrix_bridge_report_status(
    p_bot_id uuid,
    p_connection text,
    p_status jsonb,
    p_snapshot jsonb,
    p_version text,
    p_pairs jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.matrix_bridges;
BEGIN
    IF p_status IS NULL OR jsonb_typeof(p_status) <> 'object'
       OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object'
       OR jsonb_typeof(p_snapshot -> 'rooms') IS DISTINCT FROM 'array'
       OR jsonb_typeof(COALESCE(p_pairs, '[]'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION 'status must be an object, snapshot an object with a rooms array and pairs an array'
            USING ERRCODE = '22023';
    END IF;
    IF p_connection IS NOT NULL AND p_connection NOT IN ('application_service', 'account') THEN
        RAISE EXCEPTION 'connection must be application_service or account' USING ERRCODE = '22023';
    END IF;
    IF octet_length(p_status::text) > 65536 OR octet_length(p_snapshot::text) > 2097152
       OR octet_length(p_pairs::text) > 2097152 THEN
        RAISE EXCEPTION 'status report too large' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_bridge FROM public.matrix_bridges WHERE bot_id = p_bot_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.matrix_bridges b
       SET status = p_status,
           connection = COALESCE(p_connection, b.connection),
           -- A kept snapshot keeps its TOAST value; an equal one would be written again.
           snapshot = CASE WHEN p_status -> 'ready' = 'true'::jsonb AND b.snapshot IS DISTINCT FROM p_snapshot
                           THEN p_snapshot ELSE b.snapshot END,
           bridge_version = left(NULLIF(btrim(p_version), ''), 64),
           last_seen_at = now()
     WHERE b.id = v_bridge.id;

    UPDATE public.bridge_channels bc
       SET state = r.state, state_error = r.error
      FROM (SELECT DISTINCT ON (lower(x ->> 'channel_id'))
                   (x ->> 'channel_id')::uuid AS channel_id,
                   CASE WHEN x ->> 'state' IN ('joining', 'ready', 'error') THEN x ->> 'state' END AS state,
                   left(NULLIF(btrim(x ->> 'error'), ''), 300) AS error
              FROM jsonb_array_elements(COALESCE(p_pairs, '[]'::jsonb)) x
             WHERE jsonb_typeof(x) = 'object'
               AND (x ->> 'channel_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             ORDER BY lower(x ->> 'channel_id')) r
     WHERE bc.bot_id = p_bot_id AND bc.channel_id = r.channel_id
       AND (bc.room_bound OR r.state IS DISTINCT FROM 'ready')
       AND (bc.state, bc.state_error) IS DISTINCT FROM (r.state, r.error);

    RETURN jsonb_build_object('ok', true);
END;
$$;

-- What the bridge whose bot is p_bot_id runs; NULL when the bot drives none. encrypted is
-- channel_messages_encrypted: the bridge relays no such channel. A self-run or hosted bridge reads the
-- rooms it has to bind; an instance bridge, whose connection serves other servers, bound ones alone.
CREATE OR REPLACE FUNCTION public.matrix_bridge_config(p_bot_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
               'bridge_id', b.id,
               'server_id', b.server_id,
               'mode', b.mode,
               'updated_at', b.updated_at,
               'privacy_version', public.bridge_privacy_optout_ids(b.server_id, 'matrix') -> 'version',
               'pairs', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object(
                              'channel_id', bc.channel_id,
                              'channel_name', c.name,
                              'room_id', CASE WHEN bc.room_bound OR b.mode <> 'instance' THEN bc.room_id END,
                              'room_alias', bc.room_alias,
                              'direction', bc.direction,
                              'sender_mode', bc.sender_mode,
                              'encrypted', public.channel_messages_encrypted(bc.channel_id))
                              ORDER BY c.name, bc.channel_id)
                     FROM public.bridge_channels bc
                     JOIN public.channels c ON c.id = bc.channel_id
                    WHERE bc.bot_id = b.bot_id), '[]'::jsonb))
      FROM public.matrix_bridges b
     WHERE b.bot_id = p_bot_id;
$$;

-- The member as a bridge of the channel reads them, or no row: an accepted local member who views the
-- channel and has not opted out of 'matrix'.
CREATE OR REPLACE FUNCTION public.matrix_bridge_member_row(p_channel_id uuid, p_user_id uuid)
RETURNS TABLE (id uuid, username text, display_name text, avatar_url text, nickname text, domain text, is_local boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT p.id, p.username, COALESCE(NULLIF(us.nickname, ''), p.display_name, p.username),
           p.avatar_url, us.nickname, p.domain, p.is_local
      FROM public.channels c
      JOIN public.user_servers us ON us.server_id = c.server_id AND us.user_id = p_user_id
      JOIN public.profiles p ON p.id = us.user_id
     WHERE c.id = p_channel_id
       AND us.status = 'accepted'
       AND p.is_local IS TRUE AND p.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.bridge_member_optouts o
                        WHERE o.server_id = c.server_id AND o.user_id = p_user_id AND o.platform = 'matrix')
       AND public.can_view_channel(p_user_id, p_channel_id);
END;
$$;

-- One row of matrix_bridge_channel_members, or none.
CREATE OR REPLACE FUNCTION public.matrix_bridge_channel_member(p_bot_id uuid, p_channel_id uuid, p_user_id uuid)
RETURNS TABLE (id uuid, username text, display_name text, avatar_url text, nickname text, domain text, is_local boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.bridge_channel_platform(p_bot_id, p_channel_id) IS DISTINCT FROM 'matrix' THEN
        RAISE EXCEPTION 'Active Matrix binding required' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT * FROM public.matrix_bridge_member_row(p_channel_id, p_user_id);
END;
$$;

-- What a bridge checks before it relays a message, in one call: {platform, room_id, sender_mode,
-- messages_encrypted, relay_allowed, member}. platform is 'matrix' for an active Matrix binding, else
-- null and so is every other field. room_id as matrix_bridge_room, messages_encrypted as
-- channel_messages_encrypted; with p_user_id, relay_allowed as bridge_member_relay_allowed and member the
-- row of matrix_bridge_channel_member, or null. scoped: false is added for an install without a channel
-- list, whose sight of the channel the gateway decides (botCanWriteChannel).
CREATE OR REPLACE FUNCTION public.matrix_bridge_send_check(p_bot_id uuid, p_channel_id uuid, p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN (SELECT jsonb_build_object(
                       'platform', b.platform,
                       'room_id', b.room_id,
                       'sender_mode', b.sender_mode,
                       'messages_encrypted', CASE WHEN b.platform IS NOT NULL THEN public.channel_messages_encrypted(p_channel_id) END,
                       'relay_allowed', CASE WHEN b.platform IS NOT NULL AND p_user_id IS NOT NULL THEN NOT EXISTS (
                           SELECT 1 FROM public.bridge_member_optouts o
                            WHERE o.server_id = b.server_id AND o.user_id = p_user_id AND o.platform = b.platform) END,
                       'member', CASE WHEN b.platform IS NOT NULL AND p_user_id IS NOT NULL THEN (
                           SELECT to_jsonb(m) FROM public.matrix_bridge_member_row(p_channel_id, p_user_id) m) END)
                   || CASE WHEN b.unscoped THEN '{"scoped": false}'::jsonb ELSE '{}'::jsonb END
              FROM (SELECT 1) one
              LEFT JOIN (SELECT bc.platform, CASE WHEN bc.room_bound THEN bc.room_id END AS room_id, bc.sender_mode, c.server_id,
                                p.allowed_channel_ids IS NULL AS unscoped
                           FROM public.bridge_channels bc
                           JOIN public.channels c ON c.id = bc.channel_id
                           JOIN public.bot_server_permissions p ON p.bot_id = bc.bot_id AND p.server_id = c.server_id
                          WHERE bc.bot_id = p_bot_id AND bc.channel_id = p_channel_id
                            AND public.bridge_channel_platform(p_bot_id, p_channel_id) = 'matrix') b ON true);
END;
$$;

-- ---------------------------------------------------------------------------
-- Functions of 20261117900001
-- ---------------------------------------------------------------------------

-- The bot of a matrix_bridges row.
CREATE OR REPLACE FUNCTION public.matrix_bot_is_managed(p_bot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.matrix_bridges b WHERE b.bot_id = p_bot_id);
$$;

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
    IF public.matrix_bot_is_managed(p_bot_id) THEN
        RAISE EXCEPTION 'The bot belongs to a managed Matrix bridge' USING ERRCODE = '22023';
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
    IF public.matrix_bot_is_managed(p_bot_id) THEN
        RAISE EXCEPTION 'The bot belongs to a managed Matrix bridge' USING ERRCODE = '22023';
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
             WHERE c.server_id = p_server_id
               AND NOT public.matrix_bot_is_managed(bc.bot_id));
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
    IF public.matrix_bot_is_managed(p_bot_id) THEN
        RAISE EXCEPTION 'The bot belongs to a managed Matrix bridge' USING ERRCODE = '22023';
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
               'room_id', CASE WHEN bc.room_bound THEN bc.room_id END,
               'sender_mode', bc.sender_mode,
               'sender_mode_set_by_manager', bc.sender_mode_set_by_manager,
               'active', COALESCE(public.bridge_channel_platform(bc.bot_id, bc.channel_id) = 'matrix', false))
      FROM public.bridge_channels bc
      JOIN public.channels c ON c.id = bc.channel_id
      JOIN public.bots b ON b.id = bc.bot_id
     WHERE bc.bot_id = p_bot_id AND bc.channel_id = p_channel_id;
$$;

-- The four-argument form would answer PostgREST calls beside this one (PGRST203).
DROP FUNCTION IF EXISTS public.matrix_bridge_bind_room(uuid, uuid, text, text);
CREATE OR REPLACE FUNCTION public.matrix_bridge_bind_room(
    p_bot_id uuid, p_channel_id uuid, p_room_id text, p_initial_sender_mode text DEFAULT 'relay',
    p_room_alias text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_mode text;
    v_binding public.bridge_channels;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('matrix_room:' || p_room_id, 0));
    SELECT b.mode INTO v_mode FROM public.matrix_bridges b WHERE b.bot_id = p_bot_id FOR UPDATE;
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
    IF v_binding.room_id IS NULL OR NOT v_binding.room_bound THEN
        IF v_binding.room_id IS NULL AND v_binding.room_alias IS DISTINCT FROM p_room_alias THEN
            RAISE EXCEPTION 'The pair names another Matrix room' USING ERRCODE = '22023';
        END IF;
        IF v_mode = 'instance'
           OR EXISTS (SELECT 1 FROM public.bridge_channels bc
                       WHERE bc.room_id = p_room_id AND (bc.room_bound OR bc.bot_id = p_bot_id)
                         AND (bc.bot_id, bc.channel_id) IS DISTINCT FROM (p_bot_id, p_channel_id)) THEN
            RAISE EXCEPTION 'The Matrix room is bound to another channel' USING ERRCODE = '23505';
        END IF;
        UPDATE public.bridge_channels bc
           SET room_id = p_room_id,
               room_bound = true,
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
    RETURN CASE WHEN v_binding.room_bound
                THEN jsonb_build_object('room_id', v_binding.room_id, 'sender_mode', v_binding.sender_mode)
                ELSE jsonb_build_object('room_id', NULL, 'sender_mode', v_binding.sender_mode, 'room_bound', false) END;
END;
$$;

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
            'bridged', v_member AND (
                EXISTS (SELECT 1 FROM public.matrix_bridges b WHERE b.server_id = p_server_id)
                OR EXISTS (
                    SELECT 1 FROM public.bridge_channels bc
                      JOIN public.channels c ON c.id = bc.channel_id
                     WHERE c.server_id = p_server_id)),
            'opted_out', EXISTS (SELECT 1 FROM public.bridge_member_optouts o
                                  WHERE o.server_id = p_server_id AND o.user_id = v_me AND o.platform = 'matrix')));
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_privacy_changed(p_server_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.discord_bridges SET updated_at = now() WHERE server_id = p_server_id;
    UPDATE public.matrix_bridges SET updated_at = now() WHERE server_id = p_server_id;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.matrix_bridge_create(uuid, text)',
        'public.matrix_bridge_setup_code(uuid)',
        'public.matrix_bridge_pair(uuid, uuid, text, text, text)',
        'public.matrix_bridge_unpair(uuid, uuid)',
        'public.matrix_bridge_delete(uuid)',
        'public.matrix_bridge_state(uuid)',
        'public.configure_matrix_bridge(uuid, uuid, uuid[])',
        'public.unconfigure_matrix_bridge(uuid, uuid)',
        'public.get_server_matrix_bridges(uuid)',
        'public.set_matrix_bridge_sender_mode(uuid, uuid, text)',
        'public.bridge_member_privacy(uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.matrix_bridge_redeem_code(text)',
        'public.matrix_bridge_report_status(uuid, text, jsonb, jsonb, text, jsonb)',
        'public.matrix_bridge_config(uuid)',
        'public.matrix_bridge_channel_member(uuid, uuid, uuid)',
        'public.matrix_bridge_send_check(uuid, uuid, uuid)',
        'public.matrix_bridge_bind_room(uuid, uuid, text, text, text)',
        'public.matrix_bridge_room(uuid, uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    -- Reached only from the definers above and from triggers, which run as the owner.
    FOREACH fn IN ARRAY ARRAY[
        'public.matrix_bridge_for_manager(uuid)',
        'public.matrix_bridge_json(uuid)',
        'public.matrix_bridge_binding_json(uuid, uuid)',
        'public.matrix_bridge_install_bot(uuid, uuid, uuid)',
        'public.matrix_bridge_admit_mode(text)',
        'public.matrix_bridge_check_pair(uuid, uuid, uuid, text, text)',
        'public.matrix_bridge_member_row(uuid, uuid)',
        'public.matrix_bridge_provision_bot(uuid, uuid)',
        'public.matrix_bridge_issue_token(uuid)',
        'public.matrix_bridge_managed_by(uuid, uuid)',
        'public.matrix_bridge_normalize_code(text, text)',
        'public.matrix_bridge_new_code(text)',
        'public.matrix_bridge_code_hash(text)',
        'public.matrix_bot_is_managed(uuid)',
        'public.bridge_privacy_changed(uuid)',
        'public.matrix_bridges_touch()',
        'public.matrix_bridge_channels_changed()',
        'public.matrix_bridge_optouts_changed()',
        'public.matrix_bridges_retire_bot()'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
