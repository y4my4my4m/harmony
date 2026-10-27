-- Sign-in through an instance's own OAuth 2.0 / OIDC provider (GoTrue custom providers, 2.187.0+).
--
-- instance_config custom_oauth_providers (public key): the sign-in buttons of those providers,
-- [{"id": "custom:<slug>", "name": "<display name>", "icon": "<https or data:image URL>"}].
-- GoTrue keeps each provider's endpoints, client id and client secret in
-- auth.custom_oauth_providers, outside this schema and readable by no API role.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('custom_oauth_providers' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'custom_oauth_providers'::text));
    END IF;
END;
$do$;

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('custom_oauth_providers', '[]'::jsonb,
        'Sign-in buttons of the instance''s own OAuth/OIDC providers. Written by harmony auth add-provider; the client secrets stay in GoTrue.')
ON CONFLICT (config_key) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
