-- =============================================================================
-- Harmony Database Schema - Extensions
-- =============================================================================
-- Run this file first. Some extensions may need to be enabled via Dashboard.
-- =============================================================================

-- UUID generation (usually pre-enabled in Supabase)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;

-- Cryptographic functions for password hashing, key generation
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

-- Full-text search with trigram matching
CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;

-- HTTP requests from database (for webhooks) - may need Dashboard enable
-- This is optional but enables link preview webhooks
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'pg_net extension not available - link preview webhooks will be disabled';
END $$;

-- pgsodium for encryption (usually pre-installed in Supabase)
-- CREATE EXTENSION IF NOT EXISTS pgsodium;

-- Confirm extensions are loaded
DO $$
BEGIN
    RAISE NOTICE 'Extensions loaded successfully';
END $$;

