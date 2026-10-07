-- Discord bridge v2.1: the instance bot, a third bridge mode.
--
--   instance  one public Discord application owned by the instance operator. A community adds
--             its bot to their Discord server through OAuth2 (bot scope, code grant) and the
--             gateway's GET /bridge/v2/discord/callback links that guild to their bridge. The
--             instance's bridge host runs every instance bridge on one Discord client.
--
-- discord_bridges
--   mode            gains 'instance'.
--   discord_guild_id  of an instance bridge is set only by discord_bridge_instance_link_complete,
--                   from the guild in Discord's token response; unique among instance bridges.
--                   discord_bridge_set_guild refuses instance bridges, and a heartbeat neither
--                   selects a guild for one nor stores guilds other than its own.
-- discord_bridge_instance_bot  singleton (id = true). application_id is the OAuth2 client id;
--                   bot_token_secret and client_secret_secret are Vault secret ids. bot_user_id
--                   and bot_user_name come from instance bridge heartbeats of that application.
--                   service_role only. Deleting the row deletes the Vault secrets.
-- discord_bridge_link_states  state_hash is hex SHA-256 of the UTF-8 raw state, 64 hex
--                   characters (32 random bytes). The raw state is returned once and not stored.
--                   A state lives 15 minutes and completes once; a new state for the bridge marks
--                   its earlier ones used. Rows expired for a day are deleted by the next link.
--
-- Instance configuration
--   discord_bridge_instance_bot_enabled  boolean, default false, public: the mode is offered.
--   discord_bridge_instance_presence     boolean, default false: GuildPresences on the shared
--                                        client, for every linked server.
--   discord_bridge_instance_bot_limit    integer, default 100: most linked instance bridges.
--
-- The limit counts instance bridges with a guild. Re-linking a linked bridge does not count.
--
-- Errors: 42501 caller lacks MANAGE_SERVER, admin or authentication; P0002 server absent, or
-- state_invalid; 22023 invalid argument; 23505 bridge_exists or guild_linked_elsewhere; 0A000
-- instance bot disabled or unconfigured, or Vault absent; 54000 limit_reached. The message of
-- the coded errors is the code.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
ALTER TABLE public.discord_bridges DROP CONSTRAINT IF EXISTS discord_bridges_mode_check;
ALTER TABLE public.discord_bridges
    ADD CONSTRAINT discord_bridges_mode_check CHECK (mode IN ('self', 'hosted', 'instance'));

