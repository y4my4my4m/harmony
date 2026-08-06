# 2FA Security Model

Scope: TOTP second factor and recovery codes for Harmony's Supabase-backed auth.
Covers what is enforced at each entry point, what a session is allowed to do
afterwards, and where enforcement is currently incomplete.

## Assurance levels

Supabase encodes the assurance level in the access token, not on the user
object. `authStore.getAAL()` (`src/stores/auth.ts`) decodes the JWT and reads
the `aal` claim.

- `aal1` - password, OAuth, or recovery-link sign-in.
- `aal2` - `aal1` plus a verified TOTP challenge.

The JWT also carries `amr` (Authentication Methods References), a list of the
methods the session was authenticated with: `password`, `oauth`, `totp`.
`authStore.getAMR()` normalises both the GoTrue object form
(`{ method, timestamp }`) and the plain-string form. AMR is session metadata and
survives token refresh, so a session that once completed TOTP keeps `totp` in
`amr` after its AAL drops back to `aal1`.

Supabase requires `aal2` for `mfa.unenroll`. It rejects lower-AAL calls with
`error_code: 'insufficient_aal'`.

## Session admission: validateSessionForMFA

`validateSessionForMFA(session)` in `src/stores/auth.ts` decides whether a
session found in storage may be adopted into the Pinia store. It runs on
`initializeAuth`, and on the `SIGNED_IN`, `INITIAL_SESSION`, and catch-all
(`TOKEN_REFRESHED`) branches of `onAuthStateChange`.

Accepted:

- `aal2`.
- `aal1` and `amr` contains `totp` - MFA was completed on this session and the
  AAL2 window has since lapsed.
- `aal1`, no `totp` in `amr`, and `mfa.listFactors()` reports no verified TOTP
  factor - the user has no second factor.

Rejected:

- `aal1`, no `totp` in `amr`, and a verified TOTP factor exists. This is a
  sign-in that has not completed its challenge.
- Any error from `listFactors`. Fails closed.

Rejection tears the session down: `supabase.auth.signOut()`, `session = null`.
Leaving it in storage would let another tab adopt it.

The AMR test is what separates a long-lived post-MFA session from a mid-login
AAL1 session. Without it, the cross-tab sequence - tab B starts a password login
for an MFA user, tab A refreshes and picks the AAL1 token out of shared storage -
grants tab A access as the MFA user. With it, tab A sees `amr` without `totp` and
signs out.

`_pendingMFAVerification` suppresses these checks while a challenge is in
flight; see the ordering constraint below.

## Password login

`AuthComponent.vue` -> `authStore.login()`.

1. `_pendingMFAVerification = true`.
2. `signInWithPassword` - yields an `aal1` session.
3. Suspension check against `profiles.is_suspended`; suspended users are signed
   out.
4. `mfa.listFactors()`. No verified TOTP factor: the store adopts the session,
   runs post-login setup, returns `requires2FA: false`.
5. A verified factor: `mfa.challenge(factorId)`, return
   `{ requires2FA: true, factorId, challengeId }`. The view opens the 2FA modal.
   The session is not adopted.

### Flag ordering

`_pendingMFAVerification` must be set before `signInWithPassword`, not inside the
`if (totpFactor)` branch. `signInWithPassword` queues `SIGNED_IN` as a microtask;
the awaits for the suspension query and `listFactors` yield to it. With the flag
still false, the `SIGNED_IN` handler runs `validateSessionForMFA` against a fresh
`aal1` session for an MFA-enrolled user, rejects it, and signs out. `listFactors`
then finds nothing, `login()` reports `requires2FA: false`, and the caller
navigates to `/chat` with a null session. The same ordering applies in
`AuthCallbackView.vue` before its inline challenge.

Every failure path in `login()` clears the flag. `verify2FA()` clears it once
verification completes.

### TOTP verification

`authStore.verify2FA()` calls `mfa.verify` under a 30s timeout race, waits 500ms,
re-reads the session (now `aal2`), and adopts it. It repeats the work the
`SIGNED_IN` handler would have done - `userStorage.setCurrentUser`,
offline handlers, user settings, ActivityPub init - because the
`MFA_CHALLENGE_VERIFIED` event handler only installs offline handlers.

Cancelling the modal signs the pending `aal1` session out immediately rather than
waiting for the next page load to reject it.

### Recovery code

`AuthComponent.vue` calls the SECURITY DEFINER RPC
`redeem_recovery_code_and_disable_mfa(p_code)`
(`db_schema/migrations/20260703_recovery_code_mfa_unenroll_rpc.sql`). In one
transaction it hashes the code, claims a matching unused row with
`UPDATE ... RETURNING` over `SELECT ... FOR UPDATE SKIP LOCKED`, and only on a
successful claim runs `DELETE FROM auth.mfa_factors WHERE user_id = auth.uid()`.
No factor is removed unless a valid code was burned in the same transaction, so
the enforcement point is server-side. The client then refreshes the session and
routes to `/settings/privacy` to re-enrol.

## OAuth callback

`initializeAuth` does not adopt sessions on `/auth/callback`. Supabase's
`detectSessionInUrl` exchanges the code at client-construction time, before the
store initialises, so the session already exists at `aal1`; validating it there
would sign MFA users out before `AuthCallbackView` could challenge them. The
store sets `_pendingMFAVerification` and leaves the token in storage for the view
to read.

`AuthCallbackView.vue` runs the suspension check, then
`validateSessionForMFA`. On rejection it lists factors: a verified TOTP factor
means the recoverable "needs MFA" state and the view challenges inline; anything
else signs out and routes to login. TOTP verification goes through
`authStore.verify2FA`, same as password login.

The recovery-code branch calls `verify_recovery_code` and then
`supabase.auth.mfa.unenroll()` from the client on an `aal1` session.

## Password reset

`ResetPasswordView.vue` holds a recovery-token session. `checkMFAStatus()` sets
`requiresMFA` from `listFactors`; a `listFactors` error is treated as "not
enrolled". With MFA required, submitting the new password opens a challenge modal
instead of calling `updateUser` directly.

TOTP branch: `mfa.verify` raises the session to `aal2`, then
`performPasswordReset()` runs `updateUser`. On success the recovery session is
signed out and the user logs in again with the new password.

Recovery-code branch: `verify_recovery_code`, then client-side
`mfa.unenroll()`, then the password reset. Same shape as the OAuth callback.

## Disabling 2FA from settings

`src/components/settings/user/PrivacySettings.vue`, `disable2FA()`.

TOTP branch: `mfa.challengeAndVerify` creates a challenge for the existing factor
and verifies it in one call, leaving the session at `aal2` - the level
`mfa.unenroll` requires.

Recovery-code branch: `verify_recovery_code` marks the code used, then unenroll
proceeds without a step-up. If the session is below `aal2`, Supabase rejects the
unenroll with `insufficient_aal` and the user is told to sign in again with 2FA.

Both branches delete `mfa_recovery_codes` rows before `mfa.unenroll`. Reversing
that order can leave codes behind that no longer correspond to any factor and
cannot be regenerated.

## Enrolment and recovery codes

`mfa.enroll({ factorType: 'totp' })` produces the secret and otpauth URI; the URI
is rendered as a QR code. `challengeAndVerify` confirms the first code, and the
factor status is re-read from `listFactors` because `challengeAndVerify` can
return without error on an unverified factor.

Ten recovery codes are then generated client-side from
`crypto.getRandomValues(new Uint8Array(5))`, rendered as uppercase hex: 40 bits
of entropy each. `save_recovery_codes(p_user_id, p_codes)` replaces any existing
batch and stores `encode(digest(code, 'sha256'), 'hex')` - plaintext codes exist
only in the browser at enrolment time.

`public.mfa_recovery_codes` (`db_schema/init/09_tables_encryption.sql`) keys on
`profiles(id)`, not `auth.users(id)`, and carries `code_hash`, `used_at`,
`is_used`, `batch_id`. RLS restricts rows to their owner.

`verify_recovery_code(p_user_id, p_code)` is SECURITY DEFINER and raises when
`p_user_id` differs from `auth.uid()`; the definer context bypasses RLS, so the
identity check is explicit. It marks the matching unused row used and returns
whether one was found. It does not touch MFA factors.

Note: generated codes are 10 hex characters, while every entry field and length
check in the UI expects 8.

## Session lifetime

`src/supabase.ts` configures `persistSession: true` and `autoRefreshToken: true`
over a custom storage adapter. The adapter routes the session token to
`localStorage` when "remember me" is on and `sessionStorage` when it is off; the
preference itself lives in `localStorage` and is read on every write. The login
form must call `setRememberMe()` before `signInWithPassword`, otherwise the
freshly issued token lands in the wrong store.

2FA gates sign-in, not the session that follows. Once a session has completed
TOTP verification, it keeps `totp` in `amr` and is admitted at `aal1` for as long
as its refresh token stays valid. Re-authentication is required after an explicit
logout, refresh-token expiry, or cleared browser storage. Concrete AAL2 and
refresh-token lifetimes are Supabase project settings and are not asserted here.

There is no step-up requirement for sensitive operations outside the 2FA settings
themselves, and no trusted-device mechanism.

## Verifying the behaviour

For a manual pass, enrol an account and confirm each of:

- Signing in with the password alone stops at the challenge modal; cancelling it
  leaves no `sb-*-auth-token` in storage.
- After a successful TOTP login, decoding the access token shows `aal2` and an
  `amr` containing `totp`; reloading the page does not re-prompt.
- Forcing an `aal1` token whose `amr` lacks `totp` into storage and reloading
  results in a signed-out tab.
- A recovery code used at password login is rejected on second use, and the
  account's TOTP factor is gone from settings afterwards.

## Known gap

Recovery-code redemption on the OAuth-callback and password-reset paths verifies
the code and then unenrols the factor from the client on an `aal1` session, so
the enforcement point is the client rather than the database. Tracked as
BUGS.md H8 (= C11); the fix is to route both through
`redeem_recovery_code_and_disable_mfa`, as the password-login path already does.

## Related files

- `src/stores/auth.ts` - AAL/AMR decoding, `validateSessionForMFA`, login,
  `verify2FA`, auth-state handling
- `src/components/AuthComponent.vue` - password login and 2FA modal
- `src/views/AuthCallbackView.vue` - OAuth callback MFA challenge
- `src/views/ResetPasswordView.vue` - password reset MFA challenge
- `src/components/settings/user/PrivacySettings.vue` - enrolment and disable
- `src/supabase.ts` - session storage adapter
- `db_schema/init/09_tables_encryption.sql` - `mfa_recovery_codes`
- `db_schema/init/13_functions_rpc_extended.sql` - `save_recovery_codes`,
  `verify_recovery_code`
- `db_schema/migrations/20260703_recovery_code_mfa_unenroll_rpc.sql` -
  `redeem_recovery_code_and_disable_mfa`
- `docs/SUPABASE_MFA_AAL_GUIDE.md`
