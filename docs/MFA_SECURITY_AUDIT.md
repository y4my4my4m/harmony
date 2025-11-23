# MFA Security Audit - Critical Findings

## 🚨 CRITICAL SECURITY ISSUE DISCOVERED

After fixing the frontend MFA bypass, a **more serious issue** was discovered:

### The Problem: Backend RLS Policies Don't Enforce AAL2

**Status:** The `auth.session_meets_aal_requirement()` function exists in the database, but **it's not being used by the RLS policies**.

This means:
- ✅ **Frontend**: MFA bypass fixed (users can't access UI)
- ❌ **Backend**: MFA bypass still possible (users can bypass database security)

### Attack Vector

An attacker who steals a password can:

1. Login with stolen password → Gets AAL1 session
2. Frontend blocks UI access (requires AAL2) ✅
3. **BUT**: They can bypass frontend entirely and query Supabase directly:

```javascript
// Attacker bypasses frontend and makes direct API calls
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
await supabase.auth.signInWithPassword({ email, password }) // AAL1 session

// ❌ These queries SUCCEED even without 2FA verification:
await supabase.from('messages').select('*')
await supabase.from('conversations').select('*')
await supabase.from('profiles').update({ ... })
```

**Result:** Full data access without ever seeing the frontend 2FA prompt!

## Current Defense Layers

| Layer | Protection | Status |
|-------|-----------|--------|
| **Frontend (Vue/Auth Store)** | Blocks UI access without AAL2 | ✅ **SECURE** |
| **Backend (RLS Policies)** | Should block database access without AAL2 | ❌ **VULNERABLE** |
| **JWT/AAL** | Cryptographically signed by Supabase | ✅ **SECURE** |

## What We Have

### ✅ Helper Function (Exists)

```sql
-- File: db_schema/supabase_schema_latest_11_21.sql (line 434)
CREATE FUNCTION auth.session_meets_aal_requirement() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT CASE
    WHEN auth.user_requires_aal2() THEN
      (auth.jwt()->>'aal' = 'aal2')
    ELSE
      true
  END;
$$;
```

This function:
- ✅ Checks if user has 2FA enabled
- ✅ If yes, requires AAL2
- ✅ If no, allows AAL1
- ✅ Cannot be bypassed (uses cryptographically signed JWT)

### ❌ RLS Policies (Not Using AAL Check)

Current policies look like this:

```sql
-- Example: messages table
CREATE POLICY "Users can create messages in conversations they participate in"
ON public.messages FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND ... other checks ...
  -- ❌ MISSING: AND auth.session_meets_aal_requirement()
);
```

**Problem:** These policies only check `auth.uid()` (user is authenticated), not AAL level.

## What We Need

### 🔒 Updated RLS Policies

All sensitive tables need AAL2 enforcement:

```sql
-- Example: Fixed messages policy
CREATE POLICY "Users can create messages in conversations they participate in"
ON public.messages FOR INSERT
WITH CHECK (
  user_id = auth.uid()
  AND auth.session_meets_aal_requirement()  -- ← ADD THIS
  AND ... other checks ...
);
```

### Tables That Need Protection

**High Priority (Contain User Data):**
- ✅ `profiles` - User profile data
- ✅ `messages` - All user messages
- ✅ `conversations` - DM conversations
- ✅ `channels` - Channel access
- ✅ `servers` - Server access
- ✅ `reactions` - Message reactions

**Medium Priority (Metadata):**
- `user_servers` - Server memberships
- `channel_subscriptions` - Channel subscriptions
- `notifications` - User notifications

**Low Priority (Public Data):**
- `federated_instances` - Public federation data
- `server_discovery` - Public server listings

## Implementation Plan

### Option 1: Apply Existing SQL File (Recommended)

The file `db_schema/mfa_aal2_rls_policies.sql` already has the updated policies:

```bash
# Connect to Supabase and run:
psql $DATABASE_URL -f db_schema/mfa_aal2_rls_policies.sql
```

This will update:
- ✅ profiles (update policy)
- ✅ messages (select, insert, update, delete policies)
- ✅ conversations (select, insert policies)

**Coverage:** Partial - covers most critical tables

### Option 2: Manual Policy Updates (More Control)

Update each policy manually via Supabase Dashboard:

1. Go to Authentication → Policies
2. For each table, edit policies
3. Add `AND auth.session_meets_aal_requirement()` to USING and WITH CHECK clauses
4. Test thoroughly

**Coverage:** Complete - you control what gets updated

### Option 3: Hybrid Approach (Safest)

1. Run helper functions only:
```bash
psql $DATABASE_URL -f db_schema/mfa_aal2_helpers.sql
```

2. Manually update critical policies first:
   - messages (all operations)
   - conversations (all operations)
   - profiles (update only)

3. Test extensively

4. Gradually add AAL checks to other tables

## Testing Backend Security

### Test 1: Verify Function Exists

```sql
-- Should return true/false (not error)
SELECT auth.session_meets_aal_requirement();
```

### Test 2: Check Current AAL

```sql
-- Check your current authentication level
SELECT auth.jwt()->>'aal' as current_aal;
```

### Test 3: Simulate Password-Only Login (AAL1)

```sql
-- Downgrade your session to AAL1 (simulates stolen password)
UPDATE auth.sessions 
SET aal = 'aal1', factor_id = NULL 
WHERE user_id = auth.uid();
```

### Test 4: Try to Access Protected Data

```sql
-- If RLS is properly configured, these should FAIL or return empty:
SELECT * FROM messages WHERE user_id = auth.uid();
SELECT * FROM conversations WHERE user1_id = auth.uid();
SELECT * FROM profiles WHERE id = auth.uid();
```

**Expected Result:**
- ❌ **Without AAL2 enforcement**: Queries succeed (VULNERABLE)
- ✅ **With AAL2 enforcement**: Queries fail or return empty (SECURE)

### Test 5: Restore AAL2

```bash
# Log out and log in again with 2FA
# AAL should be back to 'aal2'
```

## Security Implications

### Without Backend AAL2 Enforcement

**Attack Scenario:**
```
1. Attacker steals password (phishing, data breach, etc.)
2. Attacker uses stolen password:
   - Frontend: Blocked by UI (requires 2FA) ✅
   - Backend: NOT BLOCKED (direct API access) ❌
3. Attacker writes script to query Supabase directly
4. Full data access without 2FA verification
```

**Impact:**
- 🔴 **Critical**: Complete bypass of 2FA protection
- 🔴 **Critical**: Access to all user messages, DMs, profiles
- 🟡 **High**: No audit trail of unauthorized access
- 🟡 **High**: User's 2FA enrollment is meaningless

### With Backend AAL2 Enforcement

**Protected Scenario:**
```
1. Attacker steals password
2. Attacker attempts to access data:
   - Frontend: Blocked ✅
   - Backend: Also blocked (RLS requires AAL2) ✅
3. Attacker cannot access data without 2FA device
4. 2FA protection is REAL and EFFECTIVE
```

**Impact:**
- 🟢 **Defense in Depth**: Multiple layers of protection
- 🟢 **True MFA**: Cannot be bypassed at any level
- 🟢 **Secure**: Even if frontend is compromised, backend protects data

## Recommendation

### Immediate Action Required

1. **Apply RLS policies with AAL2 checks:**
   ```bash
   psql $DATABASE_URL -f db_schema/mfa_aal2_rls_policies.sql
   ```

2. **Test thoroughly with both AAL1 and AAL2 sessions**

3. **Monitor for access issues** - some users might be logged out if their AAL1 sessions can't access data

4. **Update remaining tables** not covered by the initial SQL file

### Long-term Security Practices

1. **Always use defense in depth:**
   - Frontend validation (UX)
   - Backend validation (API)
   - Database validation (RLS)

2. **Trust nothing from the client:**
   - All security checks must be server-side
   - Frontend is for UX only, not security

3. **Regular security audits:**
   - Review RLS policies quarterly
   - Test bypass scenarios
   - Monitor for unauthorized access patterns

4. **Security testing:**
   - Add automated tests for RLS policies
   - Test with compromised credentials
   - Verify AAL enforcement at all layers

## Files to Review

### SQL Schema Files
- `db_schema/mfa_aal2_helpers.sql` - Helper functions (✅ exists, ✅ deployed)
- `db_schema/mfa_aal2_rls_policies.sql` - RLS policies (✅ exists, ❌ not deployed)
- `db_schema/supabase_schema_latest_11_21.sql` - Current schema (⚠️ missing AAL checks in policies)

### Documentation
- `docs/2FA_SECURITY_MODEL.md` - Overall 2FA design
- `docs/2FA_BYPASS_FIX.md` - Frontend fix documentation
- `docs/SUPABASE_MFA_AAL_GUIDE.md` - Technical AAL reference

### Code
- `src/stores/auth.ts` - Frontend auth logic (✅ fixed)

## Summary

**Current Status:**
- ✅ Frontend MFA enforcement: SECURE
- ❌ Backend MFA enforcement: VULNERABLE

**Required Action:**
- Deploy RLS policies with AAL2 checks to database
- Test thoroughly before considering MFA truly secure

**Security Principle:**
> "Client-side security is not security. It's UX. Real security happens at the database layer where the client cannot reach."

## Deployment Checklist

- [ ] Backup current database schema
- [ ] Verify `auth.session_meets_aal_requirement()` function exists
- [ ] Apply RLS policies with AAL2 checks
- [ ] Test with test account (AAL1 should be blocked)
- [ ] Test with normal users (should work normally)
- [ ] Monitor logs for access denied errors
- [ ] Update remaining tables not covered by initial deployment
- [ ] Document which tables have AAL2 enforcement
- [ ] Add automated RLS policy tests
- [ ] Security audit complete ✓

---

**Priority:** 🔴 **CRITICAL**  
**Status:** ⚠️ **VULNERABLE**  
**Action:** Deploy RLS policies immediately