CREATE UNIQUE INDEX IF NOT EXISTS discord_bridges_instance_guild_key
    ON public.discord_bridges (discord_guild_id)
    WHERE mode = 'instance' AND discord_guild_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.discord_bridge_instance_bot (
    id boolean PRIMARY KEY DEFAULT true,
    application_id text,
    bot_token_secret uuid,
    client_secret_secret uuid,
    bot_user_id text,
    bot_user_name text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT discord_bridge_instance_bot_singleton CHECK (id),
    CONSTRAINT discord_bridge_instance_bot_application_check
        CHECK (application_id IS NULL OR application_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_bridge_instance_bot_user_check
        CHECK ((bot_user_id IS NULL OR bot_user_id ~ '^[0-9]{1,20}$') AND char_length(bot_user_name) <= 100)
);

COMMENT ON TABLE public.discord_bridge_instance_bot IS
    'The instance''s Discord application for instance-mode bridges; secrets are Vault ids.';

CREATE TABLE IF NOT EXISTS public.discord_bridge_link_states (
    state_hash text PRIMARY KEY,
    bridge_id uuid NOT NULL REFERENCES public.discord_bridges(id) ON DELETE CASCADE,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    CONSTRAINT discord_bridge_link_states_hash_check CHECK (state_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS discord_bridge_link_states_bridge_idx
    ON public.discord_bridge_link_states (bridge_id);

-- ---------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.discord_bridge_instance_bot, public.discord_bridge_link_states
    FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.discord_bridge_instance_bot, public.discord_bridge_link_states TO service_role;

ALTER TABLE public.discord_bridge_instance_bot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_bridge_link_states ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['discord_bridge_instance_bot', 'discord_bridge_link_states'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role', t);
        EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role', t);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Instance configuration
-- ---------------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('discord_bridge_instance_bot_enabled', 'false'::jsonb,
        'Communities may link their Discord server to this instance''s Discord bot.'),
       ('discord_bridge_instance_presence', 'false'::jsonb,
        'The instance''s Discord bot requests the Presence intent for every linked server.'),
       ('discord_bridge_instance_bot_limit', '100'::jsonb,
        'Most Discord servers linked to this instance''s Discord bot.')
ON CONFLICT (config_key) DO NOTHING;

DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('discord_bridge_instance_bot_enabled' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'discord_bridge_instance_bot_enabled'::text));
    END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.discord_bridge_instance_bot_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT lower(ic.config_value #>> '{}') = 'true'
                       FROM public.instance_config ic
                      WHERE ic.config_key = 'discord_bridge_instance_bot_enabled'), false);
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_instance_presence()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT lower(ic.config_value #>> '{}') = 'true'
                       FROM public.instance_config ic
                      WHERE ic.config_key = 'discord_bridge_instance_presence'), false);
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_instance_bot_limit()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT (ic.config_value #>> '{}')::integer
                       FROM public.instance_config ic
                      WHERE ic.config_key = 'discord_bridge_instance_bot_limit'
                        AND ic.config_value #>> '{}' ~ '^[0-9]{1,6}$'), 100);
$$;

-- Application id and both secrets stored.
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_bot_configured()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.discord_bridge_instance_bot b
                    WHERE b.application_id IS NOT NULL
                      AND b.bot_token_secret IS NOT NULL
                      AND b.client_secret_secret IS NOT NULL);
$$;

-- Instance bridges holding a guild, other than p_except.
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_linked_count(p_except uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT count(*)::integer
      FROM public.discord_bridges b
     WHERE b.mode = 'instance'
       AND b.discord_guild_id IS NOT NULL
       AND b.id IS DISTINCT FROM p_except;
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_bot_purge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF to_regclass('vault.secrets') IS NOT NULL THEN
        DELETE FROM vault.secrets
         WHERE id IN (OLD.bot_token_secret, OLD.client_secret_secret);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS discord_bridge_instance_bot_purge ON public.discord_bridge_instance_bot;
CREATE TRIGGER discord_bridge_instance_bot_purge
    AFTER DELETE ON public.discord_bridge_instance_bot
    FOR EACH ROW EXECUTE FUNCTION public.discord_bridge_instance_bot_purge();

-- ---------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------

-- {enabled, configured, application_id, has_client_secret, has_bot_token, bot_user_name,
-- linked_count, limit, presence}. No secret leaves the database through it.
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_bot_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.discord_bridge_instance_bot;
BEGIN
    IF public.get_current_profile_id() IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM public.discord_bridge_instance_bot;
    RETURN jsonb_build_object(
        'enabled', public.discord_bridge_instance_bot_enabled(),
        'configured', public.discord_bridge_instance_bot_configured(),
        'application_id', v_row.application_id,
        'has_client_secret', v_row.client_secret_secret IS NOT NULL,
        'has_bot_token', v_row.bot_token_secret IS NOT NULL,
        'bot_user_name', v_row.bot_user_name,
        'linked_count', public.discord_bridge_instance_linked_count(NULL),
        'limit', public.discord_bridge_instance_bot_limit(),
        'presence', public.discord_bridge_instance_presence());
END;
$$;

-- NULL or '' keeps the stored value. A new secret replaces the stored Vault secret; a new
-- application drops the recorded bot user. Returns discord_bridge_instance_bot_status().
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_bot_set(
    p_application_id text,
    p_client_secret text,
    p_bot_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_app text := NULLIF(btrim(COALESCE(p_application_id, '')), '');
    v_client_secret text := NULLIF(btrim(COALESCE(p_client_secret, '')), '');
    v_token text := NULLIF(regexp_replace(btrim(COALESCE(p_bot_token, '')), '^Bot\s+', '', 'i'), '');
    v_old public.discord_bridge_instance_bot;
    v_client_secret_id uuid;
    v_token_id uuid;
    v_new public.discord_bridge_instance_bot;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    PERFORM public.discord_bridge_assert_vault();
    IF v_app IS NOT NULL AND v_app !~ '^[0-9]{17,20}$' THEN
        RAISE EXCEPTION 'Not a Discord application id' USING ERRCODE = '22023';
    END IF;
    IF v_client_secret IS NOT NULL AND v_client_secret !~ '^[A-Za-z0-9_-]{16,128}$' THEN
        RAISE EXCEPTION 'Not a Discord client secret' USING ERRCODE = '22023';
    END IF;
    IF v_token IS NOT NULL
       AND (char_length(v_token) > 256
            OR v_token !~ '^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{10,}$') THEN
        RAISE EXCEPTION 'Not a Discord bot token' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('discord_bridge_instance_bot'));
    SELECT * INTO v_old FROM public.discord_bridge_instance_bot WHERE id;
    IF v_app IS NULL AND v_old.application_id IS NULL THEN
        RAISE EXCEPTION 'An application id is required' USING ERRCODE = '22023';
    END IF;

    IF v_client_secret IS NOT NULL THEN
        v_client_secret_id := vault.create_secret(v_client_secret, NULL,
            'Discord bridge instance bot: OAuth2 client secret');
    END IF;
    IF v_token IS NOT NULL THEN
        v_token_id := vault.create_secret(v_token, NULL, 'Discord bridge instance bot: bot token');
    END IF;

    INSERT INTO public.discord_bridge_instance_bot
        (id, application_id, bot_token_secret, client_secret_secret, updated_at)
    VALUES (true, COALESCE(v_app, v_old.application_id), v_token_id, v_client_secret_id, now())
    ON CONFLICT (id) DO UPDATE
       SET application_id = EXCLUDED.application_id,
           bot_token_secret = COALESCE(EXCLUDED.bot_token_secret, discord_bridge_instance_bot.bot_token_secret),
           client_secret_secret = COALESCE(EXCLUDED.client_secret_secret,
                                           discord_bridge_instance_bot.client_secret_secret),
           bot_user_id = CASE WHEN EXCLUDED.application_id IS DISTINCT FROM discord_bridge_instance_bot.application_id
                              THEN NULL ELSE discord_bridge_instance_bot.bot_user_id END,
           bot_user_name = CASE WHEN EXCLUDED.application_id IS DISTINCT FROM discord_bridge_instance_bot.application_id
                                THEN NULL ELSE discord_bridge_instance_bot.bot_user_name END,
           updated_at = now()
    RETURNING * INTO v_new;

    DELETE FROM vault.secrets
     WHERE id IN (CASE WHEN v_token_id IS NOT NULL THEN v_old.bot_token_secret END,
                  CASE WHEN v_client_secret_id IS NOT NULL THEN v_old.client_secret_secret END);

    PERFORM public.log_admin_action(v_me, 'config_change', 'config', 'discord_bridge_instance_bot',
        jsonb_build_object(
            'key', 'discord_bridge_instance_bot',
            'old_value', jsonb_build_object('application_id', v_old.application_id,
                                            'has_client_secret', v_old.client_secret_secret IS NOT NULL,
                                            'has_bot_token', v_old.bot_token_secret IS NOT NULL),
            'new_value', jsonb_build_object('application_id', v_new.application_id,
                                            'has_client_secret', v_new.client_secret_secret IS NOT NULL,
                                            'has_bot_token', v_new.bot_token_secret IS NOT NULL)));

    RETURN public.discord_bridge_instance_bot_status();
END;
$$;

-- Deletes the stored application and its Vault secrets, and turns the mode off. Instance bridges
-- stay; the host serves them again once an application is stored and the mode is on.
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_bot_clear()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_old public.discord_bridge_instance_bot;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('discord_bridge_instance_bot'));
    DELETE FROM public.discord_bridge_instance_bot WHERE id RETURNING * INTO v_old;
    UPDATE public.instance_config
       SET config_value = 'false'::jsonb, updated_at = now(), updated_by = v_me
     WHERE config_key = 'discord_bridge_instance_bot_enabled'
       AND config_value IS DISTINCT FROM 'false'::jsonb;

    IF v_old.id IS NOT NULL THEN
        PERFORM public.log_admin_action(v_me, 'config_change', 'config', 'discord_bridge_instance_bot',
            jsonb_build_object(
                'key', 'discord_bridge_instance_bot',
                'old_value', jsonb_build_object('application_id', v_old.application_id,
                                                'has_client_secret', v_old.client_secret_secret IS NOT NULL,
                                                'has_bot_token', v_old.bot_token_secret IS NOT NULL),
                'new_value', NULL));
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Client RPC
-- ---------------------------------------------------------------------------

-- {bridge_id, state}. Creates the server's instance bridge and its bot on first use; stores the
-- bot's Harmony token in Vault for the host. state is 64 hex characters, valid 15 minutes.
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_link(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_bridge public.discord_bridges;
    v_secrets public.discord_bridge_secrets;
    v_bot uuid;
    v_harmony_secret uuid;
    v_state text;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE) THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    PERFORM public.discord_bridge_assert_vault();
    IF NOT public.discord_bridge_instance_bot_enabled() OR NOT public.discord_bridge_instance_bot_configured() THEN
        RAISE EXCEPTION 'instance_bot_unavailable' USING ERRCODE = '0A000',
            DETAIL = 'This instance''s Discord bot is disabled or not configured.';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('discord_bridge_instance'));

    SELECT * INTO v_bridge FROM public.discord_bridges WHERE server_id = p_server_id FOR UPDATE;
    IF FOUND AND v_bridge.mode <> 'instance' THEN
        RAISE EXCEPTION 'bridge_exists' USING ERRCODE = '23505',
            DETAIL = 'This server already has a Discord bridge in another mode.';
    END IF;
    IF public.discord_bridge_instance_linked_count(v_bridge.id) >= public.discord_bridge_instance_bot_limit() THEN
        RAISE EXCEPTION 'limit_reached' USING ERRCODE = '54000',
            DETAIL = format('This instance''s Discord bot already serves its limit of %s Discord servers.',
                            public.discord_bridge_instance_bot_limit());
    END IF;

    IF v_bridge.id IS NULL THEN
        INSERT INTO public.discord_bridges (server_id, mode, created_by)
        VALUES (p_server_id, 'instance', v_caller)
        ON CONFLICT (server_id) DO NOTHING
        RETURNING * INTO v_bridge;
        IF v_bridge.id IS NULL THEN
            RAISE EXCEPTION 'bridge_exists' USING ERRCODE = '23505',
                DETAIL = 'This server already has a Discord bridge in another mode.';
        END IF;
    END IF;

    v_bot := v_bridge.bot_id;
    IF v_bot IS NULL THEN
        v_bot := public.discord_bridge_provision_bot(v_bridge.id, v_caller);
    END IF;

    SELECT * INTO v_secrets FROM public.discord_bridge_secrets WHERE bridge_id = v_bridge.id FOR UPDATE;
    IF v_bridge.bot_id IS DISTINCT FROM v_bot OR v_secrets.harmony_token_secret IS NULL
       OR NOT EXISTS (SELECT 1 FROM vault.secrets vs WHERE vs.id = v_secrets.harmony_token_secret) THEN
        v_harmony_secret := vault.create_secret(public.discord_bridge_issue_token(v_bot), NULL,
            'Discord bridge ' || v_bridge.id || ': Harmony bot token');
        INSERT INTO public.discord_bridge_secrets (bridge_id, discord_token_secret, harmony_token_secret, updated_at)
        VALUES (v_bridge.id, NULL, v_harmony_secret, now())
        ON CONFLICT (bridge_id) DO UPDATE
           SET discord_token_secret = NULL,
               harmony_token_secret = EXCLUDED.harmony_token_secret,
               updated_at = now();
        DELETE FROM vault.secrets WHERE id IN (v_secrets.discord_token_secret, v_secrets.harmony_token_secret);
    END IF;

    DELETE FROM public.discord_bridge_link_states WHERE expires_at < now() - interval '1 day';
    UPDATE public.discord_bridge_link_states
       SET used_at = now()
     WHERE bridge_id = v_bridge.id AND used_at IS NULL;

    v_state := encode(extensions.gen_random_bytes(32), 'hex');
    INSERT INTO public.discord_bridge_link_states (state_hash, bridge_id, created_by, expires_at)
    VALUES (encode(sha256(convert_to(v_state, 'UTF8')), 'hex'), v_bridge.id, v_caller,
            now() + interval '15 minutes');

    RETURN jsonb_build_object('bridge_id', v_bridge.id, 'state', v_state);
