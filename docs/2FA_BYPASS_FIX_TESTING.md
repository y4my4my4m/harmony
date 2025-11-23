# 2FA Bypass Fix - Testing Guide

## Test Setup

1. Create or use a test account
2. Enable 2FA in settings
3. Log out completely
4. Clear browser storage/cache to ensure fresh state

## Critical Test: MFA Bypass Prevention

### Test 1: Fresh Login with 2FA (Primary Security Test)

**Steps:**
1. Open browser dev tools (F12) → Console tab
2. Navigate to login page
3. Enter email and password for account with 2FA enabled
4. Click "Log In"

**Expected Console Output:**
```
🔐 Starting login...
🔒 2FA required - session is AAL1, need AAL2 verification
🔐 Auth event: SIGNED_IN, AAL: aal1
🚨 SIGNED_IN event with AAL1 but 2FA enabled - rejecting (MFA bypass prevented)
```

**Expected Behavior:**
- ✅ 2FA modal appears
- ✅ User does NOT have access to app yet
- ✅ `authStore.session` is `null` (check in Vue DevTools)
- ✅ Cannot navigate to `/chat` or other protected routes
- ❌ If user can access app without entering 2FA code → **VULNERABILITY DETECTED**

**Verify in Vue DevTools:**
```javascript
// In console, check auth store state:
$store.auth.session  // Should be null before 2FA verification
```

### Test 2: Complete 2FA Verification

**Steps:**
1. With 2FA modal open from Test 1
2. Enter valid 6-digit code from authenticator app
3. Click "Verify"

**Expected Console Output:**
```
🔐 Auth event: MFA_CHALLENGE_VERIFIED, AAL: aal1
✅ MFA challenge verified - allowing session through
✅ 2FA verified - session upgraded to AAL2
```

**Expected Behavior:**
- ✅ Login completes successfully
- ✅ Redirected to `/chat` or dashboard
- ✅ `authStore.session` is now set
- ✅ AAL level is `aal2`

**Verify in Console:**
```javascript
$store.auth.session?.user.aal  // Should be 'aal2'
```

### Test 3: Session Persistence (Don't Break Existing UX)

**Steps:**
1. After successful login with 2FA from Test 2
2. Refresh the page (F5)

**Expected Console Output:**
```
🔐 Auth event: TOKEN_REFRESHED, AAL: aal2  // or aal1 if >24h
```

**Expected Behavior:**
- ✅ User remains logged in
- ✅ No 2FA prompt appears
- ✅ Session persists even if AAL2 expired (after 24 hours)
- ❌ If user is logged out → **BUG: Session persistence broken**

### Test 4: Session After AAL2 Expires (24+ Hours)

**To simulate AAL2 expiration without waiting:**

1. Login with 2FA (get AAL2 session)
2. In browser console:
```javascript
// Get current session token
const token = localStorage.getItem('sb-<your-project-id>-auth-token');
const session = JSON.parse(token);

// Decode JWT and check AAL
const base64Url = session.access_token.split('.')[1];
const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
const payload = JSON.parse(atob(base64));
console.log('Current AAL:', payload.aal);  // Should be 'aal2'
```

**After 24 hours or manual AAL downgrade:**
```
🔐 Auth event: TOKEN_REFRESHED, AAL: aal1
```

**Expected Behavior:**
- ✅ User stays logged in (session persists)
- ✅ No 2FA prompt on page refresh
- ✅ App continues to work normally
- ❌ If user is logged out → **BUG: Over-aggressive AAL checking**

### Test 5: Recovery Code Login

**Steps:**
1. Log out
2. Navigate to login page
3. Enter email and password (2FA enabled account)
4. When 2FA modal appears, click "Use recovery code instead"
5. Enter one of the recovery codes

