-- A channel permission override stays with its role or member.
--
-- guard_override_grants (20261010500001) refuses an allowed bit the caller lacks on the channel,
-- counting the row's previous allow as already granted. An UPDATE that changed role_id, user_id or
-- target_type moved that allow onto another target unchecked: a MANAGE_ROLES or MANAGE_CHANNELS
-- holder could repoint a row the owner made for a moderator role at their own role or user id and
-- gain its bits. Discord keys an overwrite by its target.
--
-- guard_override_grants, on writes of the client roles:
--   UPDATE   channel_id, target_type, role_id and user_id are fixed, the owner's writes included.
--            Retargeting is DELETE plus INSERT, where the INSERT checks the whole allow mask.
--            42501 'an override stays with its target'.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.guard_override_grants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.channel_id IS DISTINCT FROM OLD.channel_id THEN
            RAISE EXCEPTION 'an override stays on its channel' USING ERRCODE = '42501';
        END IF;
        IF (NEW.target_type, NEW.role_id, NEW.user_id) IS DISTINCT FROM (OLD.target_type, OLD.role_id, OLD.user_id) THEN
            RAISE EXCEPTION 'an override stays with its target' USING ERRCODE = '42501';
        END IF;
    END IF;
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = NEW.channel_id;
    IF public.caller_outranks_all(v_server) THEN
        RETURN NEW;
    END IF;
    PERFORM public.assert_grantable_bits(
        public.get_user_permissions(public.get_current_profile_id(), v_server, NEW.channel_id),
        COALESCE(NEW.allow_permissions, 0)
          & ~(CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.allow_permissions, 0) ELSE 0 END));
    RETURN NEW;
END;
$$;

-- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE; DROP TRIGGER would take ACCESS EXCLUSIVE and
-- stop get_user_permissions, which reads this table on every permission check.
CREATE OR REPLACE TRIGGER a_channel_overrides_grant_guard
    BEFORE INSERT OR UPDATE ON public.channel_permission_overrides
    FOR EACH ROW EXECUTE FUNCTION public.guard_override_grants();

REVOKE ALL ON FUNCTION public.guard_override_grants() FROM PUBLIC, anon, authenticated;

COMMIT;
