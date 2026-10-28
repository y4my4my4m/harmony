-- Reserved local usernames. A new local username is none of the names that read as a mass
-- mention, the instance or its staff (src/utils/usernameRules.ts RESERVED_USERNAMES,
-- self-host/admin.sh reserved_username), compared case-insensitively, and none of the labels of
-- the instance's domain before its last (har.mony.lol: har, mony; localhost: localhost). Checked
-- where 20261027600001 checks the shape: a local row inserted, a local username changed, a row
-- turned local. Rows written before this migration keep their names. Remote usernames are
-- unaffected: `@everyone@other.host` names one account. SECURITY DEFINER: the onboarding insert
-- runs as authenticated, and the domain read does not depend on that role's grants.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.guard_local_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_labels text[];
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
    IF lower(NEW.username) = ANY (ARRAY[
        'everyone', 'here', 'system', 'harmony',
        'admin', 'admins', 'administrator',
        'mod', 'mods', 'moderator', 'moderators',
        'staff', 'root'
    ]) THEN
        RAISE EXCEPTION 'The username % is reserved', NEW.username
            USING ERRCODE = '23514';
    END IF;
    -- Host without port, split into labels; the last label is the top-level domain unless it is
    -- the only one.
    v_labels := string_to_array(lower(split_part(public.get_instance_domain(), ':', 1)), '.');
    IF cardinality(v_labels) > 1 THEN
        v_labels := v_labels[1:cardinality(v_labels) - 1];
    END IF;
    IF lower(NEW.username) = ANY (v_labels) THEN
        RAISE EXCEPTION 'The username % is reserved', NEW.username
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_local_username() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_local_username() TO service_role;

DROP TRIGGER IF EXISTS guard_local_username ON public.profiles;
CREATE TRIGGER guard_local_username
    BEFORE INSERT OR UPDATE OF username, is_local ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_local_username();

COMMIT;
