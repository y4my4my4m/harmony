# 🚀 Getting Started: Updated Harmony System

## ✅ **What We've Accomplished**

Your Harmony system has been significantly refactored with:
- **87% fewer triggers** (32 → 4 unified handlers)
- **Universal content converters** (2 functions instead of scattered logic)
- **Unified notification system** (1 function handles all notifications)
- **Complete federation infrastructure** (blocking, health monitoring, spam prevention)
- **Local-first design** (everything works without federation)

## 🎯 **Quick Start**

### **Step 1: Apply Database Migrations**
```bash
# Run our automated test (includes migrations)
./test-system.sh

# OR apply manually:
psql $DATABASE_URL -f db_migrations/001_phase1_function_renaming.sql
psql $DATABASE_URL -f db_migrations/002_phase2_unified_notifications.sql
psql $DATABASE_URL -f db_migrations/003_phase3_trigger_consolidation.sql
psql $DATABASE_URL -f db_migrations/005_cleanup_redundancies.sql
```

### **Step 2: Start Development**
```bash
npm run dev
```

### **Step 3: Test Core Functionality**
1. **Create a post** in the social timeline
2. **Send a message** in a server channel
3. **Send a DM** to another user
4. **Add reactions** to messages and posts
5. **Follow a user** (local or federated)

## 🔧 **What Changed & Why It Works Better**

### **Database Functions (Before vs After)**
| **Before** | **After** | **Improvement** |
|------------|-----------|-----------------|
| `parse_activitypub_content_to_jsonb()` | `convert_ap_to_jsonb()` | Universal converter |
| `convert_unified_content_to_activitypub_html()` | `convert_jsonb_to_ap()` | Universal converter |
| `convert_ap_dm_to_jsonb()` | ❌ **Removed** | No DM-specific converter needed |
| `create_notification()` + `create_notification_structured()` | `create_notification_unified()` | ONE function for all |
| 32 scattered triggers | 4 unified triggers | 87% reduction in complexity |

### **Notification System**
```sql
-- OLD (multiple functions):
create_notification()
create_notification_structured() 
create_simple_activitypub_notification()

-- NEW (unified):
create_notification_unified()  -- Handles ALL notification types
create_notification_with_spam_prevention()  -- With rate limiting
```

### **Content Conversion**
```sql
-- UNIVERSAL CONVERTERS (work for posts AND messages):
convert_ap_to_jsonb(html_content, tags) → JSONB content
convert_jsonb_to_ap(content) → ActivityPub HTML

-- APPLICATION HELPER (DM-specific logic):
strip_dm_mentions(content, domain) → JSONB content without domain mentions
```

## 📊 **System Architecture**

### **Local-First Design**
```
User Action → Local Database → UI Update (immediate)
                   ↓
            Federation (async, optional)
                   ↓
            Remote Delivery (background)
```

### **Unified Triggers**
```
Database Change → Unified Trigger → Check Federation Settings
                       ↓
                 Federation Enabled? → Queue for delivery
                       ↓
                 Send Notifications → Unified notification system
```

## 🧪 **Testing Your System**

### **Test 1: Posts Work**
1. Go to social timeline
2. Create a post with mentions: `Hello @username! How are you?`
3. Check: Post appears immediately, notification sent

### **Test 2: Messages Work**
1. Go to a server channel
2. Send message with reactions
3. Check: Message appears, reactions work, realtime updates

### **Test 3: DMs Work**
1. Start a DM conversation
2. Send message with mentions
3. Check: DM delivered, notifications sent, federation queued

### **Test 4: Federation Works**
1. Follow a remote user: `@user@mastodon.social`
2. Create a public post
3. Check: Federation queued in delivery queue

## 🔍 **Debugging**

### **Check Database Functions**
```sql
-- Test unified notification
SELECT create_notification_unified(
    (SELECT id FROM profiles LIMIT 1),
    'test',
    'Test Notification',
    'Testing system',
    '{"test": true}'::jsonb
);

-- Test universal converters
SELECT convert_jsonb_to_ap('[{"type":"text","text":"Hello world!"}]'::jsonb);
```

### **Check Triggers**
```sql
-- List unified triggers
SELECT trigger_name, event_manipulation, action_statement 
FROM information_schema.triggers 
WHERE trigger_schema = 'public' AND trigger_name LIKE '%unified%';
```

### **Check Federation Queue**
```sql
-- Check pending federation activities
SELECT activity_data->>'type', target_domain, status, attempts 
FROM federation_delivery_queue 
WHERE status = 'pending' 
ORDER BY created_at DESC;
```

## 🚨 **Common Issues**

### **Issue: Posts not federating**
**Solution**: Check federation settings
```sql
SELECT * FROM instance_config WHERE config_key = 'federation_settings';
SELECT federation_enabled FROM profiles WHERE id = 'your-user-id';
```

### **Issue: Notifications not working**
**Solution**: Check notification preferences
```sql
SELECT * FROM notification_preferences WHERE user_id = 'your-user-id';
```

### **Issue: Content not converting**
**Solution**: Check content format
```sql
-- Content should be JSONB array of MessagePart objects
SELECT content FROM posts WHERE id = 'your-post-id';
```

## 🎉 **You're Ready!**

Your system now has:
- ✅ **Professional architecture** (local-first, federation optional)
- ✅ **Unified systems** (notifications, content conversion, triggers)
- ✅ **Complete feature set** (posts, messages, DMs, reactions, follows)
- ✅ **Federation ready** (ActivityPub compatible, health monitoring)
- ✅ **Performance optimized** (87% fewer triggers, efficient queries)

**Start the dev server and test your refactored system!** 🚀

```bash
npm run dev
```