# 2FA Security Model

How two-factor authentication (2FA) works in Harmony.

## How It Works

### At Login

```
User enters email + password
↓
Has 2FA enabled?
├─ NO  → Login successful (AAL1 session)
└─ YES → Enter 2FA code
         ↓
         Enter 6-digit code
         ↓
         Login successful (AAL2 session)
```

If a user has 2FA enabled, they must enter their 2FA code at login. It cannot be bypassed.

### After Login (Session Persistence)

```
Login with 2FA → AAL2 session created (24 hours)
↓
After 24 hours → AAL2 expires, downgrades to AAL1
↓
Refresh token keeps the user logged in
↓
User stays logged in (weeks/months until manual logout or token expiry)
```

The user stays logged in even after AAL2 expires. They only need to log in again (with 2FA) when they:
- Manually log out
- Have their refresh token expire (default: 60 days in Supabase)
- Clear browser storage

## Security Model

### What Is Checked

During the login flow:
- Password is required (AAL1)
- 2FA code is required if 2FA is enabled (upgrades to AAL2)
- 2FA cannot be bypassed if it is enabled

After login (session validation):
- Any valid session is accepted (AAL1 or AAL2)
- No AAL level checking on page refresh
- Refresh tokens keep users logged in

### What Is Not Checked

AAL level is not checked after login. Earlier versions logged users out after 24 hours; the current behavior accepts any valid session:

```typescript
// Earlier behavior: logged users out after 24 hours
if (has2FA && session.aal !== 'aal2') {
  signOut(); // forced re-login every 24 hours
}

// Current behavior: accept any valid session
if (session) {
  this.session = session; // AAL1 or AAL2
}
```

## User Experience

### First-Time Login
1. User enables 2FA in settings
2. Saves recovery codes
3. Logs out
4. The next login requires 2FA

### Daily Usage
1. Login once with password + 2FA
2. Stay logged in for weeks/months
3. AAL2 expires after 24h, downgrades to AAL1
4. The user is not prompted again and stays logged in
5. Re-login is only required after a manual logout

### Benefits
- Security: 2FA required at login, cannot be bypassed
- Convenience: no need to re-enter 2FA daily
- Industry standard: consistent with Discord, GitHub, Google, and others
- Long sessions: login once, stay logged in (similar to Reddit)

## Technical Details

### AAL Levels

AAL1 (Authentication Assurance Level 1)
- Password-only authentication
- Standard security
- No expiration (handled by refresh token)

AAL2 (Authentication Assurance Level 2)
- Password + 2FA authentication
- Enhanced security
- Expires after 24 hours (Supabase default)

### Session Lifecycle

```
Day 0:  Login with password + 2FA → AAL2 session
Day 1:  AAL2 expires → Automatic downgrade to AAL1
        ↓
        Session continues (refresh token still valid)
        ↓
        User stays logged in
Day 60: Refresh token expires (Supabase default)
        ↓
        User logged out
        ↓
        Must login again with password + 2FA
```

### Code Implementation

Auth store (`src/stores/auth.ts`):

```typescript
// During login - check if 2FA is required
async login(email: string, password: string) {
  const { data } = await supabase.auth.signInWithPassword({ email, password });
  
  // Check if user has 2FA enabled
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const has2FA = factors?.totp?.some(f => f.status === 'verified');
  
  if (has2FA) {
    // User must complete 2FA
    const { data: challenge } = await supabase.auth.mfa.challenge({
      factorId: totpFactor.id
    });
    
    return {
      requires2FA: true,
      factorId: totpFactor.id,
      challengeId: challenge.id
    };
  }
  
  // No 2FA needed
  return { requires2FA: false };
}

// After login - accept any session
async initializeAuth() {
  const { data } = await supabase.auth.getSession();
  
  // Accept session regardless of AAL level.
  // 2FA is enforced at login time, not on refresh.
  this.session = data.session;
}
```

## Recovery Codes

Users get 10 recovery codes when enabling 2FA:
- Each code can be used once
- Using a recovery code disables 2FA (assuming the user lost their authenticator)
- The user is redirected to settings to re-enable 2FA
- Recovery codes are stored as SHA-256 hashes in the database

## Comparison with Other Apps

### Discord
- 2FA required at login
- Stay logged in indefinitely
- Same as Harmony's implementation

### GitHub
- 2FA required at login
- Stay logged in for weeks
- Optional step-up to 2FA for sensitive operations
- Harmony does not have step-up yet (future enhancement)

### Google
- 2FA required at login
- Stay logged in until logout
- "Remember this device" option
- Harmony does not have device memory yet (future enhancement)

## Future Enhancements

1. Step-up authentication: require 2FA again for sensitive operations:
   - Changing password
   - Changing email
   - Modifying 2FA settings
   - Deleting account

2. Trusted devices: "Remember this device for 30 days"
   - Store device fingerprint
   - Skip 2FA on trusted devices
   - Still require password

3. Session activity log:
   - Active sessions
   - Device info
   - Last activity
   - Ability to revoke sessions

## Testing Checklist

2FA required at login:
- [ ] Enable 2FA on test account
- [ ] Log out
- [ ] Try to log in with just password
- [ ] Should show 2FA modal
- [ ] Enter wrong code
- [ ] Should show error
- [ ] Enter correct code
- [ ] Should login successfully

Long session persistence:
- [ ] Login with 2FA
- [ ] Note the time
- [ ] Wait 24+ hours
- [ ] Refresh the page
- [ ] Should still be logged in (no 2FA prompt)
- [ ] Check developer tools → Application → Local Storage
- [ ] Should see `sb-*-auth-token` still present

Manual logout:
- [ ] Login with 2FA
- [ ] Use the app normally
- [ ] Click "Log Out"
- [ ] Should be logged out
- [ ] Try to login again
- [ ] Should require 2FA again

Recovery codes:
- [ ] Enable 2FA
- [ ] Should see 10 recovery codes
- [ ] Save one recovery code
- [ ] Log out
- [ ] Click "Use recovery code instead"
- [ ] Enter the saved code
- [ ] Should login successfully
- [ ] Should see warning about re-enabling 2FA
- [ ] 2FA should be disabled
- [ ] Try to use same code again
- [ ] Should fail (already used)

## Database Schema

Recovery codes table:
```sql
CREATE TABLE mfa_recovery_codes (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  code_hash TEXT NOT NULL, -- SHA-256 hash
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Helper functions:
- `verify_recovery_code(user_id, code)` - Verify and mark as used
- `save_recovery_codes(user_id, codes[])` - Save hashed codes
- `count_unused_recovery_codes(user_id)` - Count remaining codes

## Related Files

- `src/stores/auth.ts` - Auth store with session management
- `src/components/AuthComponent.vue` - Login UI with 2FA modal
- `src/components/settings/user/PrivacySettings.vue` - 2FA setup UI
- `db_schema/mfa_recovery_codes.sql` - Recovery codes database schema
- `db_schema/mfa_aal2_helpers.sql` - AAL checking SQL functions
- `docs/2FA_RECOVERY_IMPLEMENTATION.md` - Recovery code details
- `docs/SUPABASE_MFA_AAL_GUIDE.md` - Technical AAL guide
- `docs/2FA_LOGIN_FIX.md` - MFA_CHALLENGE_VERIFIED race condition fix

## Summary

2FA protects the login, not the session. Once a user is logged in, they stay in until they log out or their refresh token expires (60 days default).
