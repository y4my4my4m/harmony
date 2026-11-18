-- Sign-in credentials of GoTrue's built-in OAuth providers, set from Admin, Authentication.
--
-- auth_provider_credentials   one row per provider the admin panel manages: google, twitch,
--                             github, discord. client_id plain; secret_id a Vault secret id.
--                             A row without credentials is a provider the panel turned off.
--                             service_role only.
-- auth_provider_writer        singleton: the federation server's last pass over the rows.
--                             seen_at every pass, applied_at when the file changed, error its
--                             last failure. service_role only.
--
-- The federation server (HARMONY_AUTH_CONFIG_DIR) renders the rows into 50-harmony-oauth.env in
-- GoTrue's --config-dir, which GoTrue reloads without a restart:
--   GOTRUE_EXTERNAL_<P>_ENABLED, _CLIENT_ID, _SECRET, _REDIRECT_URI
-- for every row. A provider runs while its row holds a client id and a secret and its button is
-- on (instance_config.oauth_providers); otherwise it is written ENABLED=false, since a reload
-- overlays the directory on GoTrue's environment and never unsets a key. Providers without a row
-- keep what supabase/.env gives them.
--
-- Values are written into a process environment: client ids and secrets are limited to
-- [A-Za-z0-9._~+/=-], first character alphanumeric. No comma: GoTrue splits a client id list on
-- it. Discord client ids are its application ids, 17 to 20 digits.
--
-- Client RPC (instance admins):
--   auth_provider_credentials_status() -> {providers: [{provider, client_id, has_secret,
--                                          updated_at}], writer: {seen_at, applied_at, error,
--                                          live}}
--   auth_provider_credentials_set(provider, client_id, secret) -> status. NULL or '' keeps the
--                                          stored value; a new row needs both.
--   auth_provider_credentials_clear(provider) -> status. Drops both; the provider goes off.
-- Service role:
--   auth_provider_credentials_render() -> (provider, client_id, client_secret, enabled)
--   auth_provider_writer_report(applied, error) records a pass of the writer.
--
-- Errors: 42501 not an instance admin; 22023 invalid provider, client id or secret, or a new
-- provider without both; 0A000 Vault absent. The message is the reason.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.auth_provider_credentials (
    provider text PRIMARY KEY,
    client_id text,
    secret_id uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    CONSTRAINT auth_provider_credentials_provider_check
        CHECK (provider IN ('google', 'twitch', 'github', 'discord')),
    CONSTRAINT auth_provider_credentials_client_id_check
        CHECK (client_id IS NULL OR client_id ~ '^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,255}$')
);

COMMENT ON TABLE public.auth_provider_credentials IS
    'OAuth client ids and Vault secret ids of the built-in sign-in providers the admin panel manages.';

CREATE TABLE IF NOT EXISTS public.auth_provider_writer (
    id boolean PRIMARY KEY DEFAULT true,
    seen_at timestamptz,
    applied_at timestamptz,
    error text,
    CONSTRAINT auth_provider_writer_singleton CHECK (id),
    CONSTRAINT auth_provider_writer_error_check CHECK (char_length(error) <= 500)
);

COMMENT ON TABLE public.auth_provider_writer IS
    'Last pass of the federation server over auth_provider_credentials.';

REVOKE ALL ON public.auth_provider_credentials, public.auth_provider_writer FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.auth_provider_credentials, public.auth_provider_writer TO service_role;

