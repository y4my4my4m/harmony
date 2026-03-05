-- Migration: Fix remote server default channels trigger
-- Date: 2025-12-03
-- Description: Prevents the automatic creation of default channels (general, voice) 
--              when joining a REMOTE federated server. The trigger should only create
--              default channels for LOCAL servers.
--
-- Problem: When a user joins a federated server from another instance, the 
--          trigger_create_default_server_structure() was incorrectly creating
--          local "general" and "voice chat" channels, even though those channels
--          should come from the remote server via federation.
--
-- Solution: Check is_local_server flag before creating default structure.

CREATE OR REPLACE FUNCTION "public"."trigger_create_default_server_structure"() 
RETURNS "trigger"
LANGUAGE "plpgsql" SECURITY DEFINER
AS $$
BEGIN
  -- Only create default channels for LOCAL servers, not remote server references
  -- Remote servers will receive their channels via federation (Add activities)
  IF NEW.is_local_server = true OR NEW.is_local_server IS NULL THEN
    PERFORM public.create_default_server_structure(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

-- Note: This function is called by the trigger on the servers table:
-- CREATE TRIGGER trigger_create_default_server_structure
--   AFTER INSERT ON servers
--   FOR EACH ROW
--   EXECUTE FUNCTION trigger_create_default_server_structure();

