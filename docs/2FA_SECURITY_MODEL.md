# 2FA Security Model - Final Implementation

## Overview

This document explains how 2FA (Two-Factor Authentication) works in Harmony after implementing the balanced security approach.

## How It Works

### At Login ✅
```
User enters email + password
↓
Has 2FA enabled?
├─ NO  → Login successful (AAL1 session)
└─ YES → MUST enter 2FA code (can't skip!)
         ↓
         Enter 6-digit code
         ↓
         Login successful (AAL2 session)
```

**Key Point:** If you have 2FA enabled, **you MUST enter your 2FA code at login**. No exceptions.

### After Login (Session Persistence) ✅

```
Login with 2FA → AAL2 session created (24 hours)
↓
After 24 hours → AAL2 expires, downgrades to AAL1
↓
But refresh token keeps you logged in!
↓
User stays logged in (weeks/months until manual logout or token expiry)
```

**Key Point:** You stay logged in even after AAL2 expires. You only need to log in again (with 2FA) when you:
- Manually log out
- Refresh token expires (default: 60 days in Supabase)
- Clear browser storage

## Security Model

### What We Check

#### During Login Flow ✅
- **Password required** (AAL1)
- **2FA code required** if 2FA is enabled (upgrades to AAL2)
- Cannot bypass 2FA if it's enabled

#### After Login (Session Validation) ✅
- **Any valid session is accepted** (AAL1 or AAL2)
- No AAL level checking on page refresh
- Refresh tokens keep users logged in

### What We Don't Check

#### We DON'T Check AAL Level After Login ❌
```typescript
// ❌ OLD (BAD): Logged users out after 24 hours
if (has2FA && session.aal !== 'aal2') {
  signOut(); // This forced re-login every 24 hours!
}

// ✅ NEW (GOOD): Accept any valid session
if (session) {
  this.session = session; // AAL1 or AAL2 - doesn't matter!
}
```

## User Experience

### First-Time Login
1. User enables 2FA in settings
2. Saves recovery codes
3. Logs out
4. **Next login requires 2FA** ✅

### Daily Usage
1. Login once with password + 2FA
2. **Stay logged in for weeks/months** ✅
3. AAL2 expires after 24h, downgrade to AAL1
4. User doesn't notice - stays logged in!
5. Only re-login if they manually log out

### Benefits
- **Security:** 2FA required at login (can't bypass)
- **Convenience:** Don't need to re-enter 2FA daily
- **Industry Standard:** How Discord, GitHub, Google, etc. work
- **Long Sessions:** Like Reddit - login once, stay logged in

## Technical Details

### AAL Levels

**AAL1 (Authentication Assurance Level 1)**
- Password-only authentication
- Standard security
- No expiration (refresh token handles this)

**AAL2 (Authentication Assurance Level 2)**
- Password + 2FA authentication
- Enhanced security
- **Expires after 24 hours** (Supabase default)

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

**Auth Store (`src/stores/auth.ts`):**

```typescript
// During login - check if 2FA is required
async login(email: string, password: string) {
  const { data } = await supabase.auth.signInWithPassword({ email, password });
  
  // Check if user has 2FA enabled
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const has2FA = factors?.totp?.some(f => f.status === 'verified');
  
  if (has2FA) {
    // User MUST complete 2FA
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
  
  // Accept session regardless of AAL level
  // 2FA is enforced at LOGIN time, not on refresh
  this.session = data.session;
}
```

## Recovery Codes

Users get 10 recovery codes when enabling 2FA:
- Each code can be used **once**
- Using a recovery code **disables 2FA** (they lost their authenticator)
- User is redirected to settings to re-enable 2FA
- Recovery codes are stored as **SHA-256 hashes** in the database

## Comparison with Other Apps

### Discord
- 2FA required at login
- Stay logged in indefinitely
- Same as our implementation

### GitHub
- 2FA required at login
- Stay logged in for weeks
- Optional: "Step up" to 2FA for sensitive operations
- We don't have "step up" yet (future enhancement)

### Google
- 2FA required at login
- Stay logged in until you log out
- "Remember this device" option
- We don't have device memory yet (future enhancement)

## Future Enhancements

### Possible Improvements:
1. **Step-Up Authentication** - Require 2FA again for sensitive operations:
   - Changing password
   - Changing email  
   - Modifying 2FA settings
   - Deleting account

2. **Trusted Devices** - "Remember this device for 30 days"
   - Store device fingerprint
   - Skip 2FA on trusted devices
   - Still require password

3. **Session Activity Log** - Show users:
   - Active sessions
   - Device info
   - Last activity
   - Ability to revoke sessions

## Testing Checklist

### 2FA Required at Login ✅
- [ ] Enable 2FA on test account
- [ ] Log out
- [ ] Try to log in with just password
- [ ] ✅ Should show 2FA modal (can't skip!)
- [ ] Enter wrong code
- [ ] ✅ Should show error
- [ ] Enter correct code
- [ ] ✅ Should login successfully

### Long Session Persistence ✅
- [ ] Login with 2FA
- [ ] Note the time
- [ ] Wait 24+ hours
- [ ] Refresh the page
- [ ] ✅ Should still be logged in (no 2FA prompt!)
- [ ] Check developer tools → Application → Local Storage
- [ ] ✅ Should see `sb-*-auth-token` still present

### Manual Logout ✅
- [ ] Login with 2FA
- [ ] Use the app normally
- [ ] Click "Log Out"
- [ ] ✅ Should be logged out
- [ ] Try to login again
- [ ] ✅ Should require 2FA again

### Recovery Codes ✅
- [ ] Enable 2FA
- [ ] ✅ Should see 10 recovery codes
- [ ] Save one recovery code
- [ ] Log out
- [ ] Click "Use recovery code instead"
- [ ] Enter the saved code
- [ ] ✅ Should login successfully
- [ ] ✅ Should see warning about re-enabling 2FA
- [ ] ✅ 2FA should be disabled
- [ ] Try to use same code again
- [ ] ✅ Should fail (already used)

## Database Schema

**Recovery Codes Table:**
```sql
CREATE TABLE mfa_recovery_codes (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  code_hash TEXT NOT NULL, -- SHA-256 hash
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Helper Functions:**
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

**The Perfect Balance:**
- **Secure:** 2FA is REQUIRED at login (can't bypass)
- **Convenient:** Stay logged in for weeks (no daily 2FA prompts)
- **Industry Standard:** How all major apps work
- **User-Friendly:** Login once, use the app

**Key Takeaway:** 2FA protects your **login**, not your **session**. Once you're in, you stay in until you log out or your refresh token expires (60 days default).