ALTER TABLE public.auth_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_provider_writer ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_provider_credentials_service_role ON public.auth_provider_credentials;
CREATE POLICY auth_provider_credentials_service_role ON public.auth_provider_credentials
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS auth_provider_writer_service_role ON public.auth_provider_writer;
CREATE POLICY auth_provider_writer_service_role ON public.auth_provider_writer
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_provider_valid_value(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    -- PostgreSQL caps a repetition count at 255: the length is a separate test.
    SELECT char_length(p_value) <= 512 AND p_value ~ '^[A-Za-z0-9][A-Za-z0-9._~+/=-]*$';
$$;

-- instance_config.oauth_providers names P: a jsonb array of ids, an object of id -> true, or a
-- string of either, as AuthComponent reads it.
CREATE OR REPLACE FUNCTION public.auth_provider_button_on(p_provider text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v jsonb := (SELECT ic.config_value FROM public.instance_config ic WHERE ic.config_key = 'oauth_providers');
    v_text text;
BEGIN
    IF jsonb_typeof(v) = 'string' THEN
        v_text := btrim(v #>> '{}');
        IF left(v_text, 1) IN ('[', '{') THEN
            BEGIN
                v := v_text::jsonb;
            EXCEPTION WHEN others THEN
                RETURN false;
            END;
        ELSE
            RETURN EXISTS (SELECT 1 FROM unnest(string_to_array(v_text, ',')) p
                            WHERE lower(btrim(p)) = p_provider);
        END IF;
    END IF;
    RETURN CASE jsonb_typeof(v)
        WHEN 'array' THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(v) e WHERE lower(e) = p_provider)
        WHEN 'object' THEN COALESCE(lower(v ->> p_provider), 'false') = 'true'
        ELSE false
    END;
END;
$$;

-- ---------------------------------------------------------------------------
-- Client RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_provider_credentials_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_writer public.auth_provider_writer;
BEGIN
    IF public.get_current_profile_id() IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_writer FROM public.auth_provider_writer WHERE id;
    RETURN jsonb_build_object(
        'providers', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'provider', c.provider,
                       'client_id', c.client_id,
                       'has_secret', c.secret_id IS NOT NULL,
                       'updated_at', c.updated_at) ORDER BY c.provider)
              FROM public.auth_provider_credentials c), '[]'::jsonb),
        'writer', jsonb_build_object(
            'seen_at', v_writer.seen_at,
            'applied_at', v_writer.applied_at,
            'error', v_writer.error,
            -- The writer passes every 10 s.
            'live', COALESCE(v_writer.seen_at > now() - interval '90 seconds', false)));
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_provider_credentials_set(
    p_provider text,
    p_client_id text,
    p_secret text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_provider text := lower(btrim(COALESCE(p_provider, '')));
    v_client_id text := NULLIF(btrim(COALESCE(p_client_id, '')), '');
    v_secret text := NULLIF(btrim(COALESCE(p_secret, '')), '');
    v_old public.auth_provider_credentials;
    v_secret_id uuid;
    v_new public.auth_provider_credentials;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    IF v_provider NOT IN ('google', 'twitch', 'github', 'discord') THEN
        RAISE EXCEPTION 'Unknown sign-in provider' USING ERRCODE = '22023';
    END IF;
    IF v_client_id IS NOT NULL
       AND (char_length(v_client_id) > 256 OR NOT public.auth_provider_valid_value(v_client_id)
            OR (v_provider = 'discord' AND v_client_id !~ '^[0-9]{17,20}$')) THEN
        RAISE EXCEPTION 'Not a client id' USING ERRCODE = '22023';
    END IF;
    IF v_secret IS NOT NULL AND (char_length(v_secret) < 8 OR NOT public.auth_provider_valid_value(v_secret)) THEN
        RAISE EXCEPTION 'Not a client secret' USING ERRCODE = '22023';
    END IF;
    PERFORM public.discord_bridge_assert_vault();

    PERFORM pg_advisory_xact_lock(hashtext('auth_provider_credentials'));
    SELECT * INTO v_old FROM public.auth_provider_credentials WHERE provider = v_provider;
    IF COALESCE(v_client_id, v_old.client_id) IS NULL
       OR (v_secret IS NULL AND v_old.secret_id IS NULL) THEN
        RAISE EXCEPTION 'A client id and a client secret are required' USING ERRCODE = '22023';
    END IF;

    IF v_secret IS NOT NULL THEN
        v_secret_id := vault.create_secret(v_secret, NULL, 'Sign-in provider ' || v_provider || ': client secret');
    END IF;

    INSERT INTO public.auth_provider_credentials AS c (provider, client_id, secret_id, updated_at, updated_by)
    VALUES (v_provider, COALESCE(v_client_id, v_old.client_id), COALESCE(v_secret_id, v_old.secret_id), now(), v_me)
    ON CONFLICT (provider) DO UPDATE
       SET client_id = EXCLUDED.client_id,
           secret_id = EXCLUDED.secret_id,
           updated_at = now(),
           updated_by = v_me
    RETURNING * INTO v_new;

    IF v_secret_id IS NOT NULL AND v_old.secret_id IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = v_old.secret_id;
    END IF;

    PERFORM public.log_admin_action(v_me, 'config_change', 'config', 'auth_provider_credentials',
        jsonb_build_object(
            'key', 'auth_provider_credentials',
            'provider', v_provider,
            'old_value', CASE WHEN v_old.provider IS NOT NULL THEN
                jsonb_build_object('client_id', v_old.client_id, 'has_secret', v_old.secret_id IS NOT NULL) END,
            'new_value', jsonb_build_object('client_id', v_new.client_id, 'has_secret', true,
                                            'secret_changed', v_secret_id IS NOT NULL)));

    RETURN public.auth_provider_credentials_status();
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_provider_credentials_clear(p_provider text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_provider text := lower(btrim(COALESCE(p_provider, '')));
    v_old public.auth_provider_credentials;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Admin role required' USING ERRCODE = '42501';
    END IF;
    IF v_provider NOT IN ('google', 'twitch', 'github', 'discord') THEN
        RAISE EXCEPTION 'Unknown sign-in provider' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('auth_provider_credentials'));
    SELECT * INTO v_old FROM public.auth_provider_credentials WHERE provider = v_provider;
    IF v_old.provider IS NULL OR (v_old.client_id IS NULL AND v_old.secret_id IS NULL) THEN
        RETURN public.auth_provider_credentials_status();
    END IF;

    -- The row stays: the writer turns the provider off in GoTrue.
    UPDATE public.auth_provider_credentials
       SET client_id = NULL, secret_id = NULL, updated_at = now(), updated_by = v_me
     WHERE provider = v_provider;
    IF v_old.secret_id IS NOT NULL THEN
        DELETE FROM vault.secrets WHERE id = v_old.secret_id;
    END IF;

    PERFORM public.log_admin_action(v_me, 'config_change', 'config', 'auth_provider_credentials',
        jsonb_build_object(
            'key', 'auth_provider_credentials',
            'provider', v_provider,
            'old_value', jsonb_build_object('client_id', v_old.client_id, 'has_secret', v_old.secret_id IS NOT NULL),
            'new_value', NULL));

    RETURN public.auth_provider_credentials_status();
END;
$$;

-- ---------------------------------------------------------------------------
-- Service role
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.auth_provider_credentials_render()
RETURNS TABLE (provider text, client_id text, client_secret text, enabled boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.discord_bridge_assert_vault();
    RETURN QUERY
    SELECT c.provider, c.client_id, s.decrypted_secret,
           c.client_id IS NOT NULL AND s.decrypted_secret IS NOT NULL
             AND public.auth_provider_valid_value(c.client_id)
             AND public.auth_provider_valid_value(s.decrypted_secret)
             AND public.auth_provider_button_on(c.provider)
      FROM public.auth_provider_credentials c
      LEFT JOIN vault.decrypted_secrets s ON s.id = c.secret_id
     ORDER BY c.provider;
END;
$$;

CREATE OR REPLACE FUNCTION public.auth_provider_writer_report(p_applied boolean, p_error text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    INSERT INTO public.auth_provider_writer AS w (id, seen_at, applied_at, error)
    VALUES (true, now(), CASE WHEN p_applied THEN now() END, left(NULLIF(p_error, ''), 500))
    ON CONFLICT (id) DO UPDATE
       SET seen_at = now(),
           applied_at = CASE WHEN p_applied THEN now() ELSE w.applied_at END,
           error = EXCLUDED.error;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.auth_provider_credentials_status()',
        'public.auth_provider_credentials_set(text, text, text)',
        'public.auth_provider_credentials_clear(text)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.auth_provider_credentials_render()',
        'public.auth_provider_writer_report(boolean, text)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.auth_provider_valid_value(text)',
        'public.auth_provider_button_on(text)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
