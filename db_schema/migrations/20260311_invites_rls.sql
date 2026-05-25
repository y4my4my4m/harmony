BEGIN;

-- Server members can create invites
DROP POLICY IF EXISTS "invites_insert_members" ON public.invites;
CREATE POLICY "invites_insert_members" ON public.invites FOR INSERT
    WITH CHECK (
        auth.role() = 'authenticated'
        AND EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = invites.server_id
              AND us.user_id = public.get_current_profile_id()
        )
    );

-- Invite creators can update their own invites (mark used, increment uses)
DROP POLICY IF EXISTS "invites_update_creator" ON public.invites;
CREATE POLICY "invites_update_creator" ON public.invites FOR UPDATE
    USING (created_by = public.get_current_profile_id());

-- Invite creators can delete their own invites
DROP POLICY IF EXISTS "invites_delete_creator" ON public.invites;
CREATE POLICY "invites_delete_creator" ON public.invites FOR DELETE
    USING (created_by = public.get_current_profile_id());

NOTIFY pgrst, 'reload schema';

COMMIT;
