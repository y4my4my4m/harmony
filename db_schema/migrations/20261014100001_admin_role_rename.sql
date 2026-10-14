-- The Admin role a new server starts with renames like any other role, as roles do in
-- Discord; @everyone keeps its name. Both keep their protected flags. Renaming Admin was
-- refused, and the role editor, which offers the name field for every role but @everyone,
-- reported "Failed to save role". Nothing reads the Admin role by name: it is found by
-- is_admin.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

CREATE OR REPLACE FUNCTION public.prevent_protected_role_modification()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF OLD.is_admin = true AND NEW.is_admin = false THEN
        RAISE EXCEPTION 'Cannot remove admin status from the Admin role.';
    END IF;

    IF OLD.is_default = true AND NEW.is_default = false THEN
        RAISE EXCEPTION 'Cannot remove default status from the everyone role.';
    END IF;

    IF OLD.is_default = true AND OLD.name IS DISTINCT FROM NEW.name THEN
        RAISE EXCEPTION 'Cannot rename the everyone role.';
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
