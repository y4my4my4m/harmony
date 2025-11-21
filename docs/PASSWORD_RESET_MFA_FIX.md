# Password Reset MFA Fix

## Problem

Users with MFA (Multi-Factor Authentication) enabled were getting an "need AAL2" error when trying to reset their password after following the password reset email link.

## Root Cause

When a user with MFA enabled tries to reset their password:
1. They receive a password reset email with a recovery token
2. Clicking the link creates a session at **AAL1** (password-only authentication)
3. Attempting to update the password requires **AAL2** (password + 2FA verification)
4. Without AAL2, Supabase rejects the password update

## Solution

We've implemented a complete MFA-aware password reset flow that:

1. **Detects MFA Status**: After validating the recovery token, the system checks if the user has MFA enabled
2. **Shows 2FA Modal**: If MFA is enabled, a modal appears asking for 2FA verification
3. **Verifies 2FA**: User enters their 6-digit TOTP code to upgrade the session to AAL2
4. **Performs Password Reset**: With AAL2 access, the password update succeeds
5. **Recovery Code Option**: Users who lost access to their authenticator can use recovery codes

## Implementation Details

### Changes Made to `ResetPasswordView.vue`

#### 1. Added MFA State Variables

```typescript
// MFA State
const requiresMFA = ref(false)
const showMFAModal = ref(false)
const mfaCode = ref('')
const mfaError = ref('')
const mfaLoading = ref(false)
const mfaFactorId = ref('')
const mfaChallengeId = ref('')
const useRecoveryCode = ref(false)
```

#### 2. MFA Detection Function

```typescript
const checkMFAStatus = async () => {
  const { data: factors } = await supabase.auth.mfa.listFactors()
  const totpFactor = factors?.totp?.find((f: any) => f.status === 'verified')
  
  if (totpFactor) {
    requiresMFA.value = true
    mfaFactorId.value = totpFactor.id
  }
}
```

#### 3. Updated Password Reset Flow

```typescript
const handleResetPassword = async () => {
  // Validate passwords
  if (!validatePassword() || !validateConfirmPassword()) return
  
  // If MFA is required, show modal instead of resetting directly
  if (requiresMFA.value) {
    // Create MFA challenge
    const { data } = await supabase.auth.mfa.challenge({
      factorId: mfaFactorId.value
    })
    mfaChallengeId.value = data.id
    showMFAModal.value = true
    return
  }
  
  // No MFA, proceed with password reset
  await performPasswordReset()
}
```

#### 4. MFA Verification Handler

```typescript
const handleMFAVerification = async () => {
  if (useRecoveryCode.value) {
    // Verify recovery code
    const { data: isValid } = await supabase.rpc('verify_recovery_code', {
      p_user_id: userId,
      p_code: mfaCode.value
    })
    
    if (isValid) {
      // Unenroll MFA since they lost access
      await supabase.auth.mfa.unenroll({ factorId: mfaFactorId.value })
      requiresMFA.value = false
      await performPasswordReset()
    }
  } else {
    // Verify TOTP code
    await supabase.auth.mfa.verify({
      factorId: mfaFactorId.value,
      challengeId: mfaChallengeId.value,
      code: mfaCode.value
    })
    
    // Session is now AAL2
    await performPasswordReset()
  }
}
```

#### 5. Added MFA Modal UI

The modal includes:
- 6-digit TOTP code input
- Option to switch to recovery code (8 characters)
- Loading states and error handling
- Cancel button

## User Flow

### For Users WITH MFA Enabled

```
1. User clicks "Forgot Password"
2. Enters email, receives reset link
3. Clicks link → Taken to ResetPasswordView
4. System validates token ✓
5. System detects MFA is enabled
6. User enters new password
7. Clicks "Reset Password"
   ↓
8. 2FA Modal appears
9. User enters 6-digit TOTP code
10. System verifies code → Session upgraded to AAL2
11. Password reset succeeds ✓
12. User redirected to login
13. Logs in with new password + 2FA
```

### For Users WITHOUT MFA

```
1. User clicks "Forgot Password"
2. Enters email, receives reset link
3. Clicks link → Taken to ResetPasswordView
4. System validates token ✓
5. System detects NO MFA
6. User enters new password
7. Clicks "Reset Password"
8. Password reset succeeds ✓
9. User redirected to login
10. Logs in with new password
```

