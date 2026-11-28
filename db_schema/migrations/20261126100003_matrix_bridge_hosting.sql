-- Hosted Matrix bridges: a community's own Matrix account, run by the instance's Matrix bridge host.
--
--   hosted  a mode of matrix_bridges (20261126100001). The community's homeserver and the access
--           token of its account come from matrix_bridge_set_account; the token and a Harmony token
--           of the bridge bot are Vault secrets (matrix_bridge_secrets), read by the gateway's
--           GET /bridge/v2/matrix/host through matrix_bridge_hosted_list. The account's password never
--           reaches Harmony.
--
-- matrix_bridges.homeserver_url   hosted: 'https://host[:port]', lowercase, no trailing slash. The
--                                 bridge host resolves it and refuses private addresses.
-- matrix_bridge_secrets           Vault secret ids. service_role only. Deleting the row deletes the
--                                 Vault secrets; a replaced secret is deleted with its replacement. An
--                                 instance bridge (20261126100004) holds harmony_token_secret alone.
--
-- Instance configuration: matrix_bridge_hosting_enabled (boolean, default false, public) and
-- matrix_bridge_hosting_limit (integer, default 25), as Discord's. Vault (supabase_vault) is required;
-- without it the functions raise 0A000.
--
-- Managers:
--   matrix_bridge_set_account(bridge, homeserver_url, access_token)  the state
-- Service role:
--   matrix_bridge_hosted_list()     bridge_id, harmony_token, homeserver_url, access_token; empty while
--                                   hosting is off
-- Of 20261126100001, redefined:
--   matrix_bridge_admit_mode        admits hosted: Vault, switch (0A000), limit (54000)
--   matrix_bridge_json              gains homeserver_url and has_account
--
-- Errors: 42501 caller lacks MANAGE_SERVER or authentication; P0002 bridge absent; 22023 invalid
-- argument; 0A000 hosting disabled or Vault absent; 54000 hosting limit reached.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
ALTER TABLE public.matrix_bridges ADD COLUMN IF NOT EXISTS homeserver_url text;
ALTER TABLE public.matrix_bridges DROP CONSTRAINT IF EXISTS matrix_bridges_homeserver_check;
ALTER TABLE public.matrix_bridges ADD CONSTRAINT matrix_bridges_homeserver_check
    CHECK (char_length(homeserver_url) <= 255 AND homeserver_url ~ '^https://[^/?#@[:space:][:cntrl:]]+$');

CREATE TABLE IF NOT EXISTS public.matrix_bridge_secrets (
    bridge_id uuid PRIMARY KEY REFERENCES public.matrix_bridges(id) ON DELETE CASCADE,
    access_token_secret uuid,
    harmony_token_secret uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.matrix_bridge_secrets IS
    'Vault secret ids of a hosted or instance Matrix bridge: the Matrix account''s access token and the bridge bot''s Harmony token.';

REVOKE ALL ON public.matrix_bridge_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.matrix_bridge_secrets TO service_role;
ALTER TABLE public.matrix_bridge_secrets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS matrix_bridge_secrets_service_role ON public.matrix_bridge_secrets;
CREATE POLICY matrix_bridge_secrets_service_role ON public.matrix_bridge_secrets
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.matrix_bridge_secrets_purge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF to_regclass('vault.secrets') IS NOT NULL THEN
        DELETE FROM vault.secrets
         WHERE id IN (OLD.access_token_secret, OLD.harmony_token_secret);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS matrix_bridge_secrets_purge ON public.matrix_bridge_secrets;
CREATE TRIGGER matrix_bridge_secrets_purge
    AFTER DELETE ON public.matrix_bridge_secrets
    FOR EACH ROW EXECUTE FUNCTION public.matrix_bridge_secrets_purge();

-- ---------------------------------------------------------------------------
-- Instance configuration
-- ---------------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('matrix_bridge_hosting_enabled', 'false'::jsonb,
        'Communities may run a Matrix bridge with their own Matrix account on this instance''s bridge host (hosted mode).'),
       ('matrix_bridge_hosting_limit', '25'::jsonb,
        'Most hosted Matrix bridges this instance runs.')
ON CONFLICT (config_key) DO NOTHING;

DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('matrix_bridge_hosting_enabled' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'matrix_bridge_hosting_enabled'::text));
    END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_hosting_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT lower(ic.config_value #>> '{}') = 'true'
                       FROM public.instance_config ic
                      WHERE ic.config_key = 'matrix_bridge_hosting_enabled'), false);
$$;

