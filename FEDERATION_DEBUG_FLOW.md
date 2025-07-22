# Federation Debug Flow - Post Creation

## **Frontend to Database Flow**

### 1. Frontend Post Creation
- **File**: `src/services/PostService.ts` → `createPost()`
- **Action**: Calls `corePostService.createPost(data)`

### 2. Core Service Database Insert
- **File**: `src/services/core/CorePostService.ts` → `createPost()`
- **Action**: Direct Supabase INSERT into `posts` table
- **SQL**: `INSERT INTO posts (author_id, content, visibility, ...) VALUES (...)`

### 3. Database Trigger Should Fire
- **Trigger**: `trigger_unified_content_federation` on `posts` table
- **Function**: `handle_unified_content_federation()`
- **Expected**: Create `ap_activities` + call `queue_activity_for_federation()`

### 4. Federation Queue Population
- **Expected**: INSERT into `federation_delivery_queue` table
- **Trigger**: `"Federated Outbox"` webhook should fire on queue INSERT
- **Webhook**: Calls `http://kong:8000/functions/v1/outbox/delivery`

---

## **Debug Checklist**

### ✅ Check 1: Trigger Exists on Posts Table
```sql
SELECT tgname, tgtype, tgenabled 
FROM pg_trigger t 
JOIN pg_class c ON t.tgrelid = c.oid 
WHERE c.relname = 'posts' AND tgname = 'trigger_unified_content_federation';
```

### ✅ Check 2: Function Exists and Contains Queue Calls
```sql
SELECT proname, prosrc 
FROM pg_proc 
WHERE proname = 'handle_unified_content_federation';
-- Look for: queue_activity_for_federation
```

### ✅ Check 3: Test Post Creation
1. Create post via frontend
2. Check `ap_activities` table for new entry
3. Check `federation_delivery_queue` table for new entry

### ✅ Check 4: Webhook Configuration
```sql
SELECT * FROM supabase_functions.hooks 
WHERE name = 'Federated Outbox';
```

---

## **Current Status After Migration 031**

- **Migration Applied**: ✅ 031 (fixed function + restored trigger)
- **Posts Trigger**: ✅ Should exist (`trigger_unified_content_federation`)
- **Function**: ✅ Should include `queue_activity_for_federation()` calls
- **Issue**: Federation still not working - need to debug WHY

---

## **Debugging Questions**

1. **Does the trigger exist?** Check pg_trigger for posts table
2. **Does the function call queue_activity_for_federation?** Check function source
3. **Are ap_activities being created?** Check table after post creation
4. **Are federation_delivery_queue entries being created?** Check table after post creation
5. **Is the webhook firing?** Check edge function logs