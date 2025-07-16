# permissionsService Service

**File:** `src/services/permissionsService.ts`

## Overview

```mermaid
graph TB
    subgraph "permissionsService Service"
        SERVERSETTINGS[ServerSettings]
        USERPERMISSIONS[UserPermissions]
    end
    
    subgraph "Functions"
        GETUSERPERMISSIONS[getUserPermissions()]
        GETSERVERSETTINGS[getServerSettings()]
        UPDATESERVERSETTINGS[updateServerSettings()]
        GETDEFAULTSERVERSETTINGS[getDefaultServerSettings()]
        CANUSERCREATEINVITES[canUserCreateInvites()]
        GETINVITECONSTRAINTS[getInviteConstraints()]
    end
    
    subgraph "Interfaces"
        SERVERSETTINGS[ServerSettings]
        USERPERMISSIONS[UserPermissions]
    end
```

## Exports

- **ServerSettings** - No description
- **UserPermissions** - No description

## Functions

### `getUserPermissions(userId: string, serverId: string)`

No description available.

**Parameters:**
- `userId: string`
- `serverId: string`

**Returns:** Unknown

```typescript
async function getUserPermissions(userId: string, serverId: string): Promise<UserPermissions> {
```

### `getServerSettings(serverId: string)`

No description available.

**Parameters:**
- `serverId: string`

**Returns:** Unknown

```typescript
async function getServerSettings(serverId: string): Promise<ServerSettings | null> {
```

### `updateServerSettings(serverId: string, settings: Partial<ServerSettings>)`

No description available.

**Parameters:**
- `serverId: string`
- `settings: Partial<ServerSettings>`

**Returns:** Unknown

```typescript
async function updateServerSettings(serverId: string, settings: Partial<ServerSettings>): Promise<boolean> {
```

### `getDefaultServerSettings(serverId: string)`

No description available.

**Parameters:**
- `serverId: string`

**Returns:** Unknown

```typescript
function getDefaultServerSettings(serverId: string): ServerSettings {
```

### `canUserCreateInvites(userId: string, serverId: string)`

No description available.

**Parameters:**
- `userId: string`
- `serverId: string`

**Returns:** Unknown

```typescript
async function canUserCreateInvites(userId: string, serverId: string): Promise<boolean> {
```

### `getInviteConstraints(userId: string, serverId: string)`

No description available.

**Parameters:**
- `userId: string`
- `serverId: string`

**Returns:** Unknown

```typescript
async function getInviteConstraints(userId: string, serverId: string): Promise<{
```




## Interfaces

### ServerSettings

No description available.

```typescript
export interface ServerSettings {
  id: string
  server_id: string
  invite_permissions: {
    who_can_create: 'everyone' | 'roles' | 'administrators'
    allowed_roles?: string[]
    default_expiration: number // minutes, 0 = never
    max_expiration: number // minutes, 0 = no limit
    allow_temporary: boolean
    max_uses_limit: number // 0 = no limit
  }
```

### UserPermissions

No description available.

```typescript
export interface UserPermissions {
  userId: string
  serverId: string
  permissions: ServerPermission[]
  roles: string[]
  isOwner: boolean
  isAdmin: boolean
}
```






## Source Code Insights

**File Size:** 7364 characters
**Lines of Code:** 275
**Imports:** 1

## Usage Example

```typescript
import { ServerSettings, UserPermissions } from '@/services/permissionsService.ts'

// Example usage
getUserPermissions()
```

---

*This documentation was automatically generated from the source code.*