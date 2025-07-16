# activitypub Configuration

**File:** `src/config/activitypub.ts`

## Overview

```mermaid
graph TB
    subgraph "activitypub Configuration"
        ACTIVITYPUB_CONFIG[ACTIVITYPUB_CONFIG]
        ACTIVITYPUBACTOR[ActivityPubActor]
        WEBFINGERRESPONSE[WebFingerResponse]
        NODEINFORESPONSE[NodeInfoResponse]
        GETACTORURL[getActorUrl]
        GETWEBFINGERRESOURCE[getWebfingerResource]
        ISLOCALACTOR[isLocalActor]
        GENERATEACTORJSON[generateActorJson]
        GENERATEWEBFINGERJSON[generateWebFingerJson]
        GENERATENODEINFOJSON[generateNodeInfoJson]
        WANTSACTIVITYPUB[wantsActivityPub]
        WANTSWEBFINGER[wantsWebFinger]
        DEFAULT[default]
    end
    
    subgraph "Functions"
        GETACTORURL[getActorUrl()]
        GETWEBFINGERRESOURCE[getWebfingerResource()]
        ISLOCALACTOR[isLocalActor()]
        GENERATEACTORJSON[generateActorJson()]
        GENERATEWEBFINGERJSON[generateWebFingerJson()]
        GENERATENODEINFOJSON[generateNodeInfoJson()]
        WANTSACTIVITYPUB[wantsActivityPub()]
        WANTSWEBFINGER[wantsWebFinger()]
    end
    
    subgraph "Interfaces"
        EXPORT[export]
        EXPORT[export]
        EXPORT[export]
    end
```

## Exports

- **ACTIVITYPUB_CONFIG** - No description
- **ActivityPubActor** - No description
- **WebFingerResponse** - No description
- **NodeInfoResponse** - No description
- **getActorUrl** - No description
- **getWebfingerResource** - No description
- **isLocalActor** - No description
- **generateActorJson** - No description
- **generateWebFingerJson** - No description
- **generateNodeInfoJson** - No description
- **wantsActivityPub** - No description
- **wantsWebFinger** - No description
- **default** - No description

## Functions

### `getActorUrl(username: string)`

No description available.

**Parameters:**
- `username: string`

**Returns:** Unknown

```typescript
export function getActorUrl(username: string): string {
```

### `getWebfingerResource(username: string)`

No description available.

**Parameters:**
- `username: string`

**Returns:** Unknown

```typescript
export function getWebfingerResource(username: string): string {
```

### `isLocalActor(actorUrl: string)`

No description available.

**Parameters:**
- `actorUrl: string`

**Returns:** Unknown

```typescript
export function isLocalActor(actorUrl: string): boolean {
```

### `generateActorJson(user: FederatedUser)`

No description available.

**Parameters:**
- `user: FederatedUser`

**Returns:** Unknown

```typescript
export function generateActorJson(user: FederatedUser): ActivityPubActor {
```

### `generateWebFingerJson(username: string)`

No description available.

**Parameters:**
- `username: string`

**Returns:** Unknown

```typescript
export function generateWebFingerJson(username: string): WebFingerResponse {
```

### `generateNodeInfoJson(stats?: {
  userCount?: number;
  postCount?: number;
  activeMonth?: number;
  activeHalfyear?: number;
})`

No description available.

**Parameters:**
- `stats?: {
  userCount?: number;
  postCount?: number;
  activeMonth?: number;
  activeHalfyear?: number;
}`

**Returns:** Unknown

```typescript
export function generateNodeInfoJson(stats?: {
  userCount?: number;
  postCount?: number;
  activeMonth?: number;
  activeHalfyear?: number;
}): NodeInfoResponse {
```

### `wantsActivityPub(acceptHeader: string)`

No description available.

**Parameters:**
- `acceptHeader: string`

**Returns:** Unknown

```typescript
export function wantsActivityPub(acceptHeader: string): boolean {
```

### `wantsWebFinger(acceptHeader: string)`

No description available.

**Parameters:**
- `acceptHeader: string`

**Returns:** Unknown

```typescript
export function wantsWebFinger(acceptHeader: string): boolean {
```




## Interfaces

### export

No description available.

```typescript
interface
export interface ActivityPubActor {
  '@context': string | string[];
  id: string;
  type: 'Person' | 'Service' | 'Group';
  preferredUsername: string;
  name?: string;
  summary?: string;
  icon?: {
    type: 'Image';
    mediaType: string;
    url: string;
  }
```

### export

No description available.

```typescript
interface
export interface WebFingerResponse {
  subject: string;
  links: Array<{
    rel: string;
    type?: string;
    href: string;
  }
```

### export

No description available.

```typescript
interface
export interface NodeInfoResponse {
  version: string;
  software: {
    name: string;
    version: string;
    repository?: string;
  }
```




## Constants

### ACTIVITYPUB_CONFIG

No description available.

```typescript
export const ACTIVITYPUB_CONFIG = {
```


## Source Code Insights

**File Size:** 5732 characters
**Lines of Code:** 234
**Imports:** 1

## Usage Example

```typescript
import { ACTIVITYPUB_CONFIG, ActivityPubActor, WebFingerResponse, NodeInfoResponse, getActorUrl, getWebfingerResource, isLocalActor, generateActorJson, generateWebFingerJson, generateNodeInfoJson, wantsActivityPub, wantsWebFinger, default } from '@/config/activitypub.ts'

// Example usage
getActorUrl()
```

---

*This documentation was automatically generated from the source code.*