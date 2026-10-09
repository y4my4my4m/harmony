-- server_settings.system_channel_id names a channel of the same server, or is NULL.
--
-- The column carried no foreign key. Deleting the system channel left its id behind, and
-- every member join, leave, kick and ban then failed: handle_member_join_system_message,
-- handle_member_leave_system_message, kick_server_member and ban_server_member insert their
-- system message into that id, and messages_channel_id_fkey (23503) aborts the whole
-- statement. Production had one such row on 2026-10-09.
--
--   rows naming a missing channel or another server's channel  -> NULL (get_default_channel)
--   server_settings_system_channel_id_fkey                      ON DELETE SET NULL, as
--                                                               server_automod_settings.alert_channel_id
--   server_settings_system_channel_check                        BEFORE INSERT/UPDATE: the channel
--                                                               belongs to server_settings.server_id;
--                                                               the readers are SECURITY DEFINER and
--                                                               would otherwise post into any channel
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

UPDATE public.server_settings ss
   SET system_channel_id = NULL
 WHERE ss.system_channel_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.channels c
                    WHERE c.id = ss.system_channel_id AND c.server_id = ss.server_id);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.server_settings'::regclass
                      AND conname = 'server_settings_system_channel_id_fkey') THEN
        ALTER TABLE public.server_settings
            ADD CONSTRAINT server_settings_system_channel_id_fkey
            FOREIGN KEY (system_channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.server_settings_system_channel_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.system_channel_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.channels c
         WHERE c.id = NEW.system_channel_id AND c.server_id = NEW.server_id) THEN
        RAISE EXCEPTION 'Channel % is not a channel of this server', NEW.system_channel_id
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.server_settings_system_channel_check() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS server_settings_system_channel_check ON public.server_settings;
CREATE TRIGGER server_settings_system_channel_check
    BEFORE INSERT OR UPDATE OF server_id, system_channel_id ON public.server_settings
    FOR EACH ROW EXECUTE FUNCTION public.server_settings_system_channel_check();

COMMIT;