### Recovery Code Flow

If a user lost access to their authenticator app:

```
1-7. (Same as above)
8. 2FA Modal appears
9. User clicks "Use Recovery Code"
10. Enters 8-character recovery code
11. System verifies code ✓
12. System DISABLES 2FA (since they lost access)
13. Password reset succeeds ✓
14. User warned to re-enable 2FA
```

## Testing Instructions

### Test Case 1: Password Reset Without MFA

1. Create a test user without MFA enabled
2. Request password reset via forgot password link
3. Click the email link
4. Enter new password
5. ✅ Password should reset immediately without 2FA prompt

### Test Case 2: Password Reset With MFA (TOTP)

1. Create a test user and enable 2FA
2. Request password reset via forgot password link
3. Click the email link
4. Enter new password and click "Reset Password"
5. ✅ 2FA modal should appear
6. Enter 6-digit code from authenticator app
7. ✅ Password should reset successfully
8. Log in with new password + 2FA
9. ✅ Should work

### Test Case 3: Password Reset With MFA (Recovery Code)

1. Create a test user with 2FA enabled
2. Save recovery codes
3. Request password reset via forgot password link
4. Click the email link
5. Enter new password and click "Reset Password"
6. ✅ 2FA modal should appear
7. Click "Use Recovery Code"
8. Enter one of the recovery codes
9. ✅ Password should reset successfully
10. ✅ 2FA should be disabled (warning shown)
11. Log in with new password (no 2FA required)
12. ✅ Should work

### Test Case 4: Invalid 2FA Code

1. Follow steps 1-5 from Test Case 2
2. Enter incorrect 6-digit code
3. ✅ Should show error: "Invalid code. Please try again."
4. Enter correct code
5. ✅ Should work

### Test Case 5: Expired Recovery Token

1. Request password reset
2. Wait for token to expire (usually 1 hour)
3. Click the expired link
4. ✅ Should show: "This password reset link is invalid or has expired."

## Security Considerations

1. **AAL2 Enforcement**: Password updates for MFA users require AAL2, preventing password theft alone from compromising accounts

2. **Recovery Code Usage**: When a recovery code is used, 2FA is automatically disabled (user lost access to authenticator). This is intentional and follows industry best practices.

3. **Session Lifecycle**: After password reset, the recovery session is terminated and user must log in with new credentials

4. **Challenge Expiration**: MFA challenges expire quickly (typically 5 minutes) for security

5. **No MFA Bypass**: There's no way to reset password without either:
   - Valid TOTP code from authenticator app
   - Valid unused recovery code

## Troubleshooting

### "need AAL2" Error Still Appears

This should no longer happen. If it does:
1. Check that `checkMFAStatus()` is being called
2. Verify `requiresMFA.value` is set correctly
3. Check browser console for errors

### MFA Modal Doesn't Appear

1. Check if user actually has MFA enabled: `SELECT * FROM auth.mfa_factors WHERE user_id = '<user_id>'`
2. Verify `requiresMFA.value` is `true`
3. Check for JavaScript errors in console

### Recovery Codes Don't Work

1. Verify `verify_recovery_code` RPC function exists in database
2. Check if code was already used
3. Confirm user ID matches

## Related Files

- `/src/views/ResetPasswordView.vue` - Main password reset component (updated)
- `/src/stores/auth.ts` - Auth store with MFA methods
- `/src/components/AuthComponent.vue` - Login flow with 2FA (reference implementation)
- `/db_schema/mfa_recovery_codes.sql` - Recovery codes database functions
- `/docs/SUPABASE_MFA_AAL_GUIDE.md` - MFA implementation guide

## Additional Notes

- This implementation follows the same pattern as the login 2FA flow
- The modal UI matches the existing authentication design
- Recovery codes can only be used once and are marked as used in the database
- After using a recovery code, users should re-enable 2FA as soon as possible

## Future Improvements

Potential enhancements:

1. **SMS 2FA**: Add SMS verification as an alternative to TOTP
2. **Backup Emails**: Allow password reset via backup email for MFA users
3. **Rate Limiting**: Implement rate limiting on 2FA verification attempts
4. **Audit Logging**: Log all password reset attempts for security monitoring