CREATE OR REPLACE FUNCTION public.matrix_bridge_hosting_limit()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((SELECT (ic.config_value #>> '{}')::integer
                       FROM public.instance_config ic
                      WHERE ic.config_key = 'matrix_bridge_hosting_limit'
                        AND ic.config_value #>> '{}' ~ '^[0-9]{1,6}$'), 25);
$$;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- Issues the bridge bot's Harmony token, the earlier ones revoked, and stores it in Vault in place of
-- the stored one.
CREATE OR REPLACE FUNCTION public.matrix_bridge_vault_token(p_bridge_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_old uuid;
    v_new uuid;
BEGIN
    PERFORM public.discord_bridge_assert_vault();
    SELECT harmony_token_secret INTO v_old FROM public.matrix_bridge_secrets WHERE bridge_id = p_bridge_id FOR UPDATE;
    v_new := vault.create_secret(
        public.matrix_bridge_issue_token((SELECT b.bot_id FROM public.matrix_bridges b WHERE b.id = p_bridge_id)),
        NULL, 'Matrix bridge ' || p_bridge_id || ': Harmony bot token');
    INSERT INTO public.matrix_bridge_secrets (bridge_id, harmony_token_secret, updated_at)
    VALUES (p_bridge_id, v_new, now())
    ON CONFLICT (bridge_id) DO UPDATE
       SET harmony_token_secret = EXCLUDED.harmony_token_secret, updated_at = now();
    DELETE FROM vault.secrets WHERE id = v_old;
END;
$$;

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
    ELSIF p_mode <> 'self' THEN
        RAISE EXCEPTION 'This instance does not run Matrix bridges' USING ERRCODE = '0A000';
    END IF;
END;
$$;

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
               'homeserver_url', b.homeserver_url,
               'has_account', EXISTS (SELECT 1 FROM public.matrix_bridge_secrets s
                                       WHERE s.bridge_id = b.id AND s.access_token_secret IS NOT NULL),
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

-- ---------------------------------------------------------------------------
-- Client RPC
-- ---------------------------------------------------------------------------

-- The account a hosted bridge runs as. Both values each time; the bridge bot gets a new Harmony token.
-- Another homeserver forgets the status and the rooms of the earlier account.
CREATE OR REPLACE FUNCTION public.matrix_bridge_set_account(
    p_bridge_id uuid,
    p_homeserver_url text,
    p_access_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.matrix_bridges := public.matrix_bridge_for_manager(p_bridge_id);
    v_url text := lower(regexp_replace(btrim(COALESCE(p_homeserver_url, ''), E' \t\r\n'), '/$', ''));
    v_token text := btrim(COALESCE(p_access_token, ''), E' \t\r\n');
    v_old uuid;
    v_new uuid;
BEGIN
    IF v_bridge.mode <> 'hosted' THEN
        RAISE EXCEPTION 'Only hosted bridges store a Matrix account' USING ERRCODE = '22023';
    END IF;
    PERFORM public.discord_bridge_assert_vault();
    IF NOT public.matrix_bridge_hosting_enabled() THEN
        RAISE EXCEPTION 'Matrix bridge hosting is disabled on this instance' USING ERRCODE = '0A000';
    END IF;
    -- A name or IPv4 address, or an IPv6 address in brackets; port 1 to 65535.
    IF char_length(v_url) > 255
       OR v_url !~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(:[1-9][0-9]{0,4})?$'
       OR COALESCE(substring(v_url FROM ':([0-9]+)$')::numeric, 443) > 65535 THEN
        RAISE EXCEPTION 'homeserver_url must be https://host without a path' USING ERRCODE = '22023';
    END IF;
    IF char_length(v_token) NOT BETWEEN 8 AND 4096 OR v_token COLLATE "C" !~ '^[!-~]+$' THEN
        RAISE EXCEPTION 'Not a Matrix access token' USING ERRCODE = '22023';
    END IF;

    IF v_bridge.bot_id IS NULL THEN
        PERFORM public.matrix_bridge_provision_bot(v_bridge.id, public.get_current_profile_id());
    ELSE
        PERFORM public.matrix_bridge_vault_token(v_bridge.id);
    END IF;

    v_new := vault.create_secret(v_token, NULL, 'Matrix bridge ' || v_bridge.id || ': Matrix access token');
    SELECT access_token_secret INTO v_old FROM public.matrix_bridge_secrets WHERE bridge_id = v_bridge.id FOR UPDATE;
    UPDATE public.matrix_bridge_secrets SET access_token_secret = v_new, updated_at = now() WHERE bridge_id = v_bridge.id;
    DELETE FROM vault.secrets WHERE id = v_old;

    UPDATE public.matrix_bridges b
       SET homeserver_url = v_url,
           status = CASE WHEN b.homeserver_url IS DISTINCT FROM v_url THEN '{}'::jsonb ELSE b.status END,
           snapshot = CASE WHEN b.homeserver_url IS DISTINCT FROM v_url THEN '{}'::jsonb ELSE b.snapshot END
     WHERE b.id = v_bridge.id;
    RETURN public.matrix_bridge_json(v_bridge.id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Gateway functions (service_role)
-- ---------------------------------------------------------------------------

-- Hosted bridges with both tokens; empty while hosting is disabled.
CREATE OR REPLACE FUNCTION public.matrix_bridge_hosted_list()
RETURNS TABLE (bridge_id uuid, harmony_token text, homeserver_url text, access_token text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.matrix_bridge_hosting_enabled() THEN
        RETURN;
    END IF;
    PERFORM public.discord_bridge_assert_vault();

    RETURN QUERY
    SELECT b.id, h.decrypted_secret, b.homeserver_url, a.decrypted_secret
      FROM public.matrix_bridges b
      JOIN public.matrix_bridge_secrets s ON s.bridge_id = b.id
      JOIN public.bots bo ON bo.id = b.bot_id AND bo.is_active IS TRUE
      JOIN vault.decrypted_secrets a ON a.id = s.access_token_secret
      JOIN vault.decrypted_secrets h ON h.id = s.harmony_token_secret
     WHERE b.mode = 'hosted' AND b.homeserver_url IS NOT NULL
     ORDER BY b.created_at, b.id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    fn regprocedure;
BEGIN
    REVOKE ALL ON FUNCTION public.matrix_bridge_set_account(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.matrix_bridge_set_account(uuid, text, text) TO authenticated;

    REVOKE ALL ON FUNCTION public.matrix_bridge_hosted_list() FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.matrix_bridge_hosted_list() TO service_role;

    -- Reached only from the definers above and from triggers, which run as the owner.
    FOREACH fn IN ARRAY ARRAY[
        'public.matrix_bridge_hosting_enabled()',
        'public.matrix_bridge_hosting_limit()',
        'public.matrix_bridge_vault_token(uuid)',
        'public.matrix_bridge_admit_mode(text)',
        'public.matrix_bridge_json(uuid)',
        'public.matrix_bridge_secrets_purge()'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
