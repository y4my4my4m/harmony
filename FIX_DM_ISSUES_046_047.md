# 🚨 **DM Federation Issues & Fixes - Migrations 046 & 047**

## **Issues Found**

### **🔴 Issue 1: DM Sending Fails with 400 Error** 
**Error**: `column "activity_uuid" of relation "federation_delivery_queue" does not exist`

**Root Cause**: The `handle_outgoing_messages()` function was trying to insert into `federation_delivery_queue` using column names that don't exist in the actual table schema.

**Columns the function tried to use vs. actual table:**
- ❌ `activity_uuid` → ✅ `activity_id`
- ❌ `activity` → ✅ `activity_data`
- ❌ `target_inbox` → ✅ `target_inbox_url`
- ❌ `sender_profile_id`, `recipient_profile_id`, `message_id`, `delivery_type` → ❌ Don't exist

**Impact**: **All DM sending was broken** - could not send any direct messages.

---

### **🟡 Issue 2: "Local user not found" Warning**
**Error**: `WARNING: Local user not found: y4my4m@har.mony.lol`

**Root Cause**: Inbox processing functions are looking for local users using a specific lookup pattern that may not be finding the user correctly.

**Lookup Pattern**: 
```sql
WHERE username = 'y4my4m' 
  AND domain = 'har.mony.lol' 
  AND is_local = true
```

**Impact**: **Receiving federated DMs may fail** - incoming DMs from remote instances might not be processed for local users.

---

## **Fixes Applied**

### **✅ Migration 046: Fix Federation Delivery Queue Schema**

**What it fixes**: Updates `handle_outgoing_messages()` function to use correct column names when inserting into `federation_delivery_queue`.

**Changes made:**
1. **Fixed column mapping:**
   - `activity_uuid` → `activity_id` (references `ap_activities.id`)
   - `activity` → `activity_data` (full ActivityPub JSON)
   - `target_inbox` → `target_inbox_url`
   - Removed non-existent columns

2. **Improved federation flow:**
   - First inserts into `ap_activities` table
   - Then references that ID in `federation_delivery_queue`
   - Uses correct table schema throughout

3. **Enhanced notification system:**
   - Updated to use modern `send_notification()` function
   - Supports conversation participants system
   - Maintains local-first notification approach

**Result**: **DM sending should work again** ✅

---

### **🔍 Migration 047: Debug Local User Lookup**

**What it provides**: Debug function to investigate why local user lookups are failing in inbox processing.

**Debug function**: `debug_local_user_lookup('y4my4m', 'har.mony.lol')`

**What it checks:**
1. Instance domain configuration
2. All users with the username
3. Exact lookup pattern (username + domain + is_local)
4. Alternative lookup patterns (domain=NULL, any domain)
5. Detailed user profile information

**Usage**: Run in your database to understand why the lookup is failing:
```sql
SELECT * FROM debug_local_user_lookup();
```

**Result**: **Will show exactly why user lookup is failing** 🔍

---

## **How to Apply These Fixes**

### **Step 1: Apply Migration 046 (Critical)**
Copy and run the SQL from `db_migrations/046_fix_federation_delivery_queue_schema.sql` in your Supabase SQL editor.

### **Step 2: Test DM Sending**
Try sending a DM to verify the fix works.

### **Step 3: Apply Migration 047 (Debug)**
Copy and run the SQL from `db_migrations/047_debug_local_user_lookup.sql` in your Supabase SQL editor.

### **Step 4: Run Debug Function**
```sql
SELECT * FROM debug_local_user_lookup();
```

This will show you exactly how your user data is stored and why the lookup might be failing.

---

## **Expected Results**

### **After Migration 046:**
- ✅ DM sending should work without 400 errors
- ✅ Federation delivery queue should populate correctly
- ✅ Activities should be created in `ap_activities` table
- ✅ Notifications should work for local users

### **After Migration 047:**
- 🔍 Clear understanding of user lookup issue
- 📊 Detailed user profile information
- 🎯 Identification of why "Local user not found" occurs
- 🛠️ Data needed to create proper fix

---

## **Next Steps**

1. **Apply Migration 046** immediately to fix DM sending
2. **Test DM functionality** to confirm fix works
3. **Apply Migration 047** to debug the lookup issue
4. **Analyze debug results** to understand the root cause
5. **Create targeted fix** based on debug findings

---

## **Architecture Notes**

### **Federation Flow (After Fix):**
1. User sends DM via service layer
2. `handle_outgoing_messages()` trigger fires
3. **Notifications**: Sent to local participants using `send_notification()`
4. **Federation**: Activity inserted into `ap_activities` table
5. **Delivery**: Queued in `federation_delivery_queue` with correct schema
6. **Edge Functions**: Process delivery queue for actual HTTP delivery

### **Local User Lookup (Investigation Needed):**
The inbox processing functions expect local users to be found with:
- `username` = extracted from ActivityPub mention
- `domain` = instance domain from config
- `is_local` = true

If this lookup fails, the debug function will show exactly why and help us create the right fix.

---

## **Critical Success Factors**

- **Migration 046 is essential** - DMs won't work without it
- **Migration 047 provides diagnosis** - essential for fixing the lookup issue
- **Both migrations are safe** - they don't modify existing data, only functions
- **Zero downtime** - can be applied while system is running

Apply Migration 046 first to restore DM functionality, then use Migration 047 to solve the receiving issue! 🚀