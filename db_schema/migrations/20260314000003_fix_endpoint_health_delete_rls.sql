BEGIN;

-- The previous migration added GRANT DELETE but no RLS policy for authenticated users.
-- Production only has a FOR SELECT policy ("Authenticated users can read endpoint health")
-- and a service_role policy. Without a DELETE-allowing RLS policy, DELETE silently returns 0 rows.

DROP POLICY IF EXISTS "Admins can delete dead endpoints" ON public.federation_endpoint_health;
CREATE POLICY "Admins can delete dead endpoints" ON public.federation_endpoint_health
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = public.get_current_profile_id()
            AND is_admin = true
        )
    );

NOTIFY pgrst, 'reload schema';

COMMIT;
