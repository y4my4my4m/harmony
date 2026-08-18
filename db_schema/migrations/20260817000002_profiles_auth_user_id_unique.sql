-- Makes public.profiles.auth_user_id unique, which production never enforced.
--
-- db_schema/init/02_tables_core.sql declares `auth_user_id uuid UNIQUE`, so a fresh
-- build carries profiles_auth_user_id_key. Production has only
-- idx_profiles_auth_user_id_unique, which is a plain btree despite the name, and no
-- constraint on the column at all.
--
-- Why it matters: get_current_profile_id() is
--
--   SELECT id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1
--
-- with no ORDER BY. Two rows sharing an auth_user_id therefore resolve to whichever
-- the planner returns first, and that function is the identity used by most RLS
-- policies. 20260817000001 removed the two policies that let a user write another
-- user's auth_user_id; this removes the possibility of a duplicate existing at all,
-- whatever else is added later.
--
-- Verified against production before writing this: the duplicate check
--
--   SELECT auth_user_id, count(*) FROM public.profiles
--    WHERE auth_user_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
--
-- returns no rows, so the constraint can be added without a data fix. It is added
-- under its init/ name so a converged instance and a fresh build agree.
--
-- NULLs are unaffected: a UNIQUE constraint permits many NULL auth_user_id rows,
-- which is what remote profiles carry.
--
-- LOCK: ADD CONSTRAINT ... UNIQUE builds the index under an ACCESS EXCLUSIVE lock on
-- public.profiles. On a small table that is momentary. To avoid it entirely, build
-- the index first, outside any transaction, and then attach it:
--
--   CREATE UNIQUE INDEX CONCURRENTLY profiles_auth_user_id_key
--       ON public.profiles (auth_user_id);
--   ALTER TABLE public.profiles
--       ADD CONSTRAINT profiles_auth_user_id_key UNIQUE USING INDEX profiles_auth_user_id_key;
--
-- Running that beforehand makes the block below a no-op.

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
