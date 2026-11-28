-- The instance's own Matrix bridge: one Matrix connection of the operator serves many servers, and a
-- server links a room by a code posted in it. And when the bridge hosts were last seen.
--
--   instance  a mode of matrix_bridges (20261126100001). The instance's Matrix bridge host runs every
--             instance bridge on the connection stored here; a Harmony token of each bridge bot is a
--             Vault secret (matrix_bridge_secrets, 20261126100003).
--
-- matrix_bridge_instance     singleton (id = true). connection 'application_service' | 'account';
--                            homeserver_url and appservice_url are the operator's: http and private
--                            addresses are allowed. access_token_secret (account), as_token_secret and
--                            hs_token_secret (application service) are Vault secret ids. service_role
--                            only. Deleting the row deletes the Vault secrets; a replaced secret is
--                            deleted with its replacement.
-- matrix_bridge_room_codes   code_hash is hex SHA-256 of the UTF-8 code 'ML-XXXX-XXXX-XXXX', as
--                            matrix_bridge_setup_codes. One per bridge and channel, 30 minutes, single
--                            use; its issuer has to manage the server and see the channel still.
--                            used_by: the MXID that posted it.
-- bridge_hosts               platform 'discord' | 'matrix': when the instance's bridge host last called
--                            the gateway, and what the Matrix one reported:
--                            {instance: {ready, user_id, server_name, problems} | null, hosted}.
--
-- Instance configuration: matrix_bridge_instance_enabled (boolean, default false, public: the mode is
-- offered) and matrix_bridge_instance_limit (integer, default 100): most instance bridges, linked or not.
--
-- Instance admins:
--   matrix_bridge_instance_status()          what is stored and what the host reported; no secret
--   matrix_bridge_instance_set(...)          NULL or '' keeps a stored value; another homeserver_url forgets the
--                                            stored tokens; the status
--   matrix_bridge_instance_registration()    new application service tokens; the registration, once
--   matrix_bridge_instance_clear()           forgets the connection, turns the mode off; bridges stay
--   bridge_hosts_status()                    [{platform, last_seen_at, version, status}]
-- Signed in: matrix_bridge_offers()          {hosted, instance, instance_user}
-- Managers:  matrix_bridge_room_code(bridge, channel, direction, sender_mode)
-- Service role:
--   matrix_bridge_instance_hosted()          the connection and its bridges with their tokens
--   matrix_bridge_link_room(code, room, sender)
--   bridge_host_report(platform, version, status)
-- Of 20261126100003, redefined:
--   matrix_bridge_admit_mode                 admits instance: Vault, switch and connection (0A000),
--                                            limit (54000)
--
-- Errors: 42501 caller lacks MANAGE_SERVER, admin or authentication; P0002 bridge absent; 22023 invalid
-- argument; 0A000 instance bridge disabled or not configured, or Vault absent; 54000 limit reached;
-- 55000 channel_encrypted.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.matrix_bridge_instance (
    id boolean PRIMARY KEY DEFAULT true,
    connection text NOT NULL,
    homeserver_url text NOT NULL,
    server_name text,
    sender_localpart text,
    appservice_url text,
    access_token_secret uuid,
    as_token_secret uuid,
    hs_token_secret uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT matrix_bridge_instance_singleton CHECK (id),
    CONSTRAINT matrix_bridge_instance_connection_check CHECK (connection IN ('application_service', 'account')),
    CONSTRAINT matrix_bridge_instance_lengths_check
        CHECK (char_length(homeserver_url) <= 255 AND char_length(appservice_url) <= 255
               AND char_length(server_name) <= 255 AND char_length(sender_localpart) <= 255)
);

COMMENT ON TABLE public.matrix_bridge_instance IS
    'The instance''s Matrix connection for instance-mode bridges; secrets are Vault ids.';

