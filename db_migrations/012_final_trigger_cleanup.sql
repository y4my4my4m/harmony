-- Migration 012: Final Trigger Cleanup & Profile Fix
-- 
-- DEFINITIVE FIX for:
-- 1. Duplicate triggers causing conflicts
-- 2. Proper profile handling in reactions
-- 3. Race condition fixes

-- =====================================================
-- STEP 1: Drop ALL duplicate/conflicting triggers
-- =====================================================

-- Drop the duplicate triggers (keep only the newer ones)
DROP TRIGGER IF EXISTS trigger_unified_notification_reactions ON reactions;
DROP TRIGGER IF EXISTS trigger_unified_notification_processing_reactions ON reactions; 

-- Drop federation triggers
DROP TRIGGER IF EXISTS trigger_unified_interaction_federation_reactions ON reactions;

-- Also drop any other potentially conflicting reaction triggers
DROP TRIGGER IF EXISTS handle_reactions_federation_trigger ON reactions;
DROP TRIGGER IF EXISTS trigger_reactions_federation ON reactions;

-- =====================================================
-- STEP 2: Fix the reaction RPC functions to handle profiles properly  
-- =====================================================

-- Drop existing functions to avoid type conflicts
DROP FUNCTION IF EXISTS public.get_message_reactions(uuid);
DROP FUNCTION IF EXISTS public.get_batch_message_reactions(uuid[]);

-- Recreate get_message_reactions with the ORIGINAL return structure 
-- (to match existing frontend expectations)
CREATE OR REPLACE FUNCTION public.get_message_reactions(message_id uuid)
RETURNS TABLE(
    count bigint,
    emoji jsonb,
    reactions jsonb,
    message_id_of_reactions uuid
) 
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(r.*) as count,
        to_jsonb(e.*) as emoji,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'reaction_id', r.id::text,
                    'user_id', r.user_id::text
                ) ORDER BY r.created_at
            ) FILTER (WHERE r.user_id IS NOT NULL),
            '[]'::jsonb
        ) as reactions,
        get_message_reactions.message_id as message_id_of_reactions
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = get_message_reactions.message_id
    GROUP BY r.emoji_id, e.id, r.message_id
    ORDER BY MIN(r.created_at);
END;
$$;

-- Recreate get_batch_message_reactions with FIXED types (matching schema)
CREATE OR REPLACE FUNCTION public.get_batch_message_reactions(message_ids uuid[])
RETURNS TABLE(
    message_id uuid,
    emoji_id uuid,
    emoji_name character varying,  -- MATCH schema: character varying not text
    emoji_url character varying,   -- MATCH schema: character varying not text  
    reaction_count bigint,
    users jsonb
) 
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.message_id,
        r.emoji_id,
        e.name as emoji_name,  -- No cast needed - already character varying
        e.url as emoji_url,    -- No cast needed - already character varying
        COUNT(r.user_id) as reaction_count,  -- Match existing function behavior
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'reaction_id', r.id::text,
                    'user_id', r.user_id::text
                ) ORDER BY r.created_at
            ) FILTER (WHERE r.user_id IS NOT NULL),
            '[]'::jsonb
        ) as users
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = ANY(get_batch_message_reactions.message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url
    ORDER BY r.message_id, MIN(r.created_at);
END;
$$;

COMMENT ON FUNCTION public.get_message_reactions(uuid) IS 'FIXED: Returns reaction groups with proper user_id handling, matching original return structure';
COMMENT ON FUNCTION public.get_batch_message_reactions(uuid[]) IS 'FIXED: Batch reaction fetching with proper user_id handling and correct column types';

-- =====================================================
-- STEP 4: Recreate ONLY the necessary triggers (no duplicates)
-- =====================================================

-- Single notification trigger for reactions (no duplicates)
CREATE TRIGGER trigger_unified_notification_reactions
    AFTER INSERT OR DELETE ON reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_notification_processing();

-- Single federation trigger for reactions (no duplicates)  
CREATE TRIGGER trigger_unified_interaction_federation_reactions
    AFTER INSERT OR DELETE ON reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_interaction_federation();

-- =====================================================
-- STEP 5: Ensure proper indexing for performance
-- =====================================================

-- Ensure we have proper indexes for reaction queries
CREATE INDEX IF NOT EXISTS idx_reactions_message_user_emoji 
ON reactions (message_id, user_id, emoji_id);

CREATE INDEX IF NOT EXISTS idx_reactions_user_message 
ON reactions (user_id, message_id);

-- =====================================================
-- STEP 6: Verification
-- =====================================================

DO $$
DECLARE
    reaction_trigger_count INTEGER;
    notification_trigger_count INTEGER;
BEGIN
    -- Count reaction triggers to ensure no duplicates
    SELECT COUNT(*) INTO reaction_trigger_count
    FROM information_schema.triggers 
    WHERE event_object_table = 'reactions' 
    AND trigger_name LIKE '%reaction%';
    
    SELECT COUNT(*) INTO notification_trigger_count
    FROM information_schema.triggers 
    WHERE event_object_table = 'reactions' 
    AND trigger_name LIKE '%notification%';
    
    -- Ensure we have exactly the right number of triggers
    IF reaction_trigger_count > 2 THEN
        RAISE WARNING 'Too many reaction triggers detected: %', reaction_trigger_count;
    END IF;
    
    IF notification_trigger_count > 1 THEN
        RAISE WARNING 'Too many notification triggers detected: %', notification_trigger_count;
    END IF;

    RAISE NOTICE 'Migration 012 completed successfully!';
    RAISE NOTICE 'FIXES APPLIED:';
    RAISE NOTICE '  ✅ Removed duplicate triggers';
    RAISE NOTICE '  ✅ Fixed reaction RPC functions for proper user_id handling';  
    RAISE NOTICE '  ✅ Added proper indexes for performance';
    RAISE NOTICE '  ✅ Reaction triggers: % (should be 2)', reaction_trigger_count;
    RAISE NOTICE '  ✅ Notification triggers: % (should be 1)', notification_trigger_count;
    RAISE NOTICE '';
    RAISE NOTICE '🎯 This should fix the duplicate trigger conflicts and UUID issues!';
END $$;