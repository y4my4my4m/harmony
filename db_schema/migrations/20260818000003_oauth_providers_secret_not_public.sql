-- Restricts public.oauth_providers to instance admins.
--
-- init/ declared the table with a client_secret column and one policy,
-- FOR SELECT USING (true) with no TO clause, so anon could read every row.
--
-- Nothing leaks today: the table is empty everywhere and unreferenced - the login screen
-- reads providers from instance_config under key 'oauth_providers'. The defect is that
-- filling the table in publishes the secrets.
--
-- Guarded because production does not have the table at all. Replaced rather than dropped:
-- dropping a table is not reversible by re-running a migration.

BEGIN;

DO $$
BEGIN
    IF to_regclass('public.oauth_providers') IS NULL THEN
        RAISE NOTICE 'public.oauth_providers absent, nothing to do';
        RETURN;
    END IF;

    DROP POLICY IF EXISTS "oauth_providers_select_all" ON public.oauth_providers;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policy p
         WHERE p.polrelid = 'public.oauth_providers'::regclass
           AND p.polname = 'oauth_providers_select_admin_only'
    ) THEN
        CREATE POLICY "oauth_providers_select_admin_only" ON public.oauth_providers
            FOR SELECT USING (
                EXISTS (
                    SELECT 1 FROM public.profiles
                    WHERE auth_user_id = ( SELECT auth.uid() )
                    AND is_admin = true
                )
            );
    END IF;

    RAISE NOTICE 'oauth_providers read restricted to instance admins';
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