CREATE TABLE IF NOT EXISTS public.matrix_bridge_room_codes (
    code_hash text PRIMARY KEY,
    bridge_id uuid NOT NULL REFERENCES public.matrix_bridges(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    direction text NOT NULL,
    sender_mode text NOT NULL,
    created_by uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    used_by text,
    CONSTRAINT matrix_bridge_room_codes_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT matrix_bridge_room_codes_direction_check CHECK (direction IN ('both', 'to_harmony', 'to_matrix')),
    CONSTRAINT matrix_bridge_room_codes_sender_mode_check CHECK (sender_mode IN ('ghost', 'relay')),
    CONSTRAINT matrix_bridge_room_codes_used_by_check CHECK (char_length(used_by) <= 255)
);

CREATE INDEX IF NOT EXISTS matrix_bridge_room_codes_bridge_idx
    ON public.matrix_bridge_room_codes (bridge_id, channel_id);
CREATE INDEX IF NOT EXISTS matrix_bridge_room_codes_channel_idx
    ON public.matrix_bridge_room_codes (channel_id);
CREATE INDEX IF NOT EXISTS matrix_bridge_room_codes_created_by_idx
    ON public.matrix_bridge_room_codes (created_by) WHERE created_by IS NOT NULL;

COMMENT ON TABLE public.matrix_bridge_room_codes IS
    'One-time codes that link a Matrix room to a channel of an instance bridge, hashed. Service role only.';

CREATE TABLE IF NOT EXISTS public.bridge_hosts (
    platform text PRIMARY KEY,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    version text,
    status jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT bridge_hosts_platform_check CHECK (platform IN ('discord', 'matrix')),
    CONSTRAINT bridge_hosts_version_check CHECK (char_length(version) <= 64),
    CONSTRAINT bridge_hosts_status_check CHECK (jsonb_typeof(status) = 'object')
);

COMMENT ON TABLE public.bridge_hosts IS
    'When the instance''s bridge host of a platform last called the gateway. Written through bridge_host_report.';

-- ---------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.matrix_bridge_instance, public.matrix_bridge_room_codes, public.bridge_hosts
    FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.matrix_bridge_instance, public.matrix_bridge_room_codes, public.bridge_hosts TO service_role;

ALTER TABLE public.matrix_bridge_instance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matrix_bridge_room_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bridge_hosts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['matrix_bridge_instance', 'matrix_bridge_room_codes', 'bridge_hosts'] LOOP
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
VALUES ('matrix_bridge_instance_enabled', 'false'::jsonb,
        'Communities may link a Matrix room to this instance''s Matrix bridge.'),
       ('matrix_bridge_instance_limit', '100'::jsonb,
        'Most servers on this instance''s Matrix bridge.')
ON CONFLICT (config_key) DO NOTHING;

DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('matrix_bridge_instance_enabled' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'matrix_bridge_instance_enabled'::text));
    END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT lower(ic.config_value #>> '{}') = 'true'
                       FROM public.instance_config ic
                      WHERE ic.config_key = 'matrix_bridge_instance_enabled'), false);
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_limit()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT (ic.config_value #>> '{}')::integer
                       FROM public.instance_config ic
                      WHERE ic.config_key = 'matrix_bridge_instance_limit'
                        AND ic.config_value #>> '{}' ~ '^[0-9]{1,6}$'), 100);
$$;

-- A connection the bridge host can run.
CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_configured()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.matrix_bridge_instance i
                    WHERE CASE i.connection
                            WHEN 'account' THEN i.access_token_secret IS NOT NULL
                            ELSE i.server_name IS NOT NULL AND i.sender_localpart IS NOT NULL
                                 AND i.appservice_url IS NOT NULL
                                 AND i.as_token_secret IS NOT NULL AND i.hs_token_secret IS NOT NULL END);
$$;

-- The Matrix user the instance's bridge host reported, whom a room invites.
CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_user()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT h.status #>> '{instance,user_id}' FROM public.bridge_hosts h WHERE h.platform = 'matrix';
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_purge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF to_regclass('vault.secrets') IS NOT NULL THEN
        DELETE FROM vault.secrets
         WHERE id IN (OLD.access_token_secret, OLD.as_token_secret, OLD.hs_token_secret);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS matrix_bridge_instance_purge ON public.matrix_bridge_instance;
