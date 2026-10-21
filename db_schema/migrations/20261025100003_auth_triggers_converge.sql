-- The security-notice triggers on GoTrue's tables, created where missing as
-- 20261005400001_account_security.sql defines them:
--   auth.sessions     harmony_session_created (AFTER INSERT), harmony_session_deleted (AFTER DELETE)
--   auth.mfa_factors  harmony_mfa_factor_verified (AFTER UPDATE OF status),
--                     harmony_mfa_factor_deleted (AFTER DELETE)
--
-- Those blocks skip when GoTrue has not created its tables yet. On a self-host install whose
-- auth service migrated while bootstrap.sh applied the chain, the triggers were skipped and the
-- migration recorded as applied: no notice of a new sign-in or of a second factor added or
-- removed. Present triggers are left alone; lock_timeout keeps a busy auth table from stalling.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    v_sessions regclass := to_regclass('auth.sessions');
BEGIN
    IF v_sessions IS NULL THEN
        RAISE NOTICE 'auth.sessions absent, session triggers skipped';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_sessions AND tgname = 'harmony_session_created') THEN
        CREATE TRIGGER harmony_session_created AFTER INSERT ON auth.sessions
            FOR EACH ROW EXECUTE FUNCTION public.on_auth_session_created();
        RAISE NOTICE 'auth.sessions created trigger installed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_sessions AND tgname = 'harmony_session_deleted') THEN
        CREATE TRIGGER harmony_session_deleted AFTER DELETE ON auth.sessions
            FOR EACH ROW EXECUTE FUNCTION public.on_auth_session_deleted();
        RAISE NOTICE 'auth.sessions deleted trigger installed';
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'auth.sessions triggers skipped: %', SQLERRM;
END;
$$;

DO $$
DECLARE
    v_factors regclass := to_regclass('auth.mfa_factors');
BEGIN
    IF v_factors IS NULL THEN
        RAISE NOTICE 'auth.mfa_factors absent, factor triggers skipped';
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_factors AND tgname = 'harmony_mfa_factor_verified') THEN
        CREATE TRIGGER harmony_mfa_factor_verified AFTER UPDATE OF status ON auth.mfa_factors
            FOR EACH ROW EXECUTE FUNCTION public.on_auth_mfa_factor_changed();
        RAISE NOTICE 'auth.mfa_factors verified trigger installed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_factors AND tgname = 'harmony_mfa_factor_deleted') THEN
        CREATE TRIGGER harmony_mfa_factor_deleted AFTER DELETE ON auth.mfa_factors
            FOR EACH ROW EXECUTE FUNCTION public.on_auth_mfa_factor_changed();
        RAISE NOTICE 'auth.mfa_factors deleted trigger installed';
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'auth.mfa_factors triggers skipped: %', SQLERRM;
END;
$$;

COMMIT;
