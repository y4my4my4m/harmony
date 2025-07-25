-- Drop the old process_incoming_emoji_reaction function with conflicting signature
-- This must be run before applying emoji_reaction_federation_complete.sql

DROP FUNCTION IF EXISTS public.process_incoming_emoji_reaction(activity_data jsonb, actor_id uuid, target_object_id text);

-- Verify the function has been dropped
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM pg_proc p 
        JOIN pg_namespace n ON p.pronamespace = n.oid 
        WHERE n.nspname = 'public' 
        AND p.proname = 'process_incoming_emoji_reaction'
        AND pg_get_function_arguments(p.oid) = 'activity_data jsonb, actor_id uuid, target_object_id text'
    ) THEN
        RAISE EXCEPTION 'Failed to drop old process_incoming_emoji_reaction function';
    ELSE
        RAISE NOTICE 'Successfully dropped old process_incoming_emoji_reaction function';
    END IF;
END $$;
