-- Storage write paths the client uses and no policy admitted.
--
-- server_banners DELETE by MANAGE_SERVER holders. The client writes every new server banner
-- to a new object name and removes the replaced object once servers.banner points at the new
-- one. server_banners carried INSERT and UPDATE policies only, so storage-api's DELETE matched
-- no rows under RLS, reported success, and every replaced banner stayed in the bucket. Mirrors
-- "Server owners can delete server icons" (20261001200001).
--
-- avatars INSERT under bots/<bot id>/ by that bot's owner (UserBotsManagement.vue). The avatars
-- INSERT policy admits only the uploader's own auth uid or profile id folder, so every bot
-- avatar upload failed with "new row violates row-level security policy". The bot id is
-- compared as text: a non-uuid folder segment matches no bot instead of aborting the statement.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage.objects absent, storage policies skipped';
        RETURN;
    END IF;

    DROP POLICY IF EXISTS "Server owners can delete server banners" ON storage.objects;
    CREATE POLICY "Server owners can delete server banners" ON storage.objects
        AS PERMISSIVE FOR DELETE TO public
        USING (((bucket_id = 'server_banners'::text) AND public.has_permission(public.get_current_profile_id(),
            ((storage.foldername(name))[1])::uuid, 'MANAGE_SERVER'::text)));

    DROP POLICY IF EXISTS "Bot owners can upload bot avatars" ON storage.objects;
    CREATE POLICY "Bot owners can upload bot avatars" ON storage.objects
        AS PERMISSIVE FOR INSERT TO authenticated
        WITH CHECK (((bucket_id = 'avatars'::text) AND ((storage.foldername(objects.name))[1] = 'bots'::text)
            AND (EXISTS (SELECT 1 FROM public.bots b
                          WHERE (b.id)::text = (storage.foldername(objects.name))[2]
                            AND b.owner_id = (SELECT public.get_current_profile_id())))));
END;
$$;

COMMIT;