CREATE TRIGGER matrix_bridge_instance_purge
    AFTER DELETE ON public.matrix_bridge_instance
    FOR EACH ROW EXECUTE FUNCTION public.matrix_bridge_instance_purge();

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.matrix_bridge_admit_mode(p_mode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_mode = 'hosted' THEN
        PERFORM public.discord_bridge_assert_vault();
        IF NOT public.matrix_bridge_hosting_enabled() THEN
            RAISE EXCEPTION 'Matrix bridge hosting is disabled on this instance' USING ERRCODE = '0A000';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtext('matrix_bridge_hosting'));
        IF (SELECT count(*) FROM public.matrix_bridges WHERE mode = 'hosted') >= public.matrix_bridge_hosting_limit() THEN
            RAISE EXCEPTION 'This instance already hosts its limit of % Matrix bridges',
                public.matrix_bridge_hosting_limit() USING ERRCODE = '54000';
        END IF;
    ELSIF p_mode = 'instance' THEN
        PERFORM public.discord_bridge_assert_vault();
        IF NOT public.matrix_bridge_instance_enabled() OR NOT public.matrix_bridge_instance_configured() THEN
            RAISE EXCEPTION 'This instance''s Matrix bridge is disabled or not configured' USING ERRCODE = '0A000';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtext('matrix_bridge_instance'));
        IF (SELECT count(*) FROM public.matrix_bridges WHERE mode = 'instance') >= public.matrix_bridge_instance_limit() THEN
            RAISE EXCEPTION 'This instance''s Matrix bridge already serves its limit of % servers',
                public.matrix_bridge_instance_limit() USING ERRCODE = '54000';
        END IF;
    END IF;
END;
$$;

