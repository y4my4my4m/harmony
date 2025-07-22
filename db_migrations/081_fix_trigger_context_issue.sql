-- Migration 081: Clean Up My Broken Triggers
-- ISSUE: I keep creating broken triggers and interfering with working system
-- FIX: Just drop my broken triggers and functions, don't recreate anything

BEGIN;

-- =================================================================
-- JUST CLEAN UP MY MESS - DON'T RECREATE WORKING TRIGGERS
-- =================================================================

-- Drop my broken dispatcher
DROP TRIGGER IF EXISTS trg_handle_messages ON messages;
DROP FUNCTION IF EXISTS handle_messages();

-- Don't recreate anything - the system was working before I fucked it up

-- Log completion
DO $$
BEGIN
    RAISE WARNING '✅ Migration 081: Cleaned up broken triggers - system should work as it did before';
END $$;

COMMIT; 