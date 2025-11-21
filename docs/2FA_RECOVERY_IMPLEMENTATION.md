# 2FA Recovery Implementation

## Overview
This document describes the implementation of 2FA recovery codes and fixes for the 2FA authentication flow.

## Issues Fixed

### 1. 2FA Login Spinning Forever
**Problem**: After entering a valid 2FA code, the login screen would show a loading spinner indefinitely and never redirect the user to the app.

**Solution**: Added an explicit redirect to `/chat` after successful 2FA verification in `AuthComponent.vue`.

### 2. Missing Recovery Code System
**Problem**: Users who lost access to their authenticator app were told to "contact support" with no self-service recovery option.

**Solution**: Implemented a complete recovery code system:
- Recovery codes are generated and displayed when 2FA is enabled
- Recovery codes are securely stored in the database (hashed with SHA-256)
- Users can use recovery codes to sign in if they lose their authenticator
- Using a recovery code automatically disables 2FA and redirects to settings to re-enable it

## Changes Made

### Database Changes
Created new table and functions in `db_schema/mfa_recovery_codes.sql`:

- **Table**: `mfa_recovery_codes` - Stores hashed recovery codes with RLS policies
- **Function**: `save_recovery_codes(user_id, codes[])` - Saves hashed recovery codes
- **Function**: `verify_recovery_code(user_id, code)` - Verifies and marks a recovery code as used
- **Function**: `count_unused_recovery_codes(user_id)` - Counts remaining unused codes

### Frontend Changes

#### `src/components/AuthComponent.vue`
1. **Fixed spinning issue**: Added explicit redirect after successful 2FA verification
2. **Added recovery code mode**: Users can toggle between authenticator code and recovery code
3. **Recovery code input**: 8-character uppercase recovery code input
4. **Recovery code verification**: Validates recovery code, disables 2FA, and redirects to settings

Key features:
- Toggle button: "Use recovery code instead" / "Use authenticator code instead"
- Different input validation for 6-digit codes vs 8-character recovery codes
- Auto-uppercase for recovery codes
- Clear error messages for invalid codes

#### `src/components/settings/user/PrivacySettings.vue`
1. **Save recovery codes**: When 2FA is enabled, recovery codes are saved to database
2. **Delete recovery codes**: When 2FA is disabled, recovery codes are deleted from database

## Database Setup Instructions

To apply the database changes, run the following SQL in your Supabase SQL editor:

```bash
# Navigate to Supabase dashboard > SQL Editor
# Run the contents of: db_schema/mfa_recovery_codes.sql
```

Or via command line:
```bash
psql <your-supabase-connection-string> -f db_schema/mfa_recovery_codes.sql
```

## How Recovery Codes Work

### Setup Flow (Enabling 2FA)
1. User scans QR code with authenticator app
2. User verifies setup with a 6-digit code
3. ✅ **10 recovery codes are generated and displayed**
4. 🔒 **Recovery codes are hashed and saved to database**
5. User must save recovery codes in a safe place

