-- Drops public.invites policy `invites_select_all`, which re-opened invite
-- enumeration after it had been closed.
--
-- History:
--   20260520_invites_drop_legacy_fixme_policies.sql      restated a broad
--       SELECT policy as USING (true) so accept-by-code could read invites.
--   20260520_invites_restrict_select_to_owner_and_rpc.sql closed it, in its own
--       words: "That allows ANY caller to SELECT * FROM invites and enumerate
--       every code on the instance (effectively making all invites public)."
--       It dropped the broad policy, restricted SELECT to the invite creator
--       and instance admins, and added lookup_invite_by_code().
--   20260616_rls_resync_from_init.sql                    re-created
--       `invites_select_all ON public.invites FOR SELECT USING (true)`,
--       restoring the enumeration the May migration had removed.
--
-- Effect on a migrated database: RLS is enabled on public.invites, Supabase's
-- default privileges grant the table to anon, and RLS policies are permissive
-- and OR'd together. One policy of USING (true) therefore makes every row
-- readable without authentication -- including `code` and `server_id`, which is
-- sufficient to join any server holding a live invite.
--
-- init/ never carried this policy. A fresh build has only
-- invites_select_creator and invites_select_instance_admin, which is the state
-- the application expects: src/services/inviteService.ts resolves codes through
-- the SECURITY DEFINER RPC and says so --
--
--   "Direct from('invites').select(...) would be blocked by the post-20260520
--    RLS policies (which restrict reads to the invite creator / instance
--    admins); the RPC returns exactly one row by code so it does not enable
--    enumeration."
--
-- The accept and preview paths are unaffected: lookup_invite_by_code is
-- SECURITY DEFINER, exists in both builds, and returns a single row matched by
-- code. The remaining direct table access in inviteService.ts is creator-scoped
-- (insert, select by created_by, update by created_by) and is served by the
-- creator policies.
--
-- Idempotent, and a no-op on any instance that never received the resync.

BEGIN;

DROP POLICY IF EXISTS invites_select_all ON public.invites;

COMMIT;

NOTIFY pgrst, 'reload schema';
