-- Test Script: Verify Trigger Field Reference Fix
-- 
-- This script tests that the handle_unified_content_federation() function
-- now correctly handles both posts (author_id) and messages (user_id) tables.
--
-- Run this after applying migration 030 to verify the fix.

BEGIN;

-- Create test data if it doesn't exist
INSERT INTO profiles (id, username, display_name, enable_federation) 
VALUES ('test-user-123', 'testuser', 'Test User', true)
ON CONFLICT (id) DO NOTHING;

-- Test 1: Insert a post (should use NEW.author_id)
INSERT INTO posts (
  id, 
  author_id, 
  content, 
  visibility, 
  created_at
) VALUES (
  'test-post-123',
  'test-user-123',
  '[{"type": "text", "text": "Test post content"}]',
  'public',
  NOW()
);

-- Test 2: Insert a message (should use NEW.user_id)  
INSERT INTO messages (
  id,
  user_id,
  content,
  channel_id,
  created_at
) VALUES (
  'test-message-123',
  'test-user-123', 
  '[{"type": "text", "text": "Test message content"}]',
  'test-channel-123',
  NOW()
);

-- Check that activities were created for both (proving triggers worked)
SELECT 
  'POST TRIGGER SUCCESS' as test_result,
  activity_type,
  object_type,
  object_id,
  status
FROM ap_activities 
WHERE object_id = 'test-post-123'

UNION ALL

SELECT 
  'MESSAGE TRIGGER SUCCESS' as test_result,
  activity_type,
  object_type, 
  object_id,
  status
FROM ap_activities 
WHERE object_id = 'test-message-123';

-- Cleanup test data
DELETE FROM ap_activities WHERE object_id IN ('test-post-123', 'test-message-123');
DELETE FROM posts WHERE id = 'test-post-123';
DELETE FROM messages WHERE id = 'test-message-123';
DELETE FROM profiles WHERE id = 'test-user-123';

ROLLBACK;

-- Expected output:
-- test_result           | activity_type | object_type | object_id        | status
-- POST TRIGGER SUCCESS  | Create        | posts       | test-post-123    | pending
-- MESSAGE TRIGGER SUCCESS | Create      | messages    | test-message-123 | pending
--
-- If you see both rows, the trigger fix is working correctly!