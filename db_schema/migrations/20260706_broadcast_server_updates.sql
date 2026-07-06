-- Broadcast servers-row updates (icon, name, banner, flags) over the existing
-- per-server realtime channel so members see changes without a refresh.
-- Mirrors broadcast_channel_change() from 20260322_broadcast_server_structure.sql.
-- Frontend handles the 'server:update' type in subscribeToServerStructure().

CREATE OR REPLACE FUNCTION public.broadcast_server_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'server:update',
      'new',  to_jsonb(NEW),
      'old',  to_jsonb(OLD)
    ),
    'server_event',
    'server-structure:' || NEW.id::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_server_change ON servers;
CREATE TRIGGER trg_broadcast_server_change
  AFTER UPDATE ON servers
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_server_change();