END;
$$;

-- ---------------------------------------------------------------------------
-- Gateway functions (service_role)
-- ---------------------------------------------------------------------------

-- Read-only preflight of GET /bridge/v2/discord/authorize and /callback, before a code is
-- exchanged: {bridge_id, server_id, error}. error is state_invalid, guild_linked_elsewhere,
-- limit_reached or null. bridge_id and server_id are null for a state never issued.
-- p_guild_id NULL skips the guild check.
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_link_check(p_state text, p_guild_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_link public.discord_bridge_link_states;
    v_bridge public.discord_bridges;
    v_error text;
BEGIN
    IF p_state IS NULL OR p_state !~ '^[0-9a-f]{64}$' THEN
        RETURN jsonb_build_object('bridge_id', NULL, 'server_id', NULL, 'error', 'state_invalid');
    END IF;

    SELECT * INTO v_link FROM public.discord_bridge_link_states
     WHERE state_hash = encode(sha256(convert_to(p_state, 'UTF8')), 'hex');
    IF FOUND THEN
        SELECT * INTO v_bridge FROM public.discord_bridges WHERE id = v_link.bridge_id;
    END IF;

    IF v_bridge.id IS NULL OR v_bridge.mode <> 'instance'
       OR v_link.used_at IS NOT NULL OR v_link.expires_at <= now() THEN
        v_error := 'state_invalid';
    ELSIF p_guild_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.discord_bridges b
                       WHERE b.mode = 'instance' AND b.discord_guild_id = p_guild_id AND b.id <> v_bridge.id) THEN
        v_error := 'guild_linked_elsewhere';
    ELSIF public.discord_bridge_instance_linked_count(v_bridge.id) >= public.discord_bridge_instance_bot_limit() THEN
        v_error := 'limit_reached';
    END IF;

    RETURN jsonb_build_object('bridge_id', v_bridge.id, 'server_id', v_bridge.server_id, 'error', v_error);
