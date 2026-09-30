-- An unnamed server folder stores ''.
--
-- server_folders.name is NOT NULL and the client creates folders with name ''. The table's
-- sanitize_entity_name('64', 'optional') trigger rewrote a blank name to NULL, so every
-- unnamed folder insert, including drag-a-server-onto-a-server, failed with a not-null
-- violation.
--
-- sanitize_entity_name() modes, TG_ARGV[1]:
--   required   a blank name raises on insert, and on update when the old name was not blank
--   blank      a blank name is stored as ''
--   (other)    a blank name is stored as NULL

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.sanitize_entity_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_max int := COALESCE(NULLIF(TG_ARGV[0], '')::int, 100);
    v_mode text := TG_ARGV[1];
    v_clean text;
BEGIN
    v_clean := public.sanitize_profile_string(NEW.name, v_max, false);

    IF COALESCE(v_clean, '') = '' THEN
        IF v_mode = 'required' THEN
            IF TG_OP = 'INSERT' OR COALESCE(OLD.name, '') <> '' THEN
                RAISE EXCEPTION '% name must not be blank', TG_TABLE_NAME
                    USING ERRCODE = 'check_violation';
            END IF;
            NEW.name := COALESCE(v_clean, '');
        ELSIF v_mode = 'blank' THEN
            NEW.name := '';
        ELSE
            NEW.name := NULLIF(v_clean, '');
        END IF;
    ELSE
        NEW.name := v_clean;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sanitize_server_folder_name_trigger ON public.server_folders;
CREATE TRIGGER sanitize_server_folder_name_trigger
    BEFORE INSERT OR UPDATE ON public.server_folders
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('64', 'blank');

COMMIT;
