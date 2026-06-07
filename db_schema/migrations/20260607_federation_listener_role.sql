BEGIN;

-- =============================================================================
-- Dedicated least-privilege role for the federation LISTEN/NOTIFY bridge
-- =============================================================================
-- The federation worker keeps ONE long-lived Postgres connection open purely
-- to `LISTEN federation_jobs` (see NotificationListener.ts). Historically the
-- self-hosted compose pointed that connection at `supabase_admin` (the
-- Postgres superuser) via a hand-written DATABASE_URL. That is both
-- over-privileged and an error-prone second credential.
--
-- LISTEN requires *no* table privileges and *no* superuser rights - only the
-- ability to log in and connect. This role grants exactly that and nothing
-- more. configure.sh sets its password and writes the matching connection
-- string into the federation backend env, so operators never hand-craft a
-- superuser DATABASE_URL again.
--
-- Idempotent: safe to run repeatedly. The password is intentionally NOT set
-- here (secrets never live in version-controlled SQL) - configure.sh runs
-- `ALTER ROLE harmony_listener PASSWORD '...'` with a generated secret.
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harmony_listener') THEN
        -- LOGIN so the worker can connect; NOSUPERUSER/NOCREATEDB/NOCREATEROLE
        -- and no INHERIT keep it strictly minimal.
        CREATE ROLE harmony_listener WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF;
END
$$;

-- CONNECT is the only privilege LISTEN needs. (Granting on the current
-- database; on stock Supabase that is `postgres`.)
GRANT CONNECT ON DATABASE postgres TO harmony_listener;

COMMENT ON ROLE harmony_listener IS
    'Least-privilege role used only by the Harmony federation worker to LISTEN on the federation_jobs channel. No table access. Password managed by configure.sh.';

COMMIT;
