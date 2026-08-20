-- init/ declares auth_user_id UNIQUE. Production carries only
-- idx_profiles_auth_user_id_unique, a plain btree despite the name, and no constraint.
--
-- get_current_profile_id() selects by auth_user_id with LIMIT 1 and no ORDER BY, and is
-- the identity most RLS policies resolve through, so duplicates would resolve to
-- whichever row the planner returned first. UNIQUE still permits many NULLs, which is
-- what remote profiles carry. Named as in init/ so a converged instance and a fresh
-- build agree.
--
-- ADD CONSTRAINT builds the index under ACCESS EXCLUSIVE on public.profiles. Running
-- this beforehand avoids the lock and makes the block below a no-op:
--
--   CREATE UNIQUE INDEX CONCURRENTLY profiles_auth_user_id_key
--       ON public.profiles (auth_user_id);
--   ALTER TABLE public.profiles
--       ADD CONSTRAINT profiles_auth_user_id_key UNIQUE USING INDEX profiles_auth_user_id_key;

BEGIN;

DO $$
DECLARE
    dupes bigint;
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.profiles'::regclass
           AND conname = 'profiles_auth_user_id_key'
    ) THEN
        RAISE NOTICE 'profiles_auth_user_id_key already present';
        RETURN;
    END IF;

    SELECT count(*) INTO dupes FROM (
        SELECT auth_user_id FROM public.profiles
         WHERE auth_user_id IS NOT NULL
         GROUP BY auth_user_id HAVING count(*) > 1
    ) d;

    IF dupes > 0 THEN
        RAISE EXCEPTION
            'cannot add profiles_auth_user_id_key: % auth_user_id value(s) appear on more than one profile. Resolve them first; each duplicate is a profile that get_current_profile_id() may resolve to for the wrong session.', dupes;
    END IF;

    ALTER TABLE public.profiles
        ADD CONSTRAINT profiles_auth_user_id_key UNIQUE (auth_user_id);
    RAISE NOTICE 'profiles_auth_user_id_key added';
END
$$;

COMMIT;
