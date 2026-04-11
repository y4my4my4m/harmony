-- =============================================================================
-- Harmony Database Schema - Extensions
-- =============================================================================
-- Run this file first. Some extensions may need to be enabled via Dashboard.
--
-- SCHEMA RULES:
--   pg_cron       -> pg_catalog  (required by the extension itself)
--   pg_graphql    -> graphql     (has its own schema)
--   supabase_vault -> vault      (has its own schema)
--   everything else -> extensions (Supabase convention)
--
-- =============================================================================

-- Ensure the extensions schema exists (pre-created by Supabase, but not in vanilla PG)
CREATE SCHEMA IF NOT EXISTS extensions;

-- UUID generation (usually pre-enabled in Supabase)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- Cryptographic functions for password hashing, key generation
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Full-text search with trigram matching
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- pg_stat_statements for query performance monitoring
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'pg_stat_statements not available - query monitoring will be limited';
END $$;

-- HTTP requests from database (for webhooks, link previews)
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'pg_net not available - link preview webhooks will be disabled';
END $$;

-- pg_cron for scheduled tasks (MUST be in pg_catalog)
-- May need to be enabled via Supabase Dashboard first on hosted instances
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'pg_cron not available - scheduled cleanup jobs will not run in-database';
END $$;

-- moddatetime for automatic updated_at columns
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS moddatetime WITH SCHEMA extensions;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'moddatetime not available - using trigger-based updated_at instead';
END $$;

-- pgjwt for JWT token generation (used by LiveKit token generation)
-- Installed separately in 95_livekit_tokens.sql since it depends on pgcrypto

-- pgsodium for encryption (usually pre-installed in Supabase)
-- CREATE EXTENSION IF NOT EXISTS pgsodium;

-- Confirm extensions are loaded
DO $$
DECLARE
    ext_count integer;
BEGIN
    SELECT COUNT(*) INTO ext_count
    FROM pg_extension
    WHERE extname IN ('uuid-ossp', 'pgcrypto', 'pg_trgm');

    RAISE NOTICE 'Extensions loaded: % core extensions verified', ext_count;
END $$;