**Expected Behavior:**
- ✅ Login succeeds
- ✅ 2FA is disabled on account
- ✅ Warning message about re-enabling 2FA
- ✅ Recovery code is marked as used (can't reuse)

### Test 6: Wrong 2FA Code

**Steps:**
1. Log out
2. Enter email and password
3. 2FA modal appears
4. Enter incorrect 6-digit code
5. Click "Verify"

**Expected Behavior:**
- ❌ Error message shown
- ✅ User still locked out (no access)
- ✅ Can try again with correct code
- ✅ `authStore.session` remains `null`

## Regression Tests

### Test 7: Login Without 2FA

**Steps:**
1. Log in with account that does NOT have 2FA enabled

**Expected Behavior:**
- ✅ Login succeeds immediately
- ✅ No 2FA modal appears
- ✅ Direct access to app
- ✅ AAL is `aal1` (which is fine, no 2FA required)

### Test 8: Registration (New Account)

**Steps:**
1. Register new account with email/password

**Expected Behavior:**
- ✅ Registration succeeds
- ✅ No 2FA required (new accounts start without 2FA)
- ✅ Can access app immediately

### Test 9: Password Reset with 2FA Enabled

**Steps:**
1. Use "Forgot Password" flow with 2FA-enabled account
2. Receive email, click reset link
3. Enter new password

**Expected Behavior:**
- ✅ Password reset succeeds
- ✅ 2FA remains enabled
- ✅ Next login requires 2FA with new password

## Security Validation

### Check 1: Frontend Session State

Open Vue DevTools → Pinia Store → auth:

**Before 2FA verification:**
```javascript
{
  session: null,  // ← MUST be null
  isPasswordResetMode: false
}
```

**After 2FA verification:**
```javascript
{
  session: { 
    user: { ... },
    access_token: "...",
    // JWT contains aal: "aal2"
  },
  isPasswordResetMode: false
}
```

### Check 2: Backend RLS Protection

Even if frontend is bypassed, database should block access:

1. Open browser console
2. Try to query data directly:
```javascript
// This should FAIL if session is AAL1 but user has 2FA
await supabase.from('profiles').select('*').eq('id', 'user-id')
// Error: "Session does not meet AAL requirement"
```

### Check 3: Console Logging

During the fix, proper console logs should appear:

**Login attempt with 2FA:**
```
🔒 2FA required - session is AAL1, need AAL2 verification
🔐 Auth event: SIGNED_IN, AAL: aal1
🚨 SIGNED_IN event with AAL1 but 2FA enabled - rejecting (MFA bypass prevented)
```

**Successful 2FA:**
```
🔐 Auth event: MFA_CHALLENGE_VERIFIED, AAL: aal1
✅ MFA challenge verified - allowing session through
✅ 2FA verified - session upgraded to AAL2
```

**Session refresh:**
```
🔐 Auth event: TOKEN_REFRESHED, AAL: aal2
```

## Vulnerability Indicators

### 🚨 CRITICAL: If any of these happen, the fix failed:

1. **User can access app after entering password but before 2FA**
   - Check: Navigate to `/chat` directly after login with 2FA
   - Should be blocked/redirected

2. **`authStore.session` is set before 2FA verification**
   - Check: Vue DevTools → Pinia → auth.session
   - Should be `null` until 2FA completed

3. **No console warning about AAL1 rejection**
   - Should see: `🚨 SIGNED_IN event with AAL1 but 2FA enabled - rejecting`
   - If missing, validation not running

4. **2FA modal doesn't appear**
   - Should always appear for accounts with 2FA enabled
   - If skipped, critical bug

## Performance Checks

### ✅ Should NOT Impact:

1. **Login speed** - No noticeable delay
2. **Page load time** - Session restoration is fast
3. **Token refresh** - Auto-refresh continues to work
4. **Memory usage** - No leaks from auth listeners

### Monitor:

- Check browser console for errors
- Watch network tab for failed requests
- Verify localStorage contains session token after login

## Cleanup

After testing:
1. ✅ Test account remains secure
2. ✅ No orphaned sessions in database
3. ✅ No console errors
4. ✅ All recovery codes remain valid (unless used)

## Quick Validation Checklist

- [ ] Fresh login with 2FA shows modal (not bypassed)
- [ ] Cannot access app before entering 2FA code
- [ ] Console shows AAL1 rejection for SIGNED_IN event
- [ ] authStore.session is null before 2FA verification
- [ ] Login succeeds after correct 2FA code
- [ ] Session persists on page refresh (no re-login)
- [ ] Session persists after 24h (AAL2 → AAL1 downgrade)
- [ ] Login without 2FA still works normally
- [ ] New account registration works normally
- [ ] Recovery codes work for 2FA bypass
- [ ] Wrong 2FA code shows error (user locked out)

## Automated Testing (Future)

### Recommended E2E Tests:

```javascript
describe('2FA Bypass Prevention', () => {
  it('should block login after password without 2FA verification', async () => {
    // Login with credentials
    await loginWithPassword('user@example.com', 'password');
    
    // Check session is NOT set
    const session = await getAuthStore().session;
    expect(session).toBeNull();
    
    // Verify cannot access protected routes
    await router.push('/chat');
    expect(router.currentRoute.value.path).toBe('/login');
  });
  
  it('should allow login after 2FA verification', async () => {
    // Login with credentials
    await loginWithPassword('user@example.com', 'password');
    
    // Complete 2FA
    await verify2FA('123456');
    
    // Check session IS set
    const session = await getAuthStore().session;
    expect(session).not.toBeNull();
    expect(getAAL(session)).toBe('aal2');
  });
});
```

## Summary

This fix ensures that users with 2FA enabled **cannot bypass** the 2FA requirement during login. The session is only set in the auth store after successful 2FA verification, preventing unauthorized access. Session persistence for existing logins remains unaffected.

**Key Security Principle:** 
> "Never trust, always verify - especially on SIGNED_IN events"

