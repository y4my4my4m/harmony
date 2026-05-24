-- ---------------------------------------------------------------------------
-- Drop legacy permissive RLS policies on `public.invites` if they still exist
-- in deployed environments.
--
-- Context: `latest_dev_backup.sql` showed two `FIXME:` policies that allowed
-- ANY authenticated user to INSERT/UPDATE any invite. The newer
-- 20260311_invites_rls.sql added restrictive policies but did not drop these
-- legacy ones, so depending on rollout order they could still co-exist and
-- the union of policies leaves the permissive ones in effect.
--
-- This migration is idempotent - DROP POLICY IF EXISTS is a no-op when the
-- policy is already absent.
-- ---------------------------------------------------------------------------
BEGIN;

DROP POLICY IF EXISTS "FIXME: Enable insert for authenticated users only" ON public.invites;
DROP POLICY IF EXISTS "FIXME: update" ON public.invites;

-- Also drop any policies introduced by the archives/fix_invites_and_server_settings.sql
-- script that may have re-introduced overly broad rules. The 20260311 migration
-- (invites_insert_members / invites_update_creator / invites_delete_creator) is
-- the canonical policy set.
DROP POLICY IF EXISTS "Enable read access for all users" ON public.invites;
DROP POLICY IF EXISTS "Authenticated users can create invites" ON public.invites;
DROP POLICY IF EXISTS "Invite creators can update" ON public.invites;
DROP POLICY IF EXISTS "Invite creators can delete" ON public.invites;
DROP POLICY IF EXISTS "invites_select_all" ON public.invites;

-- Restate a safe SELECT policy: anyone (incl. unauthenticated) can read an
-- invite by code so the join flow works. This mirrors the original intent of
-- the legacy "Enable read access for all users" policy without granting any
-- mutation permission.
DROP POLICY IF EXISTS "invites_select_public" ON public.invites;
CREATE POLICY "invites_select_public" ON public.invites
    FOR SELECT
    USING (true);

NOTIFY pgrst, 'reload schema';

COMMIT;