-- A stored connection as admins read it and the admin log keeps it: without its secrets.
CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_view(p_row public.matrix_bridge_instance)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'connection', p_row.connection,
        'homeserver_url', p_row.homeserver_url,
        'server_name', p_row.server_name,
        'sender_localpart', p_row.sender_localpart,
        'appservice_url', p_row.appservice_url,
        'has_access_token', p_row.access_token_secret IS NOT NULL,
        'has_service_tokens', p_row.as_token_secret IS NOT NULL AND p_row.hs_token_secret IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_log(p_admin uuid, p_old jsonb, p_new jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.log_admin_action(p_admin, 'config_change', 'config', 'matrix_bridge_instance',
        jsonb_build_object('key', 'matrix_bridge_instance', 'old_value', p_old, 'new_value', p_new));
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.matrix_bridge_instance;
BEGIN
    IF public.get_current_profile_id() IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM public.matrix_bridge_instance;
    RETURN public.matrix_bridge_instance_view(v_row) || jsonb_build_object(
        'enabled', public.matrix_bridge_instance_enabled(),
        'configured', public.matrix_bridge_instance_configured(),
        'linked_count', (SELECT count(*) FROM public.matrix_bridges WHERE mode = 'instance'),
        'limit', public.matrix_bridge_instance_limit(),
        'hosting_enabled', public.matrix_bridge_hosting_enabled(),
        'hosting_limit', public.matrix_bridge_hosting_limit(),
        'hosted_count', (SELECT count(*) FROM public.matrix_bridges WHERE mode = 'hosted'),
        'host', (SELECT jsonb_build_object('last_seen_at', h.last_seen_at, 'version', h.version, 'status', h.status)
                   FROM public.bridge_hosts h WHERE h.platform = 'matrix'));
END;
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_set(
    p_connection text,
    p_homeserver_url text,
    p_access_token text,
    p_server_name text,
    p_sender_localpart text,
    p_appservice_url text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    -- http(s), a host, an optional port and path; no credentials, query or fragment.
    c_url constant text := '^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$';
    v_me uuid := public.get_current_profile_id();
    v_token text := NULLIF(btrim(COALESCE(p_access_token, ''), E' \t\r\n'), '');
    v_old public.matrix_bridge_instance;
    v_new public.matrix_bridge_instance;
    v_token_id uuid;
    v_moved boolean;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    PERFORM public.discord_bridge_assert_vault();

    PERFORM pg_advisory_xact_lock(hashtext('matrix_bridge_instance'));
    SELECT * INTO v_old FROM public.matrix_bridge_instance WHERE id;

    v_new.connection := COALESCE(NULLIF(btrim(p_connection), ''), v_old.connection);
    v_new.homeserver_url := COALESCE(NULLIF(regexp_replace(btrim(p_homeserver_url), '/+$', ''), ''), v_old.homeserver_url);
    v_new.server_name := COALESCE(NULLIF(btrim(p_server_name), ''), v_old.server_name);
    v_new.sender_localpart := COALESCE(NULLIF(btrim(p_sender_localpart), ''), v_old.sender_localpart, 'harmony_relay');
    v_new.appservice_url := COALESCE(
        NULLIF(regexp_replace(btrim(p_appservice_url), '/+$', ''), ''), v_old.appservice_url,
        'https://' || regexp_replace(regexp_replace(public.get_instance_domain(), '^https?://', ''), '/+$', '') || '/matrix-appservice');

    IF v_new.connection IS NULL OR v_new.connection NOT IN ('application_service', 'account') THEN
        RAISE EXCEPTION 'connection must be application_service or account' USING ERRCODE = '22023';
    END IF;
    IF v_new.homeserver_url IS NULL OR char_length(v_new.homeserver_url) > 255 OR v_new.homeserver_url !~ c_url THEN
        RAISE EXCEPTION 'homeserver_url must be an http or https URL' USING ERRCODE = '22023';
    END IF;
    IF v_new.connection = 'application_service' AND v_new.server_name IS NULL THEN
        RAISE EXCEPTION 'server_name is required' USING ERRCODE = '22023';
    END IF;
    -- As harmony-matrix-bridge reads them; a ghost is '@<localpart>_h_<32 hex>:<server_name>', at most 255.
    IF v_new.server_name !~ '^[A-Za-z0-9.-]+(:[0-9]+)?$' OR v_new.sender_localpart !~ '^[a-z0-9._=-]+$'
       OR char_length(v_new.sender_localpart) + COALESCE(char_length(v_new.server_name), 0) + 37 > 255 THEN
        RAISE EXCEPTION 'server_name or sender_localpart is not valid' USING ERRCODE = '22023';
    END IF;
    IF char_length(v_new.appservice_url) > 255 OR v_new.appservice_url !~ c_url THEN
        RAISE EXCEPTION 'appservice_url must be an http or https URL' USING ERRCODE = '22023';
    END IF;
    IF v_token IS NOT NULL AND (char_length(v_token) NOT BETWEEN 8 AND 4096 OR v_token COLLATE "C" !~ '^[!-~]+$') THEN
        RAISE EXCEPTION 'Not a Matrix access token' USING ERRCODE = '22023';
    END IF;

    -- A stored token goes to the homeserver it was stored for alone: the host sends it to homeserver_url.
    v_moved := v_old.homeserver_url IS DISTINCT FROM v_new.homeserver_url;
    IF v_token IS NOT NULL THEN
        v_token_id := vault.create_secret(v_token, NULL, 'Matrix bridge of the instance: access token');
    END IF;
    INSERT INTO public.matrix_bridge_instance AS i
        (id, connection, homeserver_url, server_name, sender_localpart, appservice_url, access_token_secret, updated_at)
    VALUES (true, v_new.connection, v_new.homeserver_url, v_new.server_name, v_new.sender_localpart, v_new.appservice_url,
            v_token_id, now())
    ON CONFLICT (id) DO UPDATE
       SET connection = EXCLUDED.connection,
           homeserver_url = EXCLUDED.homeserver_url,
           server_name = EXCLUDED.server_name,
           sender_localpart = EXCLUDED.sender_localpart,
           appservice_url = EXCLUDED.appservice_url,
           access_token_secret = COALESCE(EXCLUDED.access_token_secret, CASE WHEN NOT v_moved THEN i.access_token_secret END),
           as_token_secret = CASE WHEN NOT v_moved THEN i.as_token_secret END,
           hs_token_secret = CASE WHEN NOT v_moved THEN i.hs_token_secret END,
           updated_at = now()
    RETURNING * INTO v_new;
    DELETE FROM vault.secrets
     WHERE id IN (v_old.access_token_secret, v_old.as_token_secret, v_old.hs_token_secret)
       AND id NOT IN (SELECT kept FROM unnest(ARRAY[v_new.access_token_secret, v_new.as_token_secret, v_new.hs_token_secret]) kept
                       WHERE kept IS NOT NULL);

    PERFORM public.matrix_bridge_instance_log(v_me, public.matrix_bridge_instance_view(v_old),
                                              public.matrix_bridge_instance_view(v_new));
    RETURN public.matrix_bridge_instance_status();
END;
$$;

-- The registration the operator gives the homeserver, as harmony-matrix-bridge writes it
-- (registration() of its src/config.ts). Its tokens replace the stored ones; they are answered here alone.
CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_registration()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    c_default_localpart constant text := 'harmony_relay';
    v_me uuid := public.get_current_profile_id();
    v_old public.matrix_bridge_instance;
    v_new public.matrix_bridge_instance;
    v_as text := encode(extensions.gen_random_bytes(32), 'hex');
    v_hs text := encode(extensions.gen_random_bytes(32), 'hex');
    v_sender text;
    v_server text;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    PERFORM public.discord_bridge_assert_vault();

    PERFORM pg_advisory_xact_lock(hashtext('matrix_bridge_instance'));
    SELECT * INTO v_old FROM public.matrix_bridge_instance WHERE id;
    IF v_old.connection IS DISTINCT FROM 'application_service' OR v_old.server_name IS NULL
       OR v_old.sender_localpart IS NULL OR v_old.appservice_url IS NULL THEN
        RAISE EXCEPTION 'The instance''s Matrix bridge is not set up as an application service' USING ERRCODE = '22023';
    END IF;

    UPDATE public.matrix_bridge_instance
       SET as_token_secret = vault.create_secret(v_as, NULL, 'Matrix bridge of the instance: application service token'),
           hs_token_secret = vault.create_secret(v_hs, NULL, 'Matrix bridge of the instance: homeserver token'),
           updated_at = now()
     WHERE id
    RETURNING * INTO v_new;
    DELETE FROM vault.secrets WHERE id IN (v_old.as_token_secret, v_old.hs_token_secret);

    PERFORM public.matrix_bridge_instance_log(v_me, public.matrix_bridge_instance_view(v_old),
                                              public.matrix_bridge_instance_view(v_new) || '{"registration": "new"}'::jsonb);

    v_sender := regexp_replace(v_new.sender_localpart, '([.*+?^${}()|\[\]\\])', '\\\1', 'g');
    v_server := regexp_replace(v_new.server_name, '([.*+?^${}()|\[\]\\])', '\\\1', 'g');
    RETURN jsonb_build_object(
        'id', 'harmony-matrix-relay'
              || CASE WHEN v_new.sender_localpart = c_default_localpart THEN '' ELSE '-' || v_new.sender_localpart END,
        'url', v_new.appservice_url,
        'as_token', v_as,
        'hs_token', v_hs,
        'sender_localpart', v_new.sender_localpart,
        'namespaces', jsonb_build_object(
            'users', jsonb_build_array(
                jsonb_build_object('exclusive', true, 'regex', '^@' || v_sender || ':' || v_server || '$'),
                jsonb_build_object('exclusive', true, 'regex', '^@' || v_sender || '_h_[0-9a-f]{32}:' || v_server || '$')),
            'aliases', '[]'::jsonb,
            'rooms', '[]'::jsonb),
        'rate_limited', false,
        'de.sorunome.msc2409.push_ephemeral', false);
END;
$$;

-- Deletes the stored connection and its Vault secrets, and turns the mode off. Instance bridges stay;
-- the host serves them again once a connection is stored and the mode is on.
CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_clear()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_old public.matrix_bridge_instance;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('matrix_bridge_instance'));
    DELETE FROM public.matrix_bridge_instance WHERE id RETURNING * INTO v_old;
    UPDATE public.instance_config
       SET config_value = 'false'::jsonb, updated_at = now(), updated_by = v_me
     WHERE config_key = 'matrix_bridge_instance_enabled'
       AND config_value IS DISTINCT FROM 'false'::jsonb;
    IF v_old.id IS NOT NULL THEN
        PERFORM public.matrix_bridge_instance_log(v_me, public.matrix_bridge_instance_view(v_old), NULL);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_hosts_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.get_current_profile_id() IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('platform', h.platform, 'last_seen_at', h.last_seen_at,
                                                         'version', h.version, 'status', h.status)
                                      ORDER BY h.platform), '[]'::jsonb)
              FROM public.bridge_hosts h);
