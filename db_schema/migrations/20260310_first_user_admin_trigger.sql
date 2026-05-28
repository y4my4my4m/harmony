BEGIN;

-- =============================================================================
-- First user becomes instance admin
-- =============================================================================
-- BEFORE INSERT trigger on profiles: if no local profiles exist yet,
-- the new profile gets is_admin = true automatically.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.promote_first_user_to_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_local = true OR NEW.is_local IS NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.profiles
            WHERE is_local = true AND id != NEW.id
        ) THEN
            NEW.is_admin := true;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.promote_first_user_to_admin() IS 
'Sets is_admin=true on the first local profile created on the instance.';

DROP TRIGGER IF EXISTS promote_first_user_to_admin_trigger ON public.profiles;
CREATE TRIGGER promote_first_user_to_admin_trigger
    BEFORE INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.promote_first_user_to_admin();

NOTIFY pgrst, 'reload schema';

COMMIT;
