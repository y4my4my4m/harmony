BEGIN;

-- General-purpose server settings broadcast via the server-structure topic.
-- Reuses the same pattern as channels/categories (server_event on
-- server-structure:{server_id}) so the frontend subscription picks it up
-- without a separate per-user loop.

CREATE OR REPLACE FUNCTION public.broadcast_server_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'settings:' || lower(TG_OP),
      'table', TG_TABLE_NAME,
      'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || NEW.server_id::text
  );
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Drop old narrow trigger name and create the general one
DROP TRIGGER IF EXISTS trg_broadcast_encryption_settings ON public.server_encryption_settings;
DROP TRIGGER IF EXISTS trg_broadcast_server_settings ON public.server_encryption_settings;
CREATE TRIGGER trg_broadcast_server_settings
    AFTER INSERT OR UPDATE ON public.server_encryption_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_server_settings_change();

NOTIFY pgrst, 'reload schema';

COMMIT;