END;
$$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

-- The modes this instance offers, and whom a room invites in instance mode.
CREATE OR REPLACE FUNCTION public.matrix_bridge_offers()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_instance boolean := public.matrix_bridge_instance_enabled() AND public.matrix_bridge_instance_configured();
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    RETURN jsonb_build_object(
        'hosted', public.matrix_bridge_hosting_enabled(),
        'instance', v_instance,
        'instance_user', CASE WHEN v_instance THEN public.matrix_bridge_instance_user() END);
END;
$$;

-- {code, expires_at, user_id}: the code a person with power in a Matrix room posts there, after
-- inviting user_id, to link the room with the channel.
CREATE OR REPLACE FUNCTION public.matrix_bridge_room_code(
    p_bridge_id uuid,
    p_channel_id uuid,
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
    v_direction text := COALESCE(NULLIF(btrim(p_direction), ''), 'both');
    v_mode text := COALESCE(NULLIF(btrim(p_sender_mode), ''), 'ghost');
    v_expires timestamptz := now() + interval '30 minutes';
    v_code text := public.matrix_bridge_new_code('ML');
BEGIN
    IF v_bridge.mode <> 'instance' THEN
        RAISE EXCEPTION 'Room codes are for this instance''s Matrix bridge' USING ERRCODE = '22023';
    END IF;
    IF NOT public.matrix_bridge_instance_enabled() OR NOT public.matrix_bridge_instance_configured() THEN
        RAISE EXCEPTION 'This instance''s Matrix bridge is disabled or not configured' USING ERRCODE = '0A000';
    END IF;
    PERFORM public.matrix_bridge_check_pair(v_bridge.server_id, p_channel_id, v_caller, v_direction, v_mode);
    IF public.channel_messages_encrypted(p_channel_id) THEN
        RAISE EXCEPTION 'An end-to-end encrypted channel cannot be bridged' USING ERRCODE = '22023';
    END IF;

    DELETE FROM public.matrix_bridge_room_codes
     WHERE bridge_id = v_bridge.id AND (channel_id = p_channel_id OR expires_at < now() - interval '1 day');
    INSERT INTO public.matrix_bridge_room_codes
        (code_hash, bridge_id, channel_id, direction, sender_mode, created_by, expires_at)
    VALUES (public.matrix_bridge_code_hash(v_code), v_bridge.id, p_channel_id, v_direction, v_mode, v_caller, v_expires);

    RETURN jsonb_build_object('code', v_code, 'expires_at', v_expires, 'user_id', public.matrix_bridge_instance_user());
END;
$$;

-- ---------------------------------------------------------------------------
-- Gateway functions (service_role)
-- ---------------------------------------------------------------------------

-- The connection with its secrets and every instance bridge with its Harmony token, for the bridge
-- host; NULL while the mode is off or not configured.
CREATE OR REPLACE FUNCTION public.matrix_bridge_instance_hosted()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_result jsonb;
BEGIN
    IF NOT public.matrix_bridge_instance_enabled() OR NOT public.matrix_bridge_instance_configured() THEN
        RETURN NULL;
    END IF;
    PERFORM public.discord_bridge_assert_vault();

    SELECT jsonb_build_object(
               'connection', i.connection,
               'homeserver_url', i.homeserver_url,
               'server_name', i.server_name,
               'sender_localpart', i.sender_localpart,
               'as_token', CASE WHEN i.connection = 'application_service' THEN
                   (SELECT d.decrypted_secret FROM vault.decrypted_secrets d WHERE d.id = i.as_token_secret) END,
               'hs_token', CASE WHEN i.connection = 'application_service' THEN
                   (SELECT d.decrypted_secret FROM vault.decrypted_secrets d WHERE d.id = i.hs_token_secret) END,
               'access_token', CASE WHEN i.connection = 'account' THEN
                   (SELECT d.decrypted_secret FROM vault.decrypted_secrets d WHERE d.id = i.access_token_secret) END,
               'bridges', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object('bridge_id', b.id, 'harmony_token', h.decrypted_secret)
                                    ORDER BY b.created_at, b.id)
                     FROM public.matrix_bridges b
                     JOIN public.matrix_bridge_secrets s ON s.bridge_id = b.id
                     JOIN public.bots bo ON bo.id = b.bot_id AND bo.is_active IS TRUE
                     JOIN vault.decrypted_secrets h ON h.id = s.harmony_token_secret
                    WHERE b.mode = 'instance'), '[]'::jsonb))
      INTO v_result
      FROM public.matrix_bridge_instance i
     WHERE i.id;
    RETURN v_result;
