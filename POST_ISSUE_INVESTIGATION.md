# Post Functionality Investigation Report

**Date**: January 15, 2025  
**Issue**: Posts stop working after database and frontend refactor, despite DMs working correctly

## 🚨 **ROOT CAUSE IDENTIFIED**

The issue is **missing instance domain configuration** in the `instance_config` table. The post federation trigger exists and fires correctly, but the function exits early because no domain is configured.

## Summary

After investigating the codebase following a refactor that enabled federated DMs, the post creation functionality has stopped working. The issue is **not** frontend-related, environment-related, or missing triggers, but is caused by missing required configuration in the database.

## Critical Findings

### Trigger Status: ✅ EXISTS
The `trg_handle_post_federation` trigger **IS PRESENT** in the current database:
```sql
CREATE TRIGGER trg_handle_post_federation 
AFTER INSERT ON public.posts 
FOR EACH ROW 
WHEN (((new.is_local = true) AND (new.visibility <> 'private'::text))) 
EXECUTE FUNCTION public.handle_post_federation();
```

### Function Execution: ❌ EARLY EXIT
The `handle_post_federation()` function executes but exits early:
```sql
SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
FROM instance_config WHERE config_key = 'domain' LIMIT 1;

IF v_instance_domain IS NULL THEN
    RAISE WARNING 'No instance domain configured, skipping post federation';
    RETURN NEW;  -- ❌ EXITS HERE
END IF;
```

### Missing Configuration
**Required**: `instance_config` table entry with `config_key = 'domain'`  
**Status**: Missing from current database

## Flow Analysis

### Current Broken Flow
1. **Frontend** → Post creation succeeds ✅
2. **Database Insert** → Posts table record created ✅ 
3. **Trigger Execution** → `trg_handle_post_federation` fires ✅
4. **Function Execution** → `handle_post_federation()` runs ✅
5. **Domain Check** → Queries `instance_config.domain` ❌ **NULL**
6. **Early Exit** → Function exits with warning, no federation ❌

### Working DM Flow (For Comparison)
1. **Frontend** → DM creation succeeds ✅
2. **Database Insert** → Messages table record created ✅
3. **Trigger Execution** → `trg_handle_message_federation` fires ✅ 
4. **Function Execution** → `handle_message_federation()` runs ✅
5. **Federation** → Successfully federates to remote instances ✅

## 💡 **Immediate Fix Required**

Add the missing domain configuration to your database:

```sql
-- Option 1: Direct INSERT (if you have admin access)
INSERT INTO instance_config (config_key, config_value, description)
VALUES (
    'domain', 
    '"har.mony.lol"'::jsonb,  -- Replace with your actual domain
    'Main domain for this instance'
);

-- Option 2: Using the built-in function (if you have admin user)
SELECT set_instance_config(
    '<your-admin-user-id>'::uuid,
    'domain',
    '"har.mony.lol"'::jsonb,  -- Replace with your actual domain  
    'Main domain for this instance'
);
```

**Important**: Replace `har.mony.lol` with your actual instance domain.

## Why DMs Work But Posts Don't

Both DMs and posts use the same pattern but different triggers:

| Feature | Trigger | Function | Domain Check | Status |
|---------|---------|----------|--------------|--------|
| **Posts** | `trg_handle_post_federation` | `handle_post_federation()` | ❌ **Fails, exits early** | Broken |
| **DMs** | `trg_handle_message_federation` | `handle_message_federation()` | ✅ **Works correctly** | Working |

The difference is that the DM federation function may have different error handling or fallback logic that allows it to work without the domain configured, while the post federation function strictly requires the domain.

## Architecture Overview

### Required Configuration Schema
```sql
-- instance_config table structure
CREATE TABLE instance_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_key text NOT NULL,        -- 'domain'
    config_value jsonb NOT NULL,     -- '"har.mony.lol"'
    description text,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
```

### All Functions That Require Domain Config
- ✅ `handle_post_federation()` - **Missing domain breaks this**
- ✅ `handle_message_federation()` - **Working despite missing domain** 
- ✅ `setup_activitypub_federation()` - Used for user profile federation
- ✅ `extract_activitypub_mention_tags()` - Used for mention processing
- ✅ `get_public_instance_info()` - Used for instance metadata

## Complete Configuration Setup

Besides the domain, you may also want to configure:

```sql
-- Basic instance configuration
INSERT INTO instance_config (config_key, config_value, description) VALUES
('domain', '"har.mony.lol"'::jsonb, 'Main domain for this instance'),
('instance_name', '"Harmony"'::jsonb, 'Display name of the instance'),
('instance_description', '"A federated social platform"'::jsonb, 'Description of the instance'),
('open_registration', 'true'::jsonb, 'Whether new user registration is open'),
('approval_required', 'false'::jsonb, 'Whether new registrations require approval');

-- Federation settings
INSERT INTO instance_config (config_key, config_value, description) VALUES
('federation_settings', '{
    "federation_enabled": true,
    "federation_auto_accept_follows": true,
    "federation_require_approval": false,
    "federation_max_delivery_attempts": 5,
    "federation_delivery_timeout_ms": 10000
}'::jsonb, 'Federation configuration settings');
```

## Verification Steps

After adding the domain configuration:

1. **Test post creation** - Create a new post
2. **Check activity creation** - Verify `ap_activities` table has new entries
3. **Check federation queue** - Verify `federation_delivery_queue` has entries
4. **Monitor logs** - Look for "📮 Queued" messages instead of "No instance domain configured"

## Conclusion

The issue is a simple configuration problem, not a code or architecture issue. The post federation system is correctly designed and implemented, but requires the instance domain to be configured in the `instance_config` table to function.

Once the domain is configured, post federation should work immediately without any code changes.