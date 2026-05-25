BEGIN;

-- ============================================================================
-- Step 1c: Replace unfiltered CDC on emojis table with server-scoped broadcast.
--
-- The old approach sent every emoji change on the platform to every connected
-- client.  The new trigger broadcasts only to the relevant server channel.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcast_emoji_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
  ELSE
    v_server := NEW.server_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',      'emoji:' || lower(TG_OP),
      'new',       CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old',       CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'presence_event',
    'server-presence:' || v_server::text
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_emoji_change ON emojis;
CREATE TRIGGER trg_broadcast_emoji_change
  AFTER INSERT OR UPDATE OR DELETE ON emojis
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_emoji_change();

COMMIT;
