BEGIN;

-- Fix: prevent_protected_role_deletion trigger was blocking server deletion.
-- When a server is deleted, CASCADE removes its roles, but the trigger raised
-- an exception for @everyone / Admin roles. Now we check if the parent server
-- still exists - if not, it's a cascade delete and we allow it.

CREATE OR REPLACE FUNCTION public.prevent_protected_role_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM servers WHERE id = OLD.server_id) THEN
        RETURN OLD;
    END IF;

    IF OLD.is_admin = true THEN
        RAISE EXCEPTION 'Cannot delete the Admin role. This role is protected.';
    END IF;

    IF OLD.is_default = true THEN
        RAISE EXCEPTION 'Cannot delete the @everyone role. This role is protected.';
    END IF;

    RETURN OLD;
END;
$$;

COMMIT;