END;
$$;

-- {bridge_id, server_id}. p_guild_id comes from Discord's token response. Consumes the state,
-- links the guild, and drops the pairs and snapshot when the guild changes.
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_link_complete(
    p_state text,
    p_guild_id text,
    p_guild_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge_id uuid;
    v_bridge public.discord_bridges;
BEGIN
    IF p_guild_id IS NULL OR p_guild_id !~ '^[0-9]{1,20}$' THEN
        RAISE EXCEPTION 'guild_id is not a Discord id' USING ERRCODE = '22023';
    END IF;
    IF NOT public.discord_bridge_instance_bot_enabled() OR NOT public.discord_bridge_instance_bot_configured() THEN
        RAISE EXCEPTION 'instance_bot_unavailable' USING ERRCODE = '0A000';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('discord_bridge_instance'));

    UPDATE public.discord_bridge_link_states
       SET used_at = now()
     WHERE p_state ~ '^[0-9a-f]{64}$'
       AND state_hash = encode(sha256(convert_to(p_state, 'UTF8')), 'hex')
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING bridge_id INTO v_bridge_id;

    SELECT * INTO v_bridge FROM public.discord_bridges WHERE id = v_bridge_id FOR UPDATE;
    IF v_bridge_id IS NULL OR NOT FOUND OR v_bridge.mode <> 'instance' THEN
        RAISE EXCEPTION 'state_invalid' USING ERRCODE = 'P0002';
    END IF;
    IF EXISTS (SELECT 1 FROM public.discord_bridges b
                WHERE b.mode = 'instance' AND b.discord_guild_id = p_guild_id AND b.id <> v_bridge.id) THEN
        RAISE EXCEPTION 'guild_linked_elsewhere' USING ERRCODE = '23505';
    END IF;
    IF public.discord_bridge_instance_linked_count(v_bridge.id) >= public.discord_bridge_instance_bot_limit() THEN
        RAISE EXCEPTION 'limit_reached' USING ERRCODE = '54000';
    END IF;

    IF v_bridge.discord_guild_id IS DISTINCT FROM p_guild_id THEN
        DELETE FROM public.discord_bridge_channels WHERE bridge_id = v_bridge.id;
    END IF;
    UPDATE public.discord_bridges
       SET discord_guild_id = p_guild_id,
           discord_guild_name = COALESCE(left(NULLIF(btrim(p_guild_name), ''), 100),
                                         CASE WHEN discord_guild_id = p_guild_id THEN discord_guild_name END),
           snapshot = CASE WHEN discord_guild_id IS DISTINCT FROM p_guild_id THEN NULL ELSE snapshot END
     WHERE id = v_bridge.id;

    RETURN jsonb_build_object('bridge_id', v_bridge.id, 'server_id', v_bridge.server_id);
