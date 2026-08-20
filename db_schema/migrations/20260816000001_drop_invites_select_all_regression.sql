-- invites_select_all is USING (true). Policies are permissive and OR'd, and Supabase
-- grants invites to anon, so it exposes every code and server_id on the instance.
-- init/ never carried it; a resync migration reintroduced it.
--
-- Reads by code go through lookup_invite_by_code, which is SECURITY DEFINER and returns
-- one row. The creator-scoped policies serve the rest.

BEGIN;

DROP POLICY IF EXISTS invites_select_all ON public.invites;

COMMIT;

NOTIFY pgrst, 'reload schema';
