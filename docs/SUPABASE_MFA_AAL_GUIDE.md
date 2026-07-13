# Supabase MFA AAL (Authentication Assurance Level) Guide

## Understanding AAL in Supabase MFA

### What is AAL?

AAL (Authentication Assurance Level) is a security metric that indicates how strongly a user has been authenticated:

- **AAL1**: Password-only authentication (single factor)
- **AAL2**: Multi-factor authentication (password + TOTP/2FA)

### Where is AAL Stored?

The AAL level is stored in the JWT token and accessible via:

```typescript
// AAL is not directly on the session object
const aal = session.aal; // undefined

// AAL is in the user object
const aal = session.user.aal; // 'aal1' or 'aal2'
```

### In SQL

When writing RLS policies, access AAL via:

```sql
SELECT auth.jwt()->>'aal' as current_aal;
```

## MFA Authentication Flow

### 1. Initial Login (Password Only)
```
User enters email/password
→ SIGNED_IN event fires
→ Session created with AAL1
→ Check if user has 2FA enabled
→ If yes, show 2FA modal (don't set session in store yet)
```

### 2. 2FA Verification
```
User enters 6-digit code
→ Call supabase.auth.mfa.verify()
→ MFA_CHALLENGE_VERIFIED event fires (AAL still AAL1 at this moment)
→ Session upgraded to AAL2 in background
→ getSession() now returns AAL2 session
```

### 3. Session Persistence
```
AAL2 session is saved to localStorage automatically
→ On page refresh, getSession() returns AAL2 session
→ User doesn't need to re-enter 2FA (for 24 hours by default)
```

## Critical Implementation Details

### Issue 1: Race Condition with MFA_CHALLENGE_VERIFIED

The problem:
```typescript
supabase.auth.onAuthStateChange(async (event, session) => {
  if (session) {
    const aal = session.user.aal;
    if (aal !== 'aal2') {
      return; // Reject session
    }
  }
});
```

When the `MFA_CHALLENGE_VERIFIED` event fires, the session AAL is still `aal1` because the upgrade happens after the event. This causes the session to be rejected.

The solution:
```typescript
supabase.auth.onAuthStateChange(async (event, session) => {
  // Special case: Allow MFA_CHALLENGE_VERIFIED through without AAL check
  if (event === 'MFA_CHALLENGE_VERIFIED') {
    this.session = session;
    return; // Skip AAL validation
  }
  
  // Normal AAL validation for other events
  if (session) {
    const aal = session.user.aal || 'aal1';
    if (has2FA && aal !== 'aal2') {
      return; // Reject session
    }
  }
});
```

### Issue 2: Reading AAL from Wrong Property

Wrong:
```typescript
const aal = (session as any).aal; // undefined
```

Correct:
```typescript
const aal = session.user.aal || 'aal1';
```

### Issue 3: Calling refreshSession() After mfa.verify()

Avoid this:
```typescript
await supabase.auth.mfa.verify({...});
await supabase.auth.refreshSession(); // causes issues
```

Do this instead:
```typescript
await supabase.auth.mfa.verify({...});
// Wait a moment for the auth state change to process
await new Promise(resolve => setTimeout(resolve, 100));
const { data } = await supabase.auth.getSession();
```

## Testing AAL

### Check Current AAL Level

**In SQL:**
```sql
SELECT auth.jwt()->>'aal' as current_aal;
```

**In TypeScript:**
```typescript
const { data } = await supabase.auth.getSession();
console.log('Current AAL:', data.session?.user.aal);
```

### Simulate AAL1 Session (Testing)

```sql
-- Force session back to AAL1
UPDATE auth.sessions 
SET aal = 'aal1', factor_id = NULL 
WHERE user_id = auth.uid();
```

### Check if User Has 2FA Enabled

```typescript
const { data: factors } = await supabase.auth.mfa.listFactors();
const has2FA = factors?.totp?.some(f => f.status === 'verified');
```

## Session Persistence

### How It Works

1. Supabase stores sessions in `localStorage` by default
2. Key: `sb-<project-ref>-auth-token`
3. Value: JSON with access_token, refresh_token, expires_at, etc.
4. AAL level is encoded in the JWT access_token

### AAL2 Sessions Last 24 Hours

- AAL2 sessions expire after 24 hours by default
- After 24 hours, user must re-enter 2FA code
- Access token refresh does not extend AAL2 duration
- Only a fresh MFA verification resets the 24-hour timer

### Troubleshooting Session Loss

If users are logged out on page refresh:

1. **Check localStorage access**
   ```javascript
   console.log(localStorage.getItem(`sb-${projectRef}-auth-token`));
   ```

2. **Check auth client config**
   ```typescript
   const supabase = createClient(url, key, {
     auth: {
       persistSession: true, // ← Must be true (default)
       autoRefreshToken: true, // ← Must be true (default)
     }
   });
   ```

3. **Check initializeAuth() logic**
   - Make sure it's not signing users out unnecessarily
   - Verify AAL checking logic is correct
   - Add console.logs to see what's happening

## Common Pitfalls

### Pitfall 1: Checking AAL Too Aggressively

```typescript
// Logs the user out even though the AAL2 session is valid
if (session && has2FA && session.user.aal !== 'aal2') {
  await supabase.auth.signOut(); // logged out on every page load
}
```

Why it happens: if `session.user.aal` is undefined or null, this logs users out even when their session is actually valid.

Solution: add proper defaults and logging:
```typescript
const aal = session.user.aal || 'aal1';
console.log('Session AAL:', aal);
if (session && has2FA && aal !== 'aal2') {
  console.warn('Invalid AAL, logging out');
  await supabase.auth.signOut();
}
```

### Pitfall 2: Not Handling MFA_CHALLENGE_VERIFIED

The `MFA_CHALLENGE_VERIFIED` event is special: it fires before the AAL upgrade completes. Always allow it through without AAL validation.

### Pitfall 3: Multiple Auth State Listeners

Having multiple `onAuthStateChange` listeners can cause race conditions. Only set up one listener in your auth initialization.

## Best Practices

1. **Single Source of Truth**: Use one `onAuthStateChange` listener
2. **Proper AAL Access**: Always use `session.user.aal`
3. **Special Case MFA Events**: Allow `MFA_CHALLENGE_VERIFIED` through
4. **Defensive Defaults**: Use `|| 'aal1'` as fallback
5. **Logging**: Log AAL at every critical point
6. **Don't Over-Refresh**: Avoid unnecessary `refreshSession()` calls

## RLS Policy Example

```sql
CREATE POLICY "Users with 2FA must be AAL2" 
ON public.profiles 
FOR ALL 
TO authenticated
USING (
  auth.uid() = id 
  AND auth.session_meets_aal_requirement()
);
```

The `auth.session_meets_aal_requirement()` function checks:
- If user has 2FA → require AAL2
- If user doesn't have 2FA → allow AAL1

## Related Files

- `src/stores/auth.ts` - Auth state management
- `db_schema/mfa_aal2_helpers.sql` - SQL helper functions
- `db_schema/mfa_recovery_codes.sql` - Recovery code system
- `docs/2FA_LOGIN_FIX.md` - MFA login hanging fix
- `docs/2FA_RECOVERY_IMPLEMENTATION.md` - Recovery code implementation

## References

- [Supabase MFA Docs](https://supabase.com/docs/guides/auth/auth-mfa)
- [Session Management](https://supabase.com/docs/guides/auth/sessions)
- [RLS with MFA](https://supabase.com/docs/guides/auth/row-level-security)

