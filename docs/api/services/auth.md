# Authentication Service

The Authentication Service handles user authentication, session management, and security-related operations throughout the Harmony application.

## Overview

The `authService` provides a centralized API for all authentication operations, integrating with Supabase Auth to provide secure user management.

```typescript
import { authService } from '@/services/authService'
```

## Core Methods

### `login(email: string, password: string)`

Authenticates a user with email and password.

**Parameters:**
- `email: string` - User's email address
- `password: string` - User's password

**Returns:** `Promise<AuthResponse>`

**Example:**
```typescript
try {
  const response = await authService.login('user@example.com', 'password')
  if (response.user) {
    // Login successful
    console.log('Welcome', response.user.email)
  }
} catch (error) {
  console.error('Login failed:', error.message)
}
```

### `register(email: string, password: string, metadata?: object)`

Creates a new user account.

**Parameters:**
- `email: string` - User's email address
- `password: string` - User's password
- `metadata?: object` - Optional user metadata

**Returns:** `Promise<AuthResponse>`

**Example:**
```typescript
const newUser = await authService.register(
  'newuser@example.com', 
  'securepassword',
  { firstName: 'John', lastName: 'Doe' }
)
```

### `logout()`

Signs out the current user and cleans up session data.

**Returns:** `Promise<void>`

**Example:**
```typescript
await authService.logout()
// User is now logged out
```

### `getCurrentUser()`

Gets the currently authenticated user.

**Returns:** `User | null`

**Example:**
```typescript
const user = authService.getCurrentUser()
if (user) {
  console.log('Current user:', user.email)
}
```

### `getSession()`

Gets the current authentication session.

**Returns:** `Session | null`

**Example:**
```typescript
const session = authService.getSession()
if (session) {
  console.log('Session expires:', session.expires_at)
}
```

## Session Management

### Automatic Token Refresh

The service automatically handles token refresh:

```typescript
// Token refresh happens automatically
// No manual intervention required
authService.onTokenRefresh((newSession) => {
  console.log('Token refreshed')
})
```

### Session Persistence

Sessions are automatically persisted across browser sessions:

```typescript
// Check for existing session on app startup
authService.initialize()
  .then((session) => {
    if (session) {
      // User is still logged in
      redirectToApp()
    } else {
      // User needs to log in
      redirectToLogin()
    }
  })
```

## Security Features

### Password Requirements

Passwords must meet these requirements:
- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character

```typescript
const passwordValid = authService.validatePassword('MyPassword123!')
// Returns: { valid: true, errors: [] }
```

### Rate Limiting

The service implements rate limiting for security:
- Login attempts: 5 per minute
- Registration: 3 per hour
- Password reset: 2 per hour

### Two-Factor Authentication

Support for TOTP-based 2FA:

```typescript
// Enable 2FA
const qrCode = await authService.enable2FA()

// Verify 2FA setup
const verified = await authService.verify2FA('123456')

// Login with 2FA
await authService.loginWith2FA('user@example.com', 'password', '123456')
```

## Error Handling

Common error types:

```typescript
try {
  await authService.login(email, password)
} catch (error) {
  switch (error.code) {
    case 'invalid_credentials':
      showError('Invalid email or password')
      break
    case 'email_not_confirmed':
      showError('Please confirm your email address')
      break
    case 'too_many_requests':
      showError('Too many login attempts. Please try again later.')
      break
    default:
      showError('Login failed. Please try again.')
  }
}
```

## Integration with Stores

The Authentication Service integrates seamlessly with the Auth Store:

```typescript
// In a component
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()

// Login through store (uses authService internally)
await authStore.login(email, password)

// Check authentication status
const isLoggedIn = authStore.isLoggedIn
const currentUser = authStore.currentUser
```

## Real-time Features

### Presence Updates

Authentication integrates with presence system:

```typescript
authService.onLogin((user) => {
  // User comes online
  presenceService.setOnline(user.id)
})

authService.onLogout((user) => {
  // User goes offline
  presenceService.setOffline(user.id)
})
```

### Session Events

Listen for authentication events:

```typescript
authService.onAuthStateChange((event, session) => {
  switch (event) {
    case 'SIGNED_IN':
      console.log('User signed in')
      break
    case 'SIGNED_OUT':
      console.log('User signed out')
      break
    case 'TOKEN_REFRESHED':
      console.log('Token refreshed')
      break
  }
})
```

## Admin Features

Administrative authentication operations:

```typescript
// Check if user has admin privileges
const isAdmin = await authService.isAdmin(userId)

// Promote user to admin (admin only)
await authService.promoteToAdmin(userId)

// Suspend user account (admin only)
await authService.suspendUser(userId, reason)
```

## Testing

Example unit test:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { authService } from '@/services/authService'

describe('AuthService', () => {
  it('should login with valid credentials', async () => {
    const mockUser = { id: '1', email: 'test@example.com' }
    vi.spyOn(authService, 'login').mockResolvedValue({ user: mockUser })
    
    const result = await authService.login('test@example.com', 'password')
    expect(result.user).toEqual(mockUser)
  })
})
```

## Related Documentation

- [Auth Store API](/api/stores/auth) - Pinia store for authentication state
- [View types](/api/types/viewtypes) - selected UI-related TypeScript types
- [Authentication Flow](/flows/auth) - System flow diagrams
- [2FA security model](/2FA_SECURITY_MODEL) - MFA / AAL notes for auth flows

## Configuration

Authentication configuration in environment variables:

```env
# Supabase Auth Configuration
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key

# Auth Settings
VITE_AUTH_PASSWORD_MIN_LENGTH=8
VITE_AUTH_ENABLE_2FA=true
VITE_AUTH_SESSION_TIMEOUT=86400
```

---

The Authentication Service provides a robust, secure foundation for user management in Harmony, with comprehensive error handling, real-time features, and seamless integration with the rest of the application architecture.
