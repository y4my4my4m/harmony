# 2FA Security Model

Scope: TOTP second factor, recovery codes, sessions and the account operations that
depend on them. Covers what is enforced where, and what a session may do afterwards.

## Assurance levels

GoTrue writes the assurance level into the access token. `authStore.getAAL()`
(`src/stores/auth.ts`) decodes the JWT and reads the `aal` claim.

- `aal1` - password, OAuth, or recovery-link sign-in.
- `aal2` - `aal1` plus a verified TOTP challenge.

The `amr` claim lists the methods the session was authenticated with (`password`,
`oauth`, `totp`), each with an epoch-second `timestamp`. `authStore.getAMR()` normalises
the object and plain-string forms.

GoTrue v2.182.1 (production) behaviour, observed against the image:

- A verified TOTP challenge raises the session to `aal2` and deletes every other `aal1`
  session of the account. Enrolment verification does the same, so turning 2FA on signs
  out the account's other devices.
- `aal2` survives token refresh for the life of the session. There is no expiry back to
  `aal1`.
- A second verify on an `aal2` session refreshes the `totp` timestamp in `amr`.
- A password change through `PUT /user` deletes every other session of the account.
- `mfa.unenroll` and password changes require `aal2` when a verified factor exists.

## Enforcement in the database

`db_schema/migrations/20261005400001_account_security.sql`.

A correct password yields an `aal1` session before the TOTP challenge. Before this
migration PostgREST accepted it, so the second factor gated the web UI only; a client
talking to the API directly read and wrote everything RLS allowed.

- `public.session_meets_aal()` - false for an authenticated request of an account with a
  verified factor whose token is not `aal2`.
- `public.enforce_request_assurance()` - PostgREST `db-pre-request`, set as
  `pgrst.db_pre_request` on the `authenticator` role. Answers `401 session_revoked` when
  the token's `session_id` is no longer in `auth.sessions`, and `403 insufficient_aal`
  when `session_meets_aal()` is false. `/rpc/redeem_recovery_code_and_disable_mfa` is the
  one path open below `aal2`.
- Restrictive policies on `public.messages` (SELECT; postgres_changes), `realtime.messages`
  (private channel join and send) and `storage.objects` apply the same predicate to the
  paths that do not pass through PostgREST.
- The federation backend and bot-gateway refuse such tokens in their own bearer checks
  (`federation-backend/src/utils/sessionAssurance.ts`).

Every PostgREST request fails while `pgrst.db_pre_request` names a function that does not
exist. Dropping the function means resetting the role setting first.

## Session admission in the client

`validateSessionForMFA(session)` decides whether a session found in storage may be adopted
into the Pinia store. It runs on `initializeAuth` and the `SIGNED_IN`, `INITIAL_SESSION`
and catch-all branches of `onAuthStateChange`.

Accepted: `aal2`; `aal1` with `totp` in `amr`; `aal1` with no verified factor.
Rejected: `aal1` without `totp` while a verified factor exists, and any `listFactors`
error. Rejection signs the session out so another tab cannot adopt it.

`_pendingMFAVerification` suppresses these checks while a challenge is in flight. It must
be set before `signInWithPassword`: the awaits that follow yield to the queued
`SIGNED_IN`, which would otherwise reject and sign out the session the challenge needs.

`src/supabase.ts` passes PostgREST responses through a fetch wrapper; a
`session_revoked` or `insufficient_aal` body calls `authStore.handleSessionRejected`, which
drops the local session and returns to `/login` with the reason. Refusals during a pending
challenge are ignored.

## Sign-in

Password (`AuthComponent.vue` -> `authStore.login()`), OAuth (`AuthCallbackView.vue`) and
password reset (`ResetPasswordView.vue`) share the challenge.

- TOTP: `authStore.verify2FA()` verifies under a 30 s timeout. A challenge GoTrue expired
  (five minutes) is replaced once and the code checked again. On success
  `finalizeSignIn()` checks suspension (readable only at `aal2`) and runs the post-login
  setup the `SIGNED_IN` handler would have run.
- Recovery code: `authStore.completeRecoverySignIn()` calls
  `redeem_recovery_code_and_disable_mfa`, which consumes the code, deletes the account's
  factors and its remaining codes in one transaction. With no factor left the `aal1`
  session is a full session; the user is sent to Security to enrol again. The password
  reset view redeems the same way before setting the new password.

Cancelling the challenge signs the pending `aal1` session out.

## Recovery codes

- `generate_mfa_recovery_codes()` returns ten codes of ten Crockford base32 characters
  (50 bits), shown as `XXXXX-XXXXX`, once. It requires `aal2` and a TOTP verify within ten
  minutes. Earlier codes are deleted.
- Stored as SHA-256 of the normalised code: separators stripped, upper-cased, `O` -> `0`,
  `I`/`L` -> `1`. Codes from earlier releases (8 or 10 upper-case hex characters)
  normalise to themselves.
- `verify_recovery_code` and `redeem_recovery_code_and_disable_mfa` share an attempt
  budget: five failures per account in fifteen minutes, then `PT429 too_many_attempts`
  with `retry_after=<seconds>` in the details.
- `save_recovery_codes(p_user_id, p_codes)` remains for released clients that generate
  codes at enrolment. It requires `aal2` once a factor is verified, so an `aal1` session
  cannot plant codes it would then redeem.
- Removing the last verified factor deletes the account's codes (trigger on
  `auth.mfa_factors`).

## Sessions

`list_my_sessions()` and `revoke_my_session(id)` read and delete the caller's
`auth.sessions` rows; refresh tokens cascade, and the pre-request hook refuses the
revoked session's access token at once. Signing out every other device uses GoTrue's
`signOut({ scope: 'others' })`. `push_subscriptions.session_id` is written by the
federation backend at registration, and deleting a session removes its push targets.

## Security notices

Notifications of type `security` (`record_security_notice`): a sign-in while another
session exists, 2FA enabled or disabled (with `reason = recovery_code` when a code turned
it off), recovery codes regenerated or used, password changed. Triggers on GoTrue's tables
write them and never fail the GoTrue statement. Push delivery ignores `push_offline_only`
for this type.

## Step-up for destructive operations

`delete_my_account(p_password)` checks the password with pgcrypto against
`auth.users.encrypted_password` (shared five-in-fifteen-minutes budget with
`verify_my_password`, which gates the password form). Accounts without a password need a
sign-in within ten minutes. Enrolled accounts need a TOTP verify within ten minutes,
read from the `amr` timestamp.

## Related files

- `src/stores/auth.ts` - AAL/AMR decoding, session admission, `verify2FA`,
  `completeRecoverySignIn`, `finalizeSignIn`, `handleSessionRejected`
- `src/supabase.ts` - storage adapter, PostgREST rejection hook
- `src/components/settings/user/SecuritySettings.vue`, `TwoFactorSettings.vue`,
  `SessionsPanel.vue` - password, enrolment, recovery codes, devices
- `src/services/AccountSecurityService.ts`, `AccountDeletionService.ts`,
  `DataExportService.ts`
- `db_schema/migrations/20261005400001_account_security.sql`,
  `db_schema/tests/55_account_security.sql`
- `federation-backend/src/utils/sessionAssurance.ts`
