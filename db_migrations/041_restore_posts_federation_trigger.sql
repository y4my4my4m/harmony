-- Migration 041: Restore Missing Posts Federation Trigger
-- 
-- ISSUE: Posts federation trigger was dropped in migration 017 and never restored
-- RESULT: DMs work, posts don't federate
-- 
-- SIMPLE FIX: Just restore the trigger using existing function

BEGIN;

-- The function handle_unified_content_federation() already exists and works
-- We just need to restore the trigger that was dropped

CREATE TRIGGER trigger_unified_content_federation 
    AFTER INSERT OR UPDATE ON public.posts 
    FOR EACH ROW 
    EXECUTE FUNCTION public.handle_unified_content_federation();

COMMENT ON TRIGGER trigger_unified_content_federation ON posts IS 
'Restored: Posts federation trigger that was dropped in migration 017 and never restored';

COMMIT;