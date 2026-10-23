-- Usernames of this instance's accounts: 3-24 characters, a-z, 0-9 and _ (src/utils/usernameRules.ts,
-- self-host/admin.sh valid_username). Onboarding inserts the profile row from the client, so the rule
-- holds in the database too. Checked when a local row is inserted or its username changes; rows
-- written before this migration stand. Remote usernames keep profiles_username_check (any length,
-- either case).

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.guard_local_username()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local IS NOT TRUE OR NEW.username IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.username IS NOT DISTINCT FROM OLD.username
       AND OLD.is_local IS TRUE THEN
        RETURN NEW;
    END IF;
    IF NEW.username !~ '^[a-z0-9_]{3,24}$' THEN
        RAISE EXCEPTION 'Usernames are 3 to 24 characters: lowercase letters, digits and _'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_local_username() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_local_username ON public.profiles;
CREATE TRIGGER guard_local_username
    BEFORE INSERT OR UPDATE OF username, is_local ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_local_username();

COMMIT;
