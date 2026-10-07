-- Discord bridge v2. One bridge per server, relaying as a Harmony bot of bot_type 'bridge'.
--
-- Modes
--   self    the community runs the bridge program. discord_bridge_setup_code returns a one-time
--           code; the gateway's POST /bridge/v2/redeem trades it for the bridge bot's token
--           (discord_bridge_redeem_code). The Discord token never reaches Harmony.
--   hosted  the instance's bridge host runs the program. The Discord bot token and a Harmony
--           token for the bridge bot are Vault secrets (discord_bridge_secrets), read by the
--           gateway's GET /bridge/v2/hosted through discord_bridge_hosted_list.
--
-- discord_bridges
--   bot_id         the bridge bot; owned by the creating member, installed on the server with
--                  read_messages, send_messages and manage_channels. Unique among bridges.
--                  NULL after the bot is deleted elsewhere; the next setup code or hosted token
--                  provisions a new one.
--   settings       sync_member_list, sync_presence, sync_reactions, sync_edits, sync_deletes;
--                  booleans, written only through discord_bridge_update_settings.
--   snapshot       {guilds:[{id,name,icon,channels:[{id,name,type,parent_id,position,can_view,
--                  can_send,can_manage_webhooks}]}]}, the bridge's last Discord view.
--   status         {version, discord:{connected, application_id, bot_user, intents}, harmony:
--                  {connected}, problems:[{code, params}]}, the last heartbeat.
--   updated_at     last configuration change: mode, bot_id, discord_guild_id, settings, or a
--                  pair added, removed or redirected. Heartbeats move last_seen_at only. The
--                  gateway polls this column and sends BRIDGE_CONFIG_UPDATE on change.
-- discord_bridge_channels   one row per paired channel. The Harmony channel belongs to the
--                           bridge's server and is not a category (type 2). A client pairs a
--                           channel it can view; the Discord channel appears in the selected
--                           guild of the snapshot.
-- discord_bridge_setup_codes  code_hash is hex SHA-256 of the UTF-8 code 'HB-XXXX-XXXX-XXXX'
--                             (alphabet A-Z minus I and O, 2-9: 60 bits). The plaintext is
--                             returned once and not stored. A code lives 30 minutes, redeems
--                             once, and a new code deletes the bridge's earlier ones. Redeem
--                             hashes the canonical form (discord_bridge_normalize_code).
-- discord_bridge_secrets    Vault secret ids. service_role only. Deleting the row deletes the
--                           Vault secrets.
--
-- Deleting a bridge, directly or with its server, deletes its pairs, codes and secrets, and
-- retires its bot: deleted when it authored no message, otherwise deactivated with its tokens
-- revoked and its install removed. Deviation from the bridge v2 contract, which deletes the
-- bot outright: messages.bot_id cascades on delete, so that would delete the bridged history.
--
-- Hosting: instance_config discord_bridge_hosting_enabled (boolean, default false, public)
-- and discord_bridge_hosting_limit (integer, default 25). Hosted mode requires Supabase Vault;
-- without it the hosted RPCs raise 0A000.
--
-- effective_channel_encryption.bridge_count
--   1 when the channel has a discord_bridge_channels row
--   + active installs of bridge-type bots that no discord_bridges row names, counted in every
--     channel of the server (v1 bridges relay as such a bot)
--   + 1 when that count is 0, the server has a discord_bridge_pairings row, and an active
--     install of a bot named discord-bridge, discord_bridge or discordbridge that no
--     discord_bridges row names: the bots the v1 setup page recognises. A pairing row alone,
--     left by opening the v1 setup page, counts nothing.
--   A v2 bridge bot counts only in its paired channels.
--
-- Errors: 42501 caller lacks MANAGE_SERVER or authentication; P0002 bridge or server absent;
-- 22023 invalid argument; 23505 duplicate bridge or pair; 0A000 hosting disabled or Vault
-- absent; 54000 hosting limit reached.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- Present in supabase/postgres images; a role that cannot create it leaves hosting off.
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS supabase_vault;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'supabase_vault unavailable (%): hosted Discord bridges are disabled', SQLERRM;
END;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.discord_bridges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL UNIQUE REFERENCES public.servers(id) ON DELETE CASCADE,
    bot_id uuid REFERENCES public.bots(id) ON DELETE SET NULL,
    mode text NOT NULL,
    discord_guild_id text,
    discord_guild_name text,
    discord_application_id text,
    discord_bot_name text,
    settings jsonb NOT NULL DEFAULT
        '{"sync_member_list":true,"sync_presence":false,"sync_reactions":true,"sync_edits":true,"sync_deletes":true}'::jsonb,
    snapshot jsonb,
    status jsonb,
    bridge_version text,
    last_seen_at timestamptz,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT discord_bridges_mode_check CHECK (mode IN ('self', 'hosted')),
    CONSTRAINT discord_bridges_guild_check CHECK (discord_guild_id IS NULL OR discord_guild_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_bridges_application_check
        CHECK (discord_application_id IS NULL OR discord_application_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_bridges_names_check
        CHECK (char_length(discord_guild_name) <= 100 AND char_length(discord_bot_name) <= 100
               AND char_length(bridge_version) <= 64),
    CONSTRAINT discord_bridges_settings_check CHECK (jsonb_typeof(settings) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS discord_bridges_bot_id_key
    ON public.discord_bridges (bot_id) WHERE bot_id IS NOT NULL;

COMMENT ON TABLE public.discord_bridges IS
    'Discord bridge v2, one per server. Written through the discord_bridge_* functions.';
COMMENT ON COLUMN public.discord_bridges.updated_at IS
    'Last configuration change (mode, bot, guild, settings, pairs); heartbeats move last_seen_at.';

CREATE TABLE IF NOT EXISTS public.discord_bridge_channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bridge_id uuid NOT NULL REFERENCES public.discord_bridges(id) ON DELETE CASCADE,
    harmony_channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    discord_channel_id text NOT NULL,
    discord_channel_name text,
    direction text NOT NULL DEFAULT 'both',
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT discord_bridge_channels_direction_check CHECK (direction IN ('both', 'to_harmony', 'to_discord')),
    CONSTRAINT discord_bridge_channels_discord_id_check CHECK (discord_channel_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_bridge_channels_name_check CHECK (char_length(discord_channel_name) <= 100),
    CONSTRAINT discord_bridge_channels_discord_key UNIQUE (bridge_id, discord_channel_id),
    CONSTRAINT discord_bridge_channels_harmony_key UNIQUE (bridge_id, harmony_channel_id)
);

CREATE INDEX IF NOT EXISTS discord_bridge_channels_harmony_idx
    ON public.discord_bridge_channels (harmony_channel_id);

CREATE TABLE IF NOT EXISTS public.discord_bridge_setup_codes (
    code_hash text PRIMARY KEY,
    bridge_id uuid NOT NULL REFERENCES public.discord_bridges(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CONSTRAINT discord_bridge_setup_codes_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS discord_bridge_setup_codes_bridge_idx
    ON public.discord_bridge_setup_codes (bridge_id);

CREATE TABLE IF NOT EXISTS public.discord_bridge_secrets (
    bridge_id uuid PRIMARY KEY REFERENCES public.discord_bridges(id) ON DELETE CASCADE,
    discord_token_secret uuid,
    harmony_token_secret uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.discord_bridge_secrets IS
    'Vault secret ids of a hosted bridge: the Discord bot token and the bridge bot''s Harmony token.';

-- ---------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.discord_bridges, public.discord_bridge_channels,
              public.discord_bridge_setup_codes, public.discord_bridge_secrets
    FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.discord_bridges, public.discord_bridge_channels TO authenticated;
GRANT ALL ON public.discord_bridges, public.discord_bridge_channels,
             public.discord_bridge_setup_codes, public.discord_bridge_secrets
    TO service_role;

ALTER TABLE public.discord_bridges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_bridge_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_bridge_setup_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_bridge_secrets ENABLE ROW LEVEL SECURITY;

-- Server owner, or an accepted member holding MANAGE_SERVER.
CREATE OR REPLACE FUNCTION public.can_manage_discord_bridge(p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT v.me IS NOT NULL
       AND (EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v.me)
            OR (EXISTS (SELECT 1 FROM public.user_servers us
                         WHERE us.server_id = p_server_id
                           AND us.user_id = v.me
                           AND us.status = 'accepted')
                AND public.has_permission(v.me, p_server_id, 'MANAGE_SERVER')))
      FROM (SELECT public.get_current_profile_id() AS me) v;
$$;

REVOKE ALL ON FUNCTION public.can_manage_discord_bridge(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_discord_bridge(uuid) TO authenticated, service_role;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['discord_bridges', 'discord_bridge_channels',
                             'discord_bridge_setup_codes', 'discord_bridge_secrets'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role', t);
        EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role', t);
    END LOOP;
END;
$$;

DROP POLICY IF EXISTS discord_bridges_select_manager ON public.discord_bridges;
CREATE POLICY discord_bridges_select_manager ON public.discord_bridges
    FOR SELECT TO authenticated
    USING (public.can_manage_discord_bridge(server_id));

DROP POLICY IF EXISTS discord_bridge_channels_select_manager ON public.discord_bridge_channels;
CREATE POLICY discord_bridge_channels_select_manager ON public.discord_bridge_channels
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.discord_bridges b
                    WHERE b.id = discord_bridge_channels.bridge_id
                      AND public.can_manage_discord_bridge(b.server_id)));

-- ---------------------------------------------------------------------------
-- Instance configuration
-- ---------------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('discord_bridge_hosting_enabled', 'false'::jsonb,
        'Discord bridges may run on this instance''s bridge host (hosted mode).'),
       ('discord_bridge_hosting_limit', '25'::jsonb,
        'Most hosted Discord bridges this instance runs.')
ON CONFLICT (config_key) DO NOTHING;

DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('discord_bridge_hosting_enabled' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'discord_bridge_hosting_enabled'::text));
    END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.discord_bridge_hosting_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT lower(ic.config_value #>> '{}') = 'true'
                       FROM public.instance_config ic
                      WHERE ic.config_key = 'discord_bridge_hosting_enabled'), false);
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_hosting_limit()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT (ic.config_value #>> '{}')::integer
                       FROM public.instance_config ic
                      WHERE ic.config_key = 'discord_bridge_hosting_limit'
                        AND ic.config_value #>> '{}' ~ '^[0-9]{1,6}$'), 25);
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discord_bridges_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF ROW(NEW.mode, NEW.bot_id, NEW.discord_guild_id, NEW.settings)
       IS DISTINCT FROM ROW(OLD.mode, OLD.bot_id, OLD.discord_guild_id, OLD.settings) THEN
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discord_bridges_touch ON public.discord_bridges;
CREATE TRIGGER discord_bridges_touch
    BEFORE UPDATE ON public.discord_bridges
    FOR EACH ROW EXECUTE FUNCTION public.discord_bridges_touch();

CREATE OR REPLACE FUNCTION public.discord_bridge_channels_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM public.discord_bridges b
                     JOIN public.channels c ON c.server_id = b.server_id
                    WHERE b.id = NEW.bridge_id
                      AND c.id = NEW.harmony_channel_id
                      AND c.type IS DISTINCT FROM 2) THEN
        RAISE EXCEPTION 'Channel % is not a channel of the bridge''s server', NEW.harmony_channel_id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS discord_bridge_channels_check ON public.discord_bridge_channels;
CREATE TRIGGER discord_bridge_channels_check
    BEFORE INSERT OR UPDATE OF bridge_id, harmony_channel_id ON public.discord_bridge_channels
    FOR EACH ROW EXECUTE FUNCTION public.discord_bridge_channels_check();

CREATE OR REPLACE FUNCTION public.discord_bridge_channels_touch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.discord_bridges
       SET updated_at = now()
     WHERE id IN (SELECT r.bridge_id FROM (SELECT NEW.bridge_id UNION SELECT OLD.bridge_id) r(bridge_id)
                   WHERE r.bridge_id IS NOT NULL)
       AND updated_at IS DISTINCT FROM now();
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS discord_bridge_channels_touch ON public.discord_bridge_channels;
CREATE TRIGGER discord_bridge_channels_touch
    AFTER INSERT OR DELETE OR UPDATE OF bridge_id, harmony_channel_id, discord_channel_id, direction
    ON public.discord_bridge_channels
    FOR EACH ROW EXECUTE FUNCTION public.discord_bridge_channels_touch();

CREATE OR REPLACE FUNCTION public.discord_bridge_secrets_purge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF to_regclass('vault.secrets') IS NOT NULL THEN
        DELETE FROM vault.secrets
         WHERE id IN (OLD.discord_token_secret, OLD.harmony_token_secret);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS discord_bridge_secrets_purge ON public.discord_bridge_secrets;
CREATE TRIGGER discord_bridge_secrets_purge
    AFTER DELETE ON public.discord_bridge_secrets
    FOR EACH ROW EXECUTE FUNCTION public.discord_bridge_secrets_purge();

CREATE OR REPLACE FUNCTION public.discord_bridges_retire_bot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.bot_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM public.messages m WHERE m.bot_id = OLD.bot_id) THEN
        UPDATE public.bot_tokens
           SET is_active = false, revoked_at = now()
         WHERE bot_id = OLD.bot_id AND is_active;
        DELETE FROM public.bot_server_permissions
         WHERE bot_id = OLD.bot_id AND server_id = OLD.server_id;
        UPDATE public.bots SET is_active = false WHERE id = OLD.bot_id;
    ELSE
        DELETE FROM public.bots WHERE id = OLD.bot_id;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS discord_bridges_retire_bot ON public.discord_bridges;
CREATE TRIGGER discord_bridges_retire_bot
    AFTER DELETE ON public.discord_bridges
    FOR EACH ROW EXECUTE FUNCTION public.discord_bridges_retire_bot();

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discord_bridge_assert_vault()
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF to_regprocedure('vault.create_secret(text, text, text, uuid)') IS NULL
       OR to_regclass('vault.decrypted_secrets') IS NULL THEN
        RAISE EXCEPTION 'Supabase Vault (supabase_vault) is not installed; hosted Discord bridges are unavailable'
            USING ERRCODE = '0A000';
    END IF;
END;
$$;

-- Channels of one guild in a snapshot, as jsonb objects.
CREATE OR REPLACE FUNCTION public.discord_bridge_guild_channels(p_snapshot jsonb, p_guild_id text)
RETURNS SETOF jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT c
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_snapshot -> 'guilds') = 'array'
                                     THEN p_snapshot -> 'guilds' ELSE '[]'::jsonb END) g
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(g -> 'channels') = 'array'
                                                  THEN g -> 'channels' ELSE '[]'::jsonb END) c
     WHERE jsonb_typeof(g) = 'object'
       AND g ->> 'id' = p_guild_id
       AND jsonb_typeof(c) = 'object';