END;
$$;

-- {application_id, discord_token, presence, bridges:[{bridge_id, harmony_token,
-- discord_guild_id}]} for the bridge host; NULL while the mode is off or unconfigured. Lists
-- instance bridges with a guild and an active bot.
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_hosted()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result jsonb;
BEGIN
    IF NOT public.discord_bridge_instance_bot_enabled() OR NOT public.discord_bridge_instance_bot_configured() THEN
        RETURN NULL;
    END IF;
    PERFORM public.discord_bridge_assert_vault();

    SELECT jsonb_build_object(
               'application_id', ib.application_id,
               'discord_token', t.decrypted_secret,
               'presence', public.discord_bridge_instance_presence(),
               'bridges', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object('bridge_id', b.id,
                                                       'harmony_token', h.decrypted_secret,
                                                       'discord_guild_id', b.discord_guild_id)
                                    ORDER BY b.created_at, b.id)
                     FROM public.discord_bridges b
                     JOIN public.discord_bridge_secrets s ON s.bridge_id = b.id
                     JOIN public.bots bo ON bo.id = b.bot_id AND bo.is_active IS TRUE
                     JOIN vault.decrypted_secrets h ON h.id = s.harmony_token_secret
                    WHERE b.mode = 'instance'
                      AND b.discord_guild_id IS NOT NULL), '[]'::jsonb))
      INTO v_result
      FROM public.discord_bridge_instance_bot ib
      JOIN vault.decrypted_secrets t ON t.id = ib.bot_token_secret
     WHERE ib.id;
    RETURN v_result;