### Recovery Flow (Lost Authenticator)
1. User attempts to log in
2. 2FA modal appears asking for authenticator code
3. User clicks "Use recovery code instead"
4. User enters one of their 8-character recovery codes
5. System verifies the recovery code against database
6. ✅ **Recovery code is marked as used** (can't be reused)
7. 🔓 **2FA is automatically disabled** (user lost access to authenticator)
8. User is logged in and redirected to privacy settings
9. ⚠️ **User is prompted to re-enable 2FA**

### Security Features
- Recovery codes are stored as SHA-256 hashes (not plaintext)
- Each recovery code can only be used once
- Using a recovery code disables 2FA (prevents abuse)
- User must re-enable 2FA with a new authenticator
- RLS policies ensure users can only access their own codes

## Testing Checklist

### Test 2FA Login Fix
- [ ] Enable 2FA on a test account
- [ ] Log out
- [ ] Log in with email/password
- [ ] Enter valid 6-digit authenticator code
- [ ] ✅ Verify you're redirected to `/chat` (not spinning forever)

### Test Recovery Code Setup
- [ ] Enable 2FA on a fresh account
- [ ] ✅ Verify 10 recovery codes are displayed
- [ ] ✅ Verify "Copy All Codes" button works
- [ ] Check database: `SELECT * FROM mfa_recovery_codes WHERE user_id = '<your-user-id>'`
- [ ] ✅ Verify 10 codes exist in database (as hashes)

### Test Recovery Code Login
- [ ] Have 2FA enabled with recovery codes saved
- [ ] Log out
- [ ] Log in with email/password
- [ ] Click "Use recovery code instead"
- [ ] Enter one of your recovery codes
- [ ] ✅ Verify you're logged in
- [ ] ✅ Verify you're redirected to `/settings/privacy`
- [ ] ✅ Verify you see a warning message about re-enabling 2FA
- [ ] ✅ Verify 2FA is now disabled (check settings)
- [ ] Check database: `SELECT * FROM mfa_recovery_codes WHERE user_id = '<your-user-id>' AND used_at IS NOT NULL`
- [ ] ✅ Verify the recovery code is marked as used

### Test Invalid Recovery Code
- [ ] Try to use the same recovery code twice
- [ ] ✅ Verify you get "Invalid or already used recovery code" error
- [ ] Try to use a completely invalid code
- [ ] ✅ Verify you get an error message

### Test Recovery Code Deletion
- [ ] Enable 2FA and save recovery codes
- [ ] Disable 2FA
- [ ] Check database: `SELECT * FROM mfa_recovery_codes WHERE user_id = '<your-user-id>'`
- [ ] ✅ Verify all recovery codes are deleted

## User Experience Flow

```
┌─────────────────────────────────────────┐
│  User Enables 2FA                       │
│  ↓                                      │
│  Scans QR Code                          │
│  ↓                                      │
│  Verifies with 6-digit code             │
│  ↓                                      │
│  ✅ 10 Recovery Codes Displayed         │
│  ↓                                      │
│  User saves codes (prints/copies)       │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  User Loses Authenticator App           │
│  ↓                                      │
│  Logs in with email/password            │
│  ↓                                      │
│  2FA prompt appears                     │
│  ↓                                      │
│  Clicks "Use recovery code instead"     │
│  ↓                                      │
│  Enters 8-character recovery code       │
│  ↓                                      │
│  ✅ Logged in successfully              │
│  ↓                                      │
│  🔓 2FA disabled (lost authenticator)   │
│  ↓                                      │
│  Redirected to settings                 │
│  ↓                                      │
│  Re-enables 2FA with new authenticator  │
│  ↓                                      │
│  Gets new set of recovery codes         │
└─────────────────────────────────────────┘
```

## Security Considerations

1. **Hashing**: Recovery codes are hashed with SHA-256 before storage
2. **One-time use**: Each recovery code can only be used once
3. **Automatic disable**: Using a recovery code disables 2FA to prevent abuse
4. **RLS policies**: Row Level Security ensures users can only access their own codes
5. **No plaintext storage**: Recovery codes are never stored in plaintext

## Future Enhancements

Potential improvements for future versions:

1. **Download recovery codes**: Allow users to download codes as a text file
2. **Email recovery codes**: Option to email recovery codes to user
3. **View remaining codes**: Show count of unused recovery codes in settings
4. **Regenerate codes**: Allow users to regenerate recovery codes without disabling 2FA
5. **Recovery code expiry**: Optional expiry date for recovery codes

## Troubleshooting

### Recovery codes not being saved
- Check that the database function `save_recovery_codes` exists
- Verify the user has permission to execute the function
- Check browser console for RPC errors

### Can't log in with recovery code
- Verify the recovery code is exactly 8 characters (uppercase)
- Check if the code has already been used: `SELECT * FROM mfa_recovery_codes WHERE user_id = '<user-id>' AND used_at IS NOT NULL`
- Ensure the user has an AAL1 session (logged in with password)

### 2FA not being disabled after recovery code use
- Check that the `unenroll` call is succeeding
- Verify the factor ID is correct
- Check browser console for errors

## Related Files

- `db_schema/mfa_recovery_codes.sql` - Database schema and functions
- `src/components/AuthComponent.vue` - Login and 2FA verification
- `src/components/settings/user/PrivacySettings.vue` - 2FA setup and management
- `src/stores/auth.ts` - Authentication store
- `docs/2FA_RECOVERY_IMPLEMENTATION.md` - This document

## Support

If you encounter any issues:
1. Check the browser console for errors
2. Check the Supabase logs for RPC errors
3. Verify the database schema is correctly applied
4. Test with a fresh user account

