-- =============================================================================
-- Harmony Database Schema - Custom Types
-- =============================================================================
-- Custom enums and types used throughout the schema
-- =============================================================================

-- No custom types needed - using text constraints instead for flexibility
-- This file is a placeholder for future type definitions

-- Note: The schema uses CHECK constraints on text fields rather than ENUMs
-- for easier modification without migrations. Examples:
--
-- federation_status: CHECK (federation_status IN ('pending', 'queued', 'processing', 'completed', 'failed', 'skipped'))
-- visibility: CHECK (visibility IN ('public', 'unlisted', 'private', 'direct'))
-- follow status: CHECK (status IN ('pending', 'accepted', 'rejected'))

DO $$
BEGIN
    RAISE NOTICE 'Types defined successfully';
END $$;

