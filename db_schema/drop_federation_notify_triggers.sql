-- ============================================
-- Drop Federation NOTIFY Triggers
-- ============================================
-- Cleanup the PostgreSQL NOTIFY triggers that were added by mistake
-- ============================================

DROP TRIGGER IF EXISTS notify_post_created ON posts;
DROP TRIGGER IF EXISTS notify_follow_created ON follows;
DROP TRIGGER IF EXISTS notify_reaction_created ON post_interactions;

-- Verify cleanup
SELECT 
  trigger_name, 
  event_object_table, 
  action_statement
FROM information_schema.triggers 
WHERE trigger_name LIKE 'notify_%'
ORDER BY trigger_name;

-- Should return 0 rows after cleanup