END;
$$;

-- {bridge_id, server_name, channel_id, channel_name}; NULL for a malformed, unknown, used or expired
-- code, one whose issuer no longer manages the server or sees the channel, and while instance mode is
-- off. One answer for every failure. 55000 channel_encrypted keeps the code.
--
-- The code of one channel links that channel alone. A room bound to another bridge's channel moves: its
-- pair there is unbound with the error room_in_use, for the code was posted by someone with power in
-- the room after it. A pair of the same bridge with the room, or the channel, is replaced.
--
-- Locks: the room (as matrix_bridge_bind_room), then the two bridges in id order.
CREATE OR REPLACE FUNCTION public.matrix_bridge_link_room(p_code text, p_room_id text, p_sender text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_code text := public.matrix_bridge_normalize_code(p_code, 'ML');
    v_hash text := public.matrix_bridge_code_hash(COALESCE(v_code, ''));
    v_bridge_id uuid;
    v_bridge public.matrix_bridges;
    v_link public.matrix_bridge_room_codes;
    v_bot uuid;
BEGIN
    IF p_room_id IS NULL OR char_length(p_room_id) NOT BETWEEN 2 AND 255 OR p_room_id !~ '^![^[:space:][:cntrl:]/]+$'
       OR p_sender IS NULL OR char_length(p_sender) > 255 OR p_sender !~ '^@[^:[:space:][:cntrl:]]+:[^[:space:][:cntrl:]]+$' THEN
        RAISE EXCEPTION 'Invalid Matrix room or user id' USING ERRCODE = '22023';
    END IF;
    IF v_code IS NULL OR NOT public.matrix_bridge_instance_enabled() OR NOT public.matrix_bridge_instance_configured() THEN
        RETURN NULL;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('matrix_room:' || p_room_id, 0));
    SELECT c.bridge_id INTO v_bridge_id FROM public.matrix_bridge_room_codes c WHERE c.code_hash = v_hash;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    PERFORM 1
       FROM public.matrix_bridges b
      WHERE b.id = v_bridge_id
         OR b.bot_id = (SELECT bc.bot_id FROM public.bridge_channels bc WHERE bc.room_id = p_room_id AND bc.room_bound)
      ORDER BY b.id
        FOR UPDATE;
    SELECT * INTO v_bridge FROM public.matrix_bridges b WHERE b.id = v_bridge_id AND b.mode = 'instance';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.matrix_bridge_room_codes
       SET used_at = now(), used_by = p_sender
     WHERE code_hash = v_hash
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING * INTO v_link;
    IF NOT FOUND
       OR NOT public.matrix_bridge_managed_by(v_link.created_by, v_bridge.server_id)
       OR NOT public.can_view_channel(v_link.created_by, v_link.channel_id) THEN
        RETURN NULL;
    END IF;
    IF public.channel_messages_encrypted(v_link.channel_id) THEN
        RAISE EXCEPTION 'channel_encrypted' USING ERRCODE = '55000';
    END IF;

    v_bot := COALESCE(v_bridge.bot_id, public.matrix_bridge_provision_bot(v_bridge.id, v_link.created_by));
    UPDATE public.bridge_channels bc
       SET room_bound = false, room_proof = NULL, state = 'error', state_error = 'room_in_use'
     WHERE bc.room_id = p_room_id AND bc.room_bound AND bc.bot_id <> v_bot;
    DELETE FROM public.bridge_channels bc
     WHERE bc.bot_id = v_bot AND bc.room_id = p_room_id AND bc.channel_id <> v_link.channel_id;
    INSERT INTO public.bridge_channels
        (bot_id, channel_id, platform, room_id, room_bound, room_proof, direction, sender_mode, sender_mode_set_by_manager)
    VALUES (v_bot, v_link.channel_id, 'matrix', p_room_id, true, 'code', v_link.direction, v_link.sender_mode, true)
    ON CONFLICT (bot_id, channel_id) DO UPDATE
       SET room_id = EXCLUDED.room_id,
           room_bound = true,
           room_proof = 'code',
           room_alias = NULL,
           direction = EXCLUDED.direction,
           sender_mode = EXCLUDED.sender_mode,
           sender_mode_set_by_manager = true,
           state = NULL,
           state_error = NULL;
    PERFORM public.matrix_bridge_install_bot(v_bot, v_bridge.server_id, v_link.created_by);

    RETURN (SELECT jsonb_build_object('bridge_id', v_bridge.id, 'server_name', s.name,
                                      'channel_id', c.id, 'channel_name', c.name)
              FROM public.channels c
              JOIN public.servers s ON s.id = c.server_id
             WHERE c.id = v_link.channel_id);
