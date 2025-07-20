-- DEBUG QUERIES: Federation Issue After Migration 031
-- Run these queries to debug why posts aren't federating

-- 1. CHECK: Does the posts federation trigger exist?
SELECT tgname, tgtype, tgenabled 
FROM pg_trigger t 
JOIN pg_class c ON t.tgrelid = c.oid 
WHERE c.relname = 'posts' AND tgname = 'trigger_unified_content_federation';
-- Expected: 1 row with tgenabled = 'O' (enabled)

RESULT: i get "Success. No rows returned" so i dont know if it worked or not?!

-- 2. CHECK: Does the federation function exist and contain queue calls?
SELECT proname, 
       CASE WHEN prosrc LIKE '%queue_activity_for_federation%' THEN 'HAS_QUEUE_CALLS' ELSE 'MISSING_QUEUE_CALLS' END as queue_status
FROM pg_proc 
WHERE proname = 'handle_unified_content_federation';
-- Expected: 1 row with queue_status = 'HAS_QUEUE_CALLS'

GOT MISSING_QUEUE_CALLS

-- 3. TEST: Create a test post and check results
-- First, create a test post via frontend, then run:

-- Check if ap_activities entry was created (should happen immediately)
SELECT COUNT(*) as ap_activities_count, MAX(created_at) as latest_activity
FROM ap_activities 
WHERE created_at > NOW() - INTERVAL '1 minute';

-- Check if federation_delivery_queue entry was created (should happen immediately)
SELECT COUNT(*) as queue_count, MAX(created_at) as latest_queue_entry
FROM federation_delivery_queue 
WHERE created_at > NOW() - INTERVAL '1 minute';

RESULT: 0 on both

-- 4. CHECK: Webhook configuration
SELECT name, url, events, created_at, updated_at
FROM supabase_functions.hooks 
WHERE name = 'Federated Outbox';
-- Expected: 1 row with events including 'INSERT' on federation_delivery_queue
RESULT: I DO HAVE A WEBHOOK CONFIGURED

-- 5. DEBUG: Check recent posts and their federation status
SELECT p.id, p.author_id, p.created_at, p.visibility,
       aa.id as activity_id, aa.status as activity_status,
       fdq.id as queue_id, fdq.status as queue_status
FROM posts p
LEFT JOIN ap_activities aa ON aa.object_id = p.id::text AND aa.object_type = 'Note'
LEFT JOIN federation_delivery_queue fdq ON fdq.activity_id = aa.id
WHERE p.created_at > NOW() - INTERVAL '5 minutes'
ORDER BY p.created_at DESC
LIMIT 5;

RESULT:[
  {
    "id": "35b77696-d942-4803-bfc4-6099e10c4704",
    "author_id": "bce63d98-6b14-4c7e-b8d5-8776d2c0ee04",
    "created_at": "2025-07-20 17:45:52.406581+00",
    "visibility": "public",
    "activity_id": null,
    "activity_status": null,
    "queue_id": null,
    "queue_status": null
  }
]

-- 6. DEBUG: Check if user has federation enabled
SELECT username, federation_enabled, is_local, domain
FROM profiles 
WHERE auth_user_id = (SELECT auth.uid());

RESULT: Succes. No rows returned

-- 7. DEBUG: Check instance federation settings
SELECT config_key, config_value
FROM instance_config 
WHERE config_key LIKE '%federation%';

RESUTL: [
  {
    "config_key": "enable_inbound_federation",
    "config_value": true
  },
  {
    "config_key": "enable_outbound_federation",
    "config_value": true
  },
  {
    "config_key": "federation_retry_attempts",
    "config_value": 3
  },
  {
    "config_key": "federation_cron_migration_completed",
    "config_value": true
  },
  {
    "config_key": "federation_settings",
    "config_value": {
      "federation_enabled": true,
      "federation_require_approval": false,
      "federation_auto_accept_follows": true,
      "federation_delivery_timeout_ms": 10000,
      "federation_max_delivery_attempts": 5
    }
  }
]

-- 8. DEBUG: Manual trigger test (if needed)
-- INSERT INTO posts (author_id, content, visibility, is_local) 
-- VALUES (
--   (SELECT id FROM profiles WHERE auth_user_id = auth.uid()),
--   '[{"type":"text","text":"Federation test"}]'::jsonb,
--   'public',
--   true
-- );
-- Then check ap_activities and federation_delivery_queue tables