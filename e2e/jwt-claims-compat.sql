-- Makes auth.uid()/role()/email() read the claim GUC PostgREST actually sets.
--
-- supabase/postgres:15.8.1.060 defines all three against
-- current_setting('request.jwt.claim.<name>'). PostgREST dropped those
-- per-claim GUCs in v12 and sets only request.jwt.claims, a single JSON blob.
-- Left alone, auth.uid() returns NULL under this stack, get_current_profile_id()
-- returns NULL with it, and every RLS policy denies - which reads as a schema
-- fault rather than a GUC mismatch.
--
-- The coalescing definitions below are what current supabase/postgres releases
-- ship; this file only backports them to the pinned image. Applied as
-- supabase_admin, which owns the functions' schema and is superuser here.

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  ), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  ), '')::text;
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  ), '')::text;
$$;
