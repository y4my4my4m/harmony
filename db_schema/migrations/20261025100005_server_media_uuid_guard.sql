-- Instance branding uploads (issue 142). Admin > Config > Branding writes the instance icon and
-- banner under instance/ in server_icons and server_banners. The server owners' INSERT, UPDATE
-- and DELETE policies on those buckets cast the first folder to uuid; permissive policies are
-- ORed, so 'instance'::uuid raised 22P02 ("invalid input syntax for type uuid") before
-- "Instance admins can upload instance branding" (20261001200001) was consulted, and every
-- branding upload failed.
--
-- The cast now applies only to a folder that is a uuid; any other folder gives NULL, which
-- has_permission answers false, and the instance admin policies decide. CASE keeps the cast
-- from being evaluated. Definitions otherwise as 20261001200001 and 20261006500001.
-- 20261025100004 (storage converge) carries the same delete-banners definition.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage.objects absent, server media policies skipped';
        RETURN;
    END IF;

    DROP POLICY IF EXISTS "Server owners can upload server icons" ON storage.objects;
    CREATE POLICY "Server owners can upload server icons" ON storage.objects
        AS PERMISSIVE FOR INSERT TO public
        WITH CHECK ((bucket_id = 'server_icons'::text) AND public.has_permission(public.get_current_profile_id(),
            CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                 THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_SERVER'::text));

    DROP POLICY IF EXISTS "Server owners can update server icons" ON storage.objects;
    CREATE POLICY "Server owners can update server icons" ON storage.objects
        AS PERMISSIVE FOR UPDATE TO public
        USING ((bucket_id = 'server_icons'::text) AND public.has_permission(public.get_current_profile_id(),
            CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                 THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_SERVER'::text));

    DROP POLICY IF EXISTS "Server owners can delete server icons" ON storage.objects;
    CREATE POLICY "Server owners can delete server icons" ON storage.objects
        AS PERMISSIVE FOR DELETE TO public
        USING ((bucket_id = 'server_icons'::text) AND public.has_permission(public.get_current_profile_id(),
            CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                 THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_SERVER'::text));

    DROP POLICY IF EXISTS "Server owners can upload server banners" ON storage.objects;
    CREATE POLICY "Server owners can upload server banners" ON storage.objects
        AS PERMISSIVE FOR INSERT TO public
        WITH CHECK ((bucket_id = 'server_banners'::text) AND public.has_permission(public.get_current_profile_id(),
            CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                 THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_SERVER'::text));

    DROP POLICY IF EXISTS "Server owners can update server banners" ON storage.objects;
    CREATE POLICY "Server owners can update server banners" ON storage.objects
        AS PERMISSIVE FOR UPDATE TO public
        USING ((bucket_id = 'server_banners'::text) AND public.has_permission(public.get_current_profile_id(),
            CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                 THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_SERVER'::text));

    DROP POLICY IF EXISTS "Server owners can delete server banners" ON storage.objects;
    CREATE POLICY "Server owners can delete server banners" ON storage.objects
        AS PERMISSIVE FOR DELETE TO public
        USING ((bucket_id = 'server_banners'::text) AND public.has_permission(public.get_current_profile_id(),
            CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                 THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_SERVER'::text));
END;
$$;

COMMIT;
