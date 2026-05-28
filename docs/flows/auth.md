# Authentication Flow

## Overview

Harmony uses Supabase Auth for authentication, supporting email/password, OAuth providers, and MFA (two-factor authentication). The auth state is managed by the `auth` Pinia store and `AuthContextService`.

## Registration Flow

```mermaid
sequenceDiagram
    participant U as User
    participant RV as RegisterView
    participant SA as Supabase Auth
    participant DB as Database
    participant AS as Auth Store

    U->>RV: Submit registration form
    RV->>SA: signUp(email, password)
    SA-->>RV: Session + User
    SA->>DB: Trigger: create profile
    DB-->>DB: INSERT into profiles
    RV->>AS: initializeAuth()
    AS->>AS: Set session
    AS->>AS: initializeEncryptionIfAvailable()
    AS->>AS: initializeNotificationSystem()
    RV-->>U: Redirect to profile setup
    U->>RV: Complete profile (NewProfile)
```

## Login Flow

```mermaid
sequenceDiagram
    participant U as User
    participant LV as LoginView
    participant SA as Supabase Auth
    participant AS as Auth Store
    participant ACS as AuthContextService

    U->>LV: Submit credentials
    LV->>SA: signInWithPassword(email, password)
    SA-->>LV: Session + User
    LV->>AS: SIGNED_IN event
    AS->>ACS: getCurrentProfileId()
    ACS->>ACS: Cache auth_user_id → profile_id
    AS->>AS: Check MFA requirement
    alt MFA enabled (AAL1 session)
        AS-->>U: Redirect to MFA challenge
        U->>AS: verify2FA(code)
        AS->>SA: verifyMFA()
        SA-->>AS: AAL2 session
    end
    AS->>AS: initializeEncryptionIfAvailable()
    AS->>AS: initializeNotificationSystem()
    AS-->>U: Redirect to app
```

## Session Management

```mermaid
flowchart TD
    LOAD[App Load] --> INIT["initializeAuth()"]
    INIT --> CHECK{Session exists?}
    CHECK -->|Yes| VALIDATE[Validate session]
    CHECK -->|No| LOGIN[Redirect to login]
    VALIDATE --> VALID{Valid?}
    VALID -->|Yes| MFA{MFA required?}
    VALID -->|No| REFRESH[Attempt token refresh]
    MFA -->|AAL2| READY[App ready]
    MFA -->|AAL1 only| CHALLENGE[MFA challenge]
    REFRESH --> REFRESHED{Refreshed?}
    REFRESHED -->|Yes| READY
    REFRESHED -->|No| LOGIN
    CHALLENGE --> VERIFIED{Verified?}
    VERIFIED -->|Yes| READY
    VERIFIED -->|No| LOGIN
```

### Token Refresh

Supabase handles JWT refresh automatically. The auth store listens for `TOKEN_REFRESHED` events and updates the cached session. A session cache (~5 seconds) prevents excessive `getSession()` calls.

### Auth State Events

The auth store listens to Supabase auth state changes:

| Event | Action |
|-------|--------|
| `SIGNED_IN` | Cache profile, init encryption, init notifications |
| `SIGNED_OUT` | Clear all state, lock encryption, set offline |
| `PASSWORD_RECOVERY` | Set password reset mode |
| `TOKEN_REFRESHED` | Update cached session |
| `USER_UPDATED` | Clear AuthContextService cache |
| `MFA_CHALLENGE_VERIFIED` | Clear MFA validation cache |
| `INITIAL_SESSION` | Initial load session setup |

## OAuth Flow

```mermaid
sequenceDiagram
    participant U as User
    participant AC as AuthComponent
    participant SA as Supabase Auth
    participant OP as OAuth Provider
    participant CB as AuthCallbackView

    U->>AC: Click OAuth provider button
    AC->>SA: signInWithOAuth(provider)
    SA-->>U: Redirect to provider
    U->>OP: Authorize
    OP-->>CB: Redirect with code
    CB->>SA: Exchange code for session
    SA-->>CB: Session + User
    CB->>CB: initializeAuth()
    CB-->>U: Redirect to app
```

Supported providers are configured via `VITE_ENABLED_OAUTH_PROVIDERS` (e.g., `google,github,twitch`).

## Logout Flow

```mermaid
sequenceDiagram
    participant U as User
    participant AS as Auth Store
    participant SA as Supabase Auth
    participant UDS as userDataService
    participant ENC as Encryption

    U->>AS: logout()
    AS->>UDS: Set status offline
    AS->>SA: signOut()
    SA-->>AS: SIGNED_OUT event
    AS->>AS: Clear profile, theme, ActivityPub cache
    AS->>ENC: Lock encryption
    AS->>AS: Clear all Pinia stores
    AS-->>U: Redirect to login
```

## AuthContextService

`AuthContextService` is a singleton that caches the mapping from `auth_user_id` to `profile_id`:

- `getCurrentProfileId()` - Returns the profile ID, using cache when available
- `getCurrentAuthUser()` - Returns the Supabase auth user
- `isAuthenticated()` - Check if a valid session exists
- Cache is cleared on `SIGNED_OUT`, `USER_UPDATED`, and relevant `SIGNED_IN` events

This service is used by all other services that need to identify the current user, avoiding redundant database queries.

---

*See also: [Real-time Updates](./realtime) for how auth state changes affect realtime subscriptions.*
