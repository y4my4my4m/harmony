-- ============================================================================
-- Restore the canonical servers-row update broadcast.
--
-- The (deleted) migration 20260706_broadcast_server_updates.sql repointed
-- trg_broadcast_server_change at a new broadcast_server_change() function
-- that sent a 'server:update' event on server-structure:{id} without the
-- private flag. Nothing on the frontend listens for that event, so icon /
-- name / banner changes stopped propagating in realtime (users had to
-- refresh). Deleting the migration file did not undo the trigger swap in
-- environments where it had already been run.
--
-- This restores the canonical path (matches db_schema/init/11_functions_triggers.sql):
--   servers UPDATE -> broadcast_server_change_event()
--     -> realtime.send('server:updated', 'user_event', 'user:{profile_id}', private)
--     -> UserEventChannel -> useServerChannel._handleServerUpdate()
-- which updates servers[] / currentServer, covering the sidebar rail,
-- folders, topbar, notifications, and every other consumer of the store.
-- ============================================================================

BEGIN;

-- Dev/prod DBs created before init/04_tables_servers.sql gained updated_at
-- lack this column. broadcast_server_change_event() references
-- NEW.updated_at, so on those DBs the function raised at runtime and the
-- EXCEPTION handler silently swallowed every broadcast. Align with init.
ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

CREATE OR REPLACE FUNCTION public.broadcast_server_change_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR v_member_id IN
      SELECT user_id FROM user_servers WHERE server_id = NEW.id
    LOOP
      PERFORM realtime.send(
        jsonb_build_object(
          'type', 'server:updated',
          'server', jsonb_build_object(
            'id', NEW.id,
            'name', NEW.name,
            'description', NEW.description,
            'icon', NEW.icon,
            'banner', NEW.banner,
            'public', NEW.public,
            'federation_enabled', NEW.federation_enabled,
            'updated_at', NEW.updated_at
          )
        ),
        'user_event',
        'user:' || v_member_id::text,
        true
      );
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- Repoint the trigger back at the canonical function.
DROP TRIGGER IF EXISTS trg_broadcast_server_change ON public.servers;
CREATE TRIGGER trg_broadcast_server_change
    AFTER UPDATE ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_server_change_event();

-- Remove the orphaned wrong-topic function introduced by the deleted migration.
DROP FUNCTION IF EXISTS public.broadcast_server_change();

NOTIFY pgrst, 'reload schema';

COMMIT;