END;
$$;

-- OAuth2 client credentials for the code exchange; no row while the mode is off or unconfigured.
CREATE OR REPLACE FUNCTION public.discord_bridge_instance_bot_secrets()
RETURNS TABLE (client_id text, client_secret text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.discord_bridge_instance_bot_enabled() OR NOT public.discord_bridge_instance_bot_configured() THEN
        RETURN;
    END IF;
    PERFORM public.discord_bridge_assert_vault();

    RETURN QUERY
    SELECT ib.application_id, c.decrypted_secret
      FROM public.discord_bridge_instance_bot ib
      JOIN vault.decrypted_secrets c ON c.id = ib.client_secret_secret
     WHERE ib.id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Bridge functions of 20261008300001, extended for instance bridges.
-- ---------------------------------------------------------------------------

-- As in 20261008300001, plus: an instance bridge's guild is not selected here, its stored
-- snapshot holds its own guild alone, and a connected report of the instance application
-- records the bot user on discord_bridge_instance_bot.
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
    v_snapshot jsonb := p_snapshot;
    v_guilds jsonb;
    v_guild text;
    v_app text := p_status #>> '{discord,application_id}';
    v_bot_name text := left(NULLIF(btrim(p_status #>> '{discord,bot_user,name}'), ''), 100);
    v_bot_user text := substring(p_status #>> '{discord,bot_user,id}' FROM '^[0-9]{1,20}$');
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
    IF v_bridge.mode = 'instance' THEN
        v_guilds := COALESCE((SELECT jsonb_agg(g)
                                FROM jsonb_array_elements(v_guilds) g
                               WHERE jsonb_typeof(g) = 'object' AND g ->> 'id' = v_guild), '[]'::jsonb);
        v_snapshot := jsonb_set(p_snapshot, '{guilds}', v_guilds);
    ELSIF v_guild IS NULL AND jsonb_array_length(v_guilds) = 1
          AND (v_guilds -> 0 ->> 'id') ~ '^[0-9]{1,20}$' THEN
        v_guild := v_guilds -> 0 ->> 'id';
    END IF;

    UPDATE public.discord_bridges b
       SET status = p_status,
           snapshot = v_snapshot,
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
                  FROM public.discord_bridge_guild_channels(v_snapshot, v_guild) ch) c
         WHERE p.bridge_id = v_bridge.id
           AND p.discord_channel_id = c.id
           AND c.name IS NOT NULL
           AND p.discord_channel_name IS DISTINCT FROM left(c.name, 100);
    END IF;

    IF v_bridge.mode = 'instance' AND v_app ~ '^[0-9]{1,20}$' THEN
        UPDATE public.discord_bridge_instance_bot ib
           SET bot_user_id = COALESCE(v_bot_user, ib.bot_user_id),
               bot_user_name = COALESCE(v_bot_name, ib.bot_user_name)
         WHERE ib.id
           AND ib.application_id = v_app
           AND ROW(ib.bot_user_id, ib.bot_user_name)
               IS DISTINCT FROM ROW(COALESCE(v_bot_user, ib.bot_user_id), COALESCE(v_bot_name, ib.bot_user_name));
    END IF;

    RETURN jsonb_build_object('bridge_id', v_bridge.id, 'discord_guild_id', v_guild);
END;
$$;

-- As in 20261008300001, plus: an instance bridge's guild comes from Add to Discord alone.
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
    IF v_bridge.mode = 'instance' THEN
        RAISE EXCEPTION 'An instance bridge links its Discord server through the instance bot''s authorization'
            USING ERRCODE = '22023';
    END IF;

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

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_instance_link(uuid)',
        'public.discord_bridge_instance_bot_set(text, text, text)',
        'public.discord_bridge_instance_bot_clear()',
        'public.discord_bridge_instance_bot_status()',
        'public.discord_bridge_set_guild(uuid, text)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_instance_link_check(text, text)',
        'public.discord_bridge_instance_link_complete(text, text, text)',
        'public.discord_bridge_instance_hosted()',
        'public.discord_bridge_instance_bot_secrets()',
        'public.discord_bridge_report_status(uuid, jsonb, jsonb, text)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    -- Reached only from the definers above and from triggers, which run as the owner.
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_instance_bot_enabled()',
        'public.discord_bridge_instance_presence()',
        'public.discord_bridge_instance_bot_limit()',
        'public.discord_bridge_instance_bot_configured()',
        'public.discord_bridge_instance_linked_count(uuid)',
        'public.discord_bridge_instance_bot_purge()'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
