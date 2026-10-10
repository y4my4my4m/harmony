-- Channel and category writes for channel managers.
--
-- channels INSERT/UPDATE/DELETE and channel_categories INSERT/DELETE admitted the server owner
-- only. A member holding MANAGE_CHANNELS (an Admin role, for one) could not create, rename,
-- move or delete a channel, or create or delete a category: a refused DELETE matches no row
-- and reports success, so the client removed the row and the next load brought it back.
-- create_channel runs as the caller and hit the same INSERT policy.
--
-- Each now admits the owner, a holder of MANAGE_CHANNELS (on that channel, for an existing
-- channel) or an instance admin, as channel_categories_update_manager already did.
--
-- Converges by state: other policies for these commands are dropped, rerunning changes nothing.

BEGIN;

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.tablename, p.policyname
          FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND ((p.tablename = 'channels' AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE'))
             OR (p.tablename = 'channel_categories' AND p.cmd IN ('INSERT', 'DELETE')))
           AND p.policyname NOT IN ('channels_insert_manager', 'channels_update_manager',
                                    'channels_delete_manager', 'channel_categories_insert_manager',
                                    'channel_categories_delete_manager')
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
        RAISE NOTICE 'dropped policy % on %', r.policyname, r.tablename;
    END LOOP;
END;
$$;

DROP POLICY IF EXISTS channels_insert_manager ON public.channels;
CREATE POLICY channels_insert_manager ON public.channels FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM public.servers s
                         WHERE s.id = channels.server_id
                           AND s.owner = (SELECT public.get_current_profile_id()))
                OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'MANAGE_CHANNELS')
                OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS channels_update_manager ON public.channels;
CREATE POLICY channels_update_manager ON public.channels FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = channels.server_id
                      AND s.owner = (SELECT public.get_current_profile_id()))
           OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'MANAGE_CHANNELS', id)
           OR (SELECT public.is_current_user_admin()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.servers s
                         WHERE s.id = channels.server_id
                           AND s.owner = (SELECT public.get_current_profile_id()))
                OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'MANAGE_CHANNELS', id)
                OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS channels_delete_manager ON public.channels;
CREATE POLICY channels_delete_manager ON public.channels FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = channels.server_id
                      AND s.owner = (SELECT public.get_current_profile_id()))
           OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'MANAGE_CHANNELS', id)
           OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS channel_categories_insert_manager ON public.channel_categories;
CREATE POLICY channel_categories_insert_manager ON public.channel_categories FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM public.servers s
                         WHERE s.id = channel_categories.server_id
                           AND s.owner = (SELECT public.get_current_profile_id()))
                OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'MANAGE_CHANNELS')
                OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS channel_categories_delete_manager ON public.channel_categories;
CREATE POLICY channel_categories_delete_manager ON public.channel_categories FOR DELETE TO authenticated
    USING (EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = channel_categories.server_id
                      AND s.owner = (SELECT public.get_current_profile_id()))
           OR public.has_permission((SELECT public.get_current_profile_id()), server_id, 'MANAGE_CHANNELS')
           OR (SELECT public.is_current_user_admin()));

COMMIT;