$$;

-- The bridge row, locked, for a caller holding MANAGE_SERVER on its server.
CREATE OR REPLACE FUNCTION public.discord_bridge_for_manager(p_bridge_id uuid)
RETURNS public.discord_bridges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.discord_bridges;
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM public.discord_bridges WHERE id = p_bridge_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Discord bridge not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_discord_bridge(v_row.server_id) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    RETURN v_row;
END;
$$;

-- New bridge bot owned by p_owner, installed on the bridge's server; returns its id.
CREATE OR REPLACE FUNCTION public.discord_bridge_provision_bot(p_bridge_id uuid, p_owner uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server uuid;
    v_bot uuid;
BEGIN
    SELECT server_id INTO v_server FROM public.discord_bridges WHERE id = p_bridge_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Discord bridge not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.bots (username, display_name, bio, bot_type, is_public, owner_id)
    VALUES ('discord-bridge-' || encode(extensions.gen_random_bytes(6), 'hex'),
            'Discord Bridge',
            'Relays messages between this server and Discord.',
            'bridge',
            false,
            p_owner)
    RETURNING id INTO v_bot;

    INSERT INTO public.bot_server_permissions
        (bot_id, server_id, installed_by, is_active, read_messages, send_messages, manage_channels)
    VALUES (v_bot, v_server, p_owner, true, true, true, true);

    UPDATE public.discord_bridges SET bot_id = v_bot WHERE id = p_bridge_id;
    RETURN v_bot;
END;
$$;

-- Revokes the bot's active tokens and issues one through issue_bot_token; returns the plaintext.
-- The row lock on bots serialises concurrent issues, as in rotate_bot_token.
CREATE OR REPLACE FUNCTION public.discord_bridge_issue_token(p_bot_id uuid)
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

    RETURN public.issue_bot_token(p_bot_id, 'Discord bridge') ->> 'token';
END;
$$;

-- Pairs or re-directs a channel of a locked bridge. Returns the pair id.
CREATE OR REPLACE FUNCTION public.discord_bridge_pair_internal(
    p_bridge_id uuid,
    p_harmony_channel_id uuid,
    p_discord_channel_id text,
    p_discord_channel_name text,
    p_direction text,
    p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges;
    v_direction text := COALESCE(NULLIF(btrim(p_direction), ''), 'both');
    v_snapshot_name text;
    v_name text;
    v_id uuid;
BEGIN
    SELECT * INTO v_bridge FROM public.discord_bridges WHERE id = p_bridge_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Discord bridge not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_direction NOT IN ('both', 'to_harmony', 'to_discord') THEN
        RAISE EXCEPTION 'direction must be both, to_harmony or to_discord' USING ERRCODE = '22023';
    END IF;
    IF p_discord_channel_id IS NULL OR p_discord_channel_id !~ '^[0-9]{1,20}$' THEN
        RAISE EXCEPTION 'discord_channel_id is not a Discord id' USING ERRCODE = '22023';
    END IF;
    IF p_harmony_channel_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.channels c
         WHERE c.id = p_harmony_channel_id
           AND c.server_id = v_bridge.server_id
           AND c.type IS DISTINCT FROM 2) THEN
        RAISE EXCEPTION 'Channel % is not a channel of this server', p_harmony_channel_id
            USING ERRCODE = '22023';
    END IF;
    IF v_bridge.discord_guild_id IS NULL THEN
        RAISE EXCEPTION 'No Discord guild is selected for this bridge' USING ERRCODE = '22023';
    END IF;

    SELECT c ->> 'name' INTO v_snapshot_name
      FROM public.discord_bridge_guild_channels(v_bridge.snapshot, v_bridge.discord_guild_id) c
     WHERE c ->> 'id' = p_discord_channel_id
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Discord channel % is not in the selected guild', p_discord_channel_id
            USING ERRCODE = '22023';
    END IF;
    v_name := left(COALESCE(NULLIF(btrim(p_discord_channel_name), ''), NULLIF(btrim(v_snapshot_name), '')), 100);

    SELECT id INTO v_id
      FROM public.discord_bridge_channels
     WHERE bridge_id = p_bridge_id
       AND harmony_channel_id = p_harmony_channel_id
       AND discord_channel_id = p_discord_channel_id;
    IF FOUND THEN
        UPDATE public.discord_bridge_channels
           SET direction = v_direction,
               discord_channel_name = COALESCE(v_name, discord_channel_name)
         WHERE id = v_id;
        RETURN v_id;
    END IF;

    IF EXISTS (SELECT 1 FROM public.discord_bridge_channels
                WHERE bridge_id = p_bridge_id AND harmony_channel_id = p_harmony_channel_id) THEN
        RAISE EXCEPTION 'Channel % is already paired', p_harmony_channel_id USING ERRCODE = '23505';
    END IF;
    IF EXISTS (SELECT 1 FROM public.discord_bridge_channels
                WHERE bridge_id = p_bridge_id AND discord_channel_id = p_discord_channel_id) THEN
        RAISE EXCEPTION 'Discord channel % is already paired', p_discord_channel_id USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.discord_bridge_channels
        (bridge_id, harmony_channel_id, discord_channel_id, discord_channel_name, direction, created_by)
    VALUES (p_bridge_id, p_harmony_channel_id, p_discord_channel_id, v_name, v_direction, p_actor)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discord_bridge_create(p_server_id uuid, p_mode text)
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
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_mode IS NULL OR p_mode NOT IN ('self', 'hosted') THEN
        RAISE EXCEPTION 'mode must be self or hosted' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE) THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;

    IF p_mode = 'hosted' THEN
        PERFORM public.discord_bridge_assert_vault();
        IF NOT public.discord_bridge_hosting_enabled() THEN
            RAISE EXCEPTION 'Discord bridge hosting is disabled on this instance' USING ERRCODE = '0A000';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtext('discord_bridge_hosting'));
        IF (SELECT count(*) FROM public.discord_bridges WHERE mode = 'hosted')
           >= public.discord_bridge_hosting_limit() THEN
            RAISE EXCEPTION 'This instance already hosts its limit of % Discord bridges',
                public.discord_bridge_hosting_limit() USING ERRCODE = '54000';
        END IF;
    END IF;

    INSERT INTO public.discord_bridges (server_id, mode, created_by)
    VALUES (p_server_id, p_mode, v_caller)
    ON CONFLICT (server_id) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'This server already has a Discord bridge' USING ERRCODE = '23505';
    END IF;

    PERFORM public.discord_bridge_provision_bot(v_id, v_caller);
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_setup_code(p_bridge_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    c_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
    v_bytes bytea := extensions.gen_random_bytes(12);
    v_chars text := '';
    v_code text;
    i integer;
BEGIN
    IF v_bridge.mode <> 'self' THEN
        RAISE EXCEPTION 'Setup codes are for self-run bridges' USING ERRCODE = '22023';
    END IF;
    IF v_bridge.bot_id IS NULL THEN
        PERFORM public.discord_bridge_provision_bot(v_bridge.id, public.get_current_profile_id());
    END IF;

    -- 256 is a multiple of 32: each byte maps uniformly onto the alphabet.
    FOR i IN 0 .. 11 LOOP
        v_chars := v_chars || substr(c_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
    END LOOP;
    v_code := 'HB-' || substr(v_chars, 1, 4) || '-' || substr(v_chars, 5, 4) || '-' || substr(v_chars, 9, 4);

    DELETE FROM public.discord_bridge_setup_codes WHERE bridge_id = v_bridge.id;
    INSERT INTO public.discord_bridge_setup_codes (code_hash, bridge_id, expires_at)
    VALUES (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), v_bridge.id, now() + interval '30 minutes');

    RETURN v_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_set_hosted_token(p_bridge_id uuid, p_discord_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
    v_token text := regexp_replace(btrim(COALESCE(p_discord_token, '')), '^Bot\s+', '', 'i');
    v_bot uuid;
    v_old public.discord_bridge_secrets;
    v_discord_secret uuid;
    v_harmony_secret uuid;
BEGIN
    IF v_bridge.mode <> 'hosted' THEN
        RAISE EXCEPTION 'Only hosted bridges store a Discord token' USING ERRCODE = '22023';
    END IF;
    PERFORM public.discord_bridge_assert_vault();
    IF NOT public.discord_bridge_hosting_enabled() THEN
        RAISE EXCEPTION 'Discord bridge hosting is disabled on this instance' USING ERRCODE = '0A000';
    END IF;
    IF char_length(v_token) > 256
       OR v_token !~ '^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{10,}$' THEN
        RAISE EXCEPTION 'Not a Discord bot token' USING ERRCODE = '22023';
    END IF;

    v_bot := v_bridge.bot_id;
    IF v_bot IS NULL THEN
        v_bot := public.discord_bridge_provision_bot(v_bridge.id, public.get_current_profile_id());
    END IF;

    v_discord_secret := vault.create_secret(v_token, NULL,
        'Discord bridge ' || v_bridge.id || ': Discord bot token');
    v_harmony_secret := vault.create_secret(public.discord_bridge_issue_token(v_bot), NULL,
        'Discord bridge ' || v_bridge.id || ': Harmony bot token');

    SELECT * INTO v_old FROM public.discord_bridge_secrets WHERE bridge_id = v_bridge.id FOR UPDATE;

    INSERT INTO public.discord_bridge_secrets (bridge_id, discord_token_secret, harmony_token_secret, updated_at)
    VALUES (v_bridge.id, v_discord_secret, v_harmony_secret, now())
    ON CONFLICT (bridge_id) DO UPDATE
       SET discord_token_secret = EXCLUDED.discord_token_secret,
           harmony_token_secret = EXCLUDED.harmony_token_secret,
           updated_at = now();

    DELETE FROM vault.secrets WHERE id IN (v_old.discord_token_secret, v_old.harmony_token_secret);
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_set_guild(p_bridge_id uuid, p_guild_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
    v_name text;
BEGIN
    SELECT g ->> 'name' INTO v_name
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_bridge.snapshot -> 'guilds') = 'array'
                                     THEN v_bridge.snapshot -> 'guilds' ELSE '[]'::jsonb END) g
     WHERE jsonb_typeof(g) = 'object' AND g ->> 'id' = p_guild_id
     LIMIT 1;
    IF NOT FOUND OR p_guild_id IS NULL THEN
        RAISE EXCEPTION 'Guild % is not in the bridge''s Discord view', p_guild_id USING ERRCODE = '22023';
    END IF;

    UPDATE public.discord_bridges
       SET discord_guild_id = p_guild_id,
           discord_guild_name = left(v_name, 100)
     WHERE id = v_bridge.id;

    -- Pairs whose Discord channel is outside the new guild.
    IF v_bridge.discord_guild_id IS DISTINCT FROM p_guild_id THEN
        DELETE FROM public.discord_bridge_channels p
         WHERE p.bridge_id = v_bridge.id
           AND NOT EXISTS (SELECT 1
                             FROM public.discord_bridge_guild_channels(v_bridge.snapshot, p_guild_id) c
                            WHERE c ->> 'id' = p.discord_channel_id);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_pair(
    p_bridge_id uuid,
    p_harmony_channel_id uuid,
    p_discord_channel_id text,
    p_direction text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF p_harmony_channel_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.channels c
                    WHERE c.id = p_harmony_channel_id AND c.server_id = v_bridge.server_id)
       AND NOT public.can_view_channel(v_caller, p_harmony_channel_id) THEN
        RAISE EXCEPTION 'Channel % is not visible to the caller', p_harmony_channel_id
            USING ERRCODE = '42501';
    END IF;
    RETURN public.discord_bridge_pair_internal(v_bridge.id, p_harmony_channel_id, p_discord_channel_id,
                                               NULL, p_direction, v_caller);
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_unpair(p_bridge_id uuid, p_harmony_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
BEGIN
    DELETE FROM public.discord_bridge_channels
     WHERE bridge_id = v_bridge.id AND harmony_channel_id = p_harmony_channel_id;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_update_settings(p_bridge_id uuid, p_settings jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
    v_bad text;
    v_settings jsonb;
BEGIN
    IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN
        RAISE EXCEPTION 'settings must be a JSON object' USING ERRCODE = '22023';
    END IF;

    SELECT e.key INTO v_bad
      FROM jsonb_each(p_settings) e
     WHERE e.key NOT IN ('sync_member_list', 'sync_presence', 'sync_reactions', 'sync_edits', 'sync_deletes')
        OR jsonb_typeof(e.value) <> 'boolean'
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Unknown or non-boolean setting: %', v_bad USING ERRCODE = '22023';
    END IF;

    UPDATE public.discord_bridges
       SET settings = settings || p_settings
     WHERE id = v_bridge.id
    RETURNING settings INTO v_settings;
    RETURN v_settings;
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_delete(p_bridge_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
BEGIN
    DELETE FROM public.discord_bridges WHERE id = v_bridge.id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Gateway functions (service_role)
-- ---------------------------------------------------------------------------

-- Canonical form 'HB-XXXX-XXXX-XXXX' of a typed code: case, whitespace, dashes (U+002D,
-- U+2010-U+2015, U+2212) and the HB prefix are optional. NULL when 12 characters of [A-Z0-9]
-- do not remain. Mirrors normalizeSetupCode in bot-gateway/src/bridge/bridgeConfig.ts.
CREATE OR REPLACE FUNCTION public.discord_bridge_normalize_code(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN c ~ '^(HB)?[A-Z0-9]{12}$'
                THEN 'HB-' || substr(right(c, 12), 1, 4) || '-' || substr(right(c, 12), 5, 4)
                     || '-' || substr(right(c, 12), 9, 4) END
      FROM (SELECT upper(regexp_replace(COALESCE(p_code, ''),
                                        '[[:space:]\u2010-\u2015\u2212-]', '', 'g')) AS c) n;
$$;

-- {bridge_id, server_id, harmony_token}; NULL for a malformed, unknown, used or expired code, or
-- a bridge without a self-run bot. One answer for every failure: the caller learns nothing about
-- which codes exist.
CREATE OR REPLACE FUNCTION public.discord_bridge_redeem_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_code text := public.discord_bridge_normalize_code(p_code);
    v_bridge_id uuid;
    v_bridge public.discord_bridges;
BEGIN
    IF v_code IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE public.discord_bridge_setup_codes
       SET used_at = now()
     WHERE code_hash = encode(sha256(convert_to(v_code, 'UTF8')), 'hex')
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING bridge_id INTO v_bridge_id;
    IF v_bridge_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_bridge FROM public.discord_bridges WHERE id = v_bridge_id FOR UPDATE;
    IF NOT FOUND OR v_bridge.mode <> 'self' OR v_bridge.bot_id IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN jsonb_build_object(
        'bridge_id', v_bridge.id,
        'server_id', v_bridge.server_id,
        'harmony_token', public.discord_bridge_issue_token(v_bridge.bot_id));
END;
$$;

-- Hosted bridges with both tokens; empty while hosting is disabled.
CREATE OR REPLACE FUNCTION public.discord_bridge_hosted_list()
RETURNS TABLE (bridge_id uuid, harmony_token text, discord_token text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.discord_bridge_hosting_enabled() THEN
        RETURN;
    END IF;
    PERFORM public.discord_bridge_assert_vault();

    RETURN QUERY
    SELECT b.id, h.decrypted_secret, d.decrypted_secret
      FROM public.discord_bridges b
      JOIN public.discord_bridge_secrets s ON s.bridge_id = b.id
      JOIN public.bots bo ON bo.id = b.bot_id AND bo.is_active IS TRUE
      JOIN vault.decrypted_secrets d ON d.id = s.discord_token_secret
      JOIN vault.decrypted_secrets h ON h.id = s.harmony_token_secret
     WHERE b.mode = 'hosted'
     ORDER BY b.created_at, b.id;
END;
$$;

-- Heartbeat of the bridge whose bot is p_bot_id. NULL when the bot drives no bridge. Returns
-- {bridge_id, discord_guild_id}.
--   every report        status, bridge_version, last_seen_at
--   discord.connected   also the snapshot, the Discord application id and bot name, the guild
--                       when exactly one is reported and none is chosen, and the chosen guild's
--                       and the pairs' names
-- A disconnected bridge reports its last known guilds, or none before its first connect; that
-- view is not stored and selects nothing.
CREATE OR REPLACE FUNCTION public.discord_bridge_report_status(
    p_bot_id uuid,
    p_status jsonb,
    p_snapshot jsonb,
    p_version text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges;
    v_guilds jsonb;
    v_guild text;
    v_app text := p_status #>> '{discord,application_id}';
    v_bot_name text := left(NULLIF(btrim(p_status #>> '{discord,bot_user,name}'), ''), 100);
BEGIN
    IF p_status IS NULL OR jsonb_typeof(p_status) <> 'object'
       OR p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object'
       OR jsonb_typeof(p_snapshot -> 'guilds') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'status must be an object and snapshot an object with a guilds array'
            USING ERRCODE = '22023';
    END IF;
    IF octet_length(p_status::text) > 65536 OR octet_length(p_snapshot::text) > 2097152 THEN
        RAISE EXCEPTION 'status report too large' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_bridge FROM public.discord_bridges WHERE bot_id = p_bot_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF (p_status #> '{discord,connected}') IS DISTINCT FROM 'true'::jsonb THEN
        UPDATE public.discord_bridges
           SET status = p_status,
               bridge_version = left(NULLIF(btrim(p_version), ''), 64),
               last_seen_at = now()
         WHERE id = v_bridge.id;
        RETURN jsonb_build_object('bridge_id', v_bridge.id, 'discord_guild_id', v_bridge.discord_guild_id);
    END IF;

    v_guilds := p_snapshot -> 'guilds';
    v_guild := v_bridge.discord_guild_id;
    IF v_guild IS NULL AND jsonb_array_length(v_guilds) = 1
       AND (v_guilds -> 0 ->> 'id') ~ '^[0-9]{1,20}$' THEN
        v_guild := v_guilds -> 0 ->> 'id';
    END IF;

    UPDATE public.discord_bridges b
       SET status = p_status,
           snapshot = p_snapshot,
           bridge_version = left(NULLIF(btrim(p_version), ''), 64),
           last_seen_at = now(),
           discord_application_id = CASE WHEN v_app ~ '^[0-9]{1,20}$' THEN v_app
                                         ELSE b.discord_application_id END,
           discord_bot_name = COALESCE(v_bot_name, b.discord_bot_name),
           discord_guild_id = v_guild,
           discord_guild_name = COALESCE(
               (SELECT left(NULLIF(btrim(g ->> 'name'), ''), 100)
                  FROM jsonb_array_elements(v_guilds) g
                 WHERE jsonb_typeof(g) = 'object' AND g ->> 'id' = v_guild
                 LIMIT 1),
               b.discord_guild_name)
     WHERE b.id = v_bridge.id;

    IF v_guild IS NOT NULL THEN
        UPDATE public.discord_bridge_channels p
           SET discord_channel_name = left(c.name, 100)
          FROM (SELECT ch ->> 'id' AS id, NULLIF(btrim(ch ->> 'name'), '') AS name
                  FROM public.discord_bridge_guild_channels(p_snapshot, v_guild) ch) c
         WHERE p.bridge_id = v_bridge.id
           AND p.discord_channel_id = c.id
           AND c.name IS NOT NULL
           AND p.discord_channel_name IS DISTINCT FROM left(c.name, 100);
    END IF;

    RETURN jsonb_build_object('bridge_id', v_bridge.id, 'discord_guild_id', v_guild);
END;
$$;

-- Channels of the bridge's server whose messages are end-to-end encrypted: channel_messages_encrypted,
-- the state effective_channel_encryption reports to the app. The bridge cannot relay them.
CREATE OR REPLACE FUNCTION public.discord_bridge_encrypted_channel_ids(p_bridge_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.id
      FROM public.discord_bridges b
      JOIN public.channels c ON c.server_id = b.server_id
     WHERE b.id = p_bridge_id
       AND public.channel_messages_encrypted(c.id);
$$;

-- Discord-side /bridge link. The gateway checks the bot can see the Harmony channel.
CREATE OR REPLACE FUNCTION public.discord_bridge_bot_pair(
    p_bot_id uuid,
    p_harmony_channel_id uuid,
    p_discord_channel_id text,
    p_discord_channel_name text,
    p_direction text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge_id uuid;
BEGIN
    SELECT id INTO v_bridge_id FROM public.discord_bridges WHERE bot_id = p_bot_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bot drives no Discord bridge' USING ERRCODE = 'P0002';
    END IF;
    RETURN public.discord_bridge_pair_internal(v_bridge_id, p_harmony_channel_id, p_discord_channel_id,
                                               p_discord_channel_name, p_direction, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_bot_unpair(p_bot_id uuid, p_discord_channel_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge_id uuid;
BEGIN
    SELECT id INTO v_bridge_id FROM public.discord_bridges WHERE bot_id = p_bot_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bot drives no Discord bridge' USING ERRCODE = 'P0002';
    END IF;
    DELETE FROM public.discord_bridge_channels
     WHERE bridge_id = v_bridge_id AND discord_channel_id = p_discord_channel_id;
    RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- effective_channel_encryption: bridge_count per the header.
-- ---------------------------------------------------------------------------
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
        'voice_encrypted', v_voice_mode = 'required'
                           OR (v_mode <> 'disabled' AND COALESCE(v_row.voice_encrypted, false)),
        'messages_locked', v_mode <> 'optional',
        'voice_locked', v_voice_mode = 'required' OR v_mode = 'disabled',
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

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_create(uuid, text)',
        'public.discord_bridge_setup_code(uuid)',
        'public.discord_bridge_set_hosted_token(uuid, text)',
        'public.discord_bridge_set_guild(uuid, text)',
        'public.discord_bridge_pair(uuid, uuid, text, text)',
        'public.discord_bridge_unpair(uuid, uuid)',
        'public.discord_bridge_update_settings(uuid, jsonb)',
        'public.discord_bridge_delete(uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_redeem_code(text)',
        'public.discord_bridge_hosted_list()',
        'public.discord_bridge_report_status(uuid, jsonb, jsonb, text)',
        'public.discord_bridge_bot_pair(uuid, uuid, text, text, text)',
        'public.discord_bridge_bot_unpair(uuid, text)',
        'public.discord_bridge_encrypted_channel_ids(uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    -- Reached only from the definers above and from triggers, which run as the owner.
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_hosting_enabled()',
        'public.discord_bridge_hosting_limit()',
        'public.discord_bridge_assert_vault()',
        'public.discord_bridge_guild_channels(jsonb, text)',
        'public.discord_bridge_normalize_code(text)',
        'public.discord_bridge_for_manager(uuid)',
        'public.discord_bridge_provision_bot(uuid, uuid)',
        'public.discord_bridge_issue_token(uuid)',
        'public.discord_bridge_pair_internal(uuid, uuid, text, text, text, uuid)',
        'public.discord_bridges_touch()',
        'public.discord_bridge_channels_check()',
        'public.discord_bridge_channels_touch()',
        'public.discord_bridge_secrets_purge()',
        'public.discord_bridges_retire_bot()'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