END;
$$;

-- A bridge host called. p_status NULL records the time alone, at most once a minute.
CREATE OR REPLACE FUNCTION public.bridge_host_report(p_platform text, p_version text DEFAULT NULL, p_status jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_platform IS NULL OR p_platform NOT IN ('discord', 'matrix')
       OR (p_status IS NOT NULL AND (jsonb_typeof(p_status) <> 'object' OR octet_length(p_status::text) > 65536)) THEN
        RAISE EXCEPTION 'platform must be discord or matrix, status an object of at most 64 KiB' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.bridge_hosts AS h (platform, last_seen_at, version, status)
    VALUES (p_platform, now(), left(NULLIF(btrim(p_version), ''), 64), COALESCE(p_status, '{}'::jsonb))
    ON CONFLICT (platform) DO UPDATE
       SET last_seen_at = now(),
           version = CASE WHEN p_status IS NULL THEN h.version ELSE EXCLUDED.version END,
           status = CASE WHEN p_status IS NULL THEN h.status ELSE EXCLUDED.status END
     WHERE p_status IS NOT NULL OR h.last_seen_at <= now() - interval '1 minute';
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
        'public.matrix_bridge_instance_status()',
        'public.matrix_bridge_instance_set(text, text, text, text, text, text)',
        'public.matrix_bridge_instance_registration()',
        'public.matrix_bridge_instance_clear()',
        'public.bridge_hosts_status()',
        'public.matrix_bridge_offers()',
        'public.matrix_bridge_room_code(uuid, uuid, text, text)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.matrix_bridge_instance_hosted()',
        'public.matrix_bridge_link_room(text, text, text)',
        'public.bridge_host_report(text, text, jsonb)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    -- Reached only from the definers above and from triggers, which run as the owner.
    FOREACH fn IN ARRAY ARRAY[
        'public.matrix_bridge_instance_enabled()',
        'public.matrix_bridge_instance_limit()',
        'public.matrix_bridge_instance_configured()',
        'public.matrix_bridge_instance_user()',
        'public.matrix_bridge_instance_view(public.matrix_bridge_instance)',
        'public.matrix_bridge_instance_log(uuid, jsonb, jsonb)',
        'public.matrix_bridge_admit_mode(text)',
        'public.matrix_bridge_instance_purge()'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
