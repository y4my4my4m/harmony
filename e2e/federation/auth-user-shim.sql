-- /auth/v1/user for the federation round trip. GoTrue is absent; gateway.conf
-- routes that path to PostgREST's /rpc/hmfed_auth_user, so PostgREST verifies
-- the bearer JWT and this function answers with its subject. supabase-js
-- getUser(jwt) reads `id` from the body.
--
-- Loaded by stack.sh after the schema, as supabase_admin: auth.users belongs
-- to the auth schema's owner.

CREATE OR REPLACE FUNCTION public.hmfed_auth_user()
RETURNS json
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'token names no user' USING ERRCODE = '42501';
    END IF;
    RETURN json_build_object('id', auth.uid(), 'aud', 'authenticated', 'role', 'authenticated');
END;
$$;

REVOKE ALL ON FUNCTION public.hmfed_auth_user() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hmfed_auth_user() TO authenticated;

-- Auth users behind roundtrip.ts's local profiles (ALICE_AUTH, BOB_AUTH, CAROL_AUTH).
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('fed0a000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fx_alice@hmfed.test'),
  ('fed0a000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fx_bob@hmfed.test'),
  ('fed0a000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fx_carol@hmfed.test')
ON CONFLICT (id) DO NOTHING;
