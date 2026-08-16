-- pgTAP harness.
--
-- pgtap goes in its own schema: installed into public it adds 1074 functions
-- and buries every pg_dump --schema=public diff the drift gate depends on.
-- Its internals call each other unqualified, so `tests` must be on search_path;
-- and the functions are invisible to `authenticated` without USAGE on the
-- schema, which every RLS test needs.
CREATE SCHEMA IF NOT EXISTS tests;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA tests;
GRANT USAGE ON SCHEMA tests TO authenticated, anon;

-- Impersonation. Profiles join on auth_user_id rather than id, so a test
-- supplies the auth user id, not the profile id.
--
-- Both claim forms are set because auth.uid() is not the same function
-- everywhere: supabase/postgres:15.8 defines it as
-- current_setting('request.jwt.claim.sub'), while newer releases parse the
-- request.jwt.claims JSON. Setting one alone silently yields a null uid and
-- every RLS assertion then passes for the wrong reason.
--
-- Transaction-local: each test file runs in a rolled-back transaction, so
-- nothing leaks between files.
CREATE OR REPLACE FUNCTION tests.authenticate_as(p_auth_user_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_auth_user_id::text, true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', p_auth_user_id)::text, true);
  PERFORM set_config('role', 'authenticated', true);
END;
$$;

CREATE OR REPLACE FUNCTION tests.authenticate_as_anon()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('role', 'anon', true);
END;
$$;

CREATE OR REPLACE FUNCTION tests.clear_authentication()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('role', 'postgres', true);
END;
$$;
