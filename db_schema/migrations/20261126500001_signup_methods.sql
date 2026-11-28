-- Registration per sign-in method.
--
-- GoTrue has one sign-up switch (GOTRUE_DISABLE_SIGNUP), checked before any account is made and
-- before this hook, email or provider alike (api/external.go createAccountFromExternalIdentity,
-- api/hooks.go, api/signup.go, v2.197.0). The registration policy runs in the before-user-created
-- hook, which sees the method (app_metadata.provider) and the address; GoTrue's switch stays off
-- where the hook runs.
--
-- Settings (instance_config, admins read them):
--   registration_policy  "open", "invite" or "closed", written by `harmony registration`. Absent:
--                        the hook leaves email sign-up to GoTrue's switch. Any other value refuses.
--   signup_providers     {"<provider>": {"mode": "open" | "domains", "domains": ["example.edu"]}}.
--                        A provider absent, or with another mode, follows registration_policy.
--                        "domains" takes an address the provider marks verified
--                        (user_metadata.email_verified) at a listed domain or a subdomain of one.
--
-- Email and phone sign-ups follow registration_policy. Outside "open" they pass only with an
-- invite pass: signup_invite_pass(email), taken by the admin panel and `harmony admin invite`
-- just before GoTrue's /invite or /admin/generate_link, which run this hook for a new address.
-- The hook spends the pass. Passes live 10 minutes.
--
-- before_user_created_hook becomes signup_limits_check, unchanged; the new
-- before_user_created_hook runs signup_registration_refusal first and refuses with 503 when it
-- fails, where the limits let a sign-up through on their own failure.

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('signup_providers', '{}'::jsonb,
        'Sign-up through each sign-in provider: {"provider": {"mode": "open" | "domains", "domains": [...]}}; a provider absent follows registration_policy')
ON CONFLICT (config_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.signup_invite_passes (
    email text PRIMARY KEY CONSTRAINT signup_invite_passes_email_check CHECK (
        char_length(email) <= 320 AND email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    ),
    expires_at timestamptz NOT NULL
);
REVOKE ALL ON public.signup_invite_passes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.signup_invite_passes TO service_role;
ALTER TABLE public.signup_invite_passes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS signup_invite_passes_service_role ON public.signup_invite_passes;
CREATE POLICY signup_invite_passes_service_role ON public.signup_invite_passes
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.signup_invite_pass(p_email text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_email text := lower(btrim(coalesce(p_email, '')));
BEGIN
    IF char_length(v_email) > 320 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'not an email address' USING ERRCODE = '22023';
    END IF;
    DELETE FROM public.signup_invite_passes WHERE expires_at <= now();
    INSERT INTO public.signup_invite_passes (email, expires_at)
    VALUES (v_email, now() + interval '10 minutes')
    ON CONFLICT (email) DO UPDATE SET expires_at = excluded.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.signup_invite_pass(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_invite_pass(text) TO service_role;

-- NULL when the registration policy allows the sign-up; otherwise the hook's refusal.
CREATE OR REPLACE FUNCTION public.signup_registration_refusal(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_provider text := coalesce(nullif(btrim(event #>> '{user,app_metadata,provider}'), ''), 'email');
    v_email text := lower(nullif(btrim(event #>> '{user,email}'), ''));
    v_domain text;
    v_policy text;
    v_entry jsonb;
    v_mode text;
    CLOSED CONSTANT text := 'This instance is not taking new accounts.';
    INVITE_ONLY CONSTANT text := 'This instance takes new accounts by invitation only. Ask its admin for one.';
    OTHER_DOMAIN CONSTANT text := 'New accounts through this sign-in are limited to some email domains, and this address is not at one of them.';
    UNVERIFIED CONSTANT text := 'New accounts through this sign-in need an email address the sign-in provider has verified.';
BEGIN
    SELECT lower(btrim(ic.config_value #>> '{}')) INTO v_policy
      FROM public.instance_config ic
     WHERE ic.config_key = 'registration_policy';

    IF v_provider IN ('email', 'phone') THEN
        IF v_policy IS NULL OR v_policy = 'open' THEN
            RETURN NULL;
        END IF;
        IF v_email IS NOT NULL THEN
            DELETE FROM public.signup_invite_passes p WHERE p.email = v_email AND p.expires_at > now();
            IF FOUND THEN
                RETURN NULL;
            END IF;
        END IF;
        RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403,
            'message', CASE WHEN v_policy = 'invite' THEN INVITE_ONLY ELSE CLOSED END));
    END IF;

    SELECT ic.config_value -> v_provider INTO v_entry
      FROM public.instance_config ic
     WHERE ic.config_key = 'signup_providers' AND jsonb_typeof(ic.config_value) = 'object';
    v_mode := CASE WHEN jsonb_typeof(v_entry) = 'object' THEN lower(btrim(v_entry ->> 'mode')) END;

    IF v_mode = 'open' THEN
        RETURN NULL;
    END IF;

    IF v_mode = 'domains' THEN
        IF v_email IS NULL OR coalesce(event #>> '{user,user_metadata,email_verified}', '') <> 'true' THEN
            RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', UNVERIFIED));
        END IF;
        v_domain := substring(v_email from '@([^@]+)$');
        IF EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(v_entry -> 'domains') = 'array' THEN v_entry -> 'domains' ELSE '[]'::jsonb END) AS d(raw)
             CROSS JOIN LATERAL (SELECT lower(btrim(ltrim(btrim(d.raw), '@'))) AS name) n
             WHERE n.name <> ''
               AND (v_domain = n.name OR right(v_domain, char_length(n.name) + 1) = '.' || n.name))
        THEN
            RETURN NULL;
        END IF;
        RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', OTHER_DOMAIN));
    END IF;

    IF v_policy IS NULL OR v_policy = 'open' THEN
        RETURN NULL;
    END IF;
    RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403,
        'message', CASE WHEN v_policy = 'invite' THEN INVITE_ONLY ELSE CLOSED END));
END;
$$;

REVOKE ALL ON FUNCTION public.signup_registration_refusal(jsonb) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.before_user_created_hook(jsonb) RENAME TO signup_limits_check;
REVOKE ALL ON FUNCTION public.signup_limits_check(jsonb) FROM PUBLIC, anon, authenticated, service_role;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        REVOKE ALL ON FUNCTION public.signup_limits_check(jsonb) FROM supabase_auth_admin;
    END IF;
END;
$$;

-- GoTrue's before-user-created hook (GOTRUE_HOOK_BEFORE_USER_CREATED_URI). The registration policy
-- refuses on its own failure; the limits allow on theirs (signup_limits_check).
CREATE FUNCTION public.before_user_created_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_refusal jsonb;
BEGIN
    BEGIN
        v_refusal := public.signup_registration_refusal(event);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'before_user_created_hook: registration: %', SQLERRM;
        RETURN jsonb_build_object('error', jsonb_build_object('http_code', 503,
            'message', 'Sign-up is unavailable right now. Try again later.'));
    END;
    IF v_refusal IS NOT NULL THEN
        RETURN v_refusal;
    END IF;
    RETURN public.signup_limits_check(event);
END;
$$;

REVOKE ALL ON FUNCTION public.before_user_created_hook(jsonb) FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        GRANT EXECUTE ON FUNCTION public.before_user_created_hook(jsonb) TO supabase_auth_admin;
    END IF;
END;
$$;

COMMIT;
