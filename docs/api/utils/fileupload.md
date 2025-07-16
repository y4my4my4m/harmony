# fileUpload Utility

**File:** `src/utils/fileUpload.ts`

## Overview

```mermaid
graph TB
    subgraph "fileUpload Utility"
        UPLOADRESULT[UploadResult]
    end
    
    subgraph "Functions"
        UPLOADFILE[uploadFile()]
        UPLOADAVATAR[uploadAvatar()]
        UPLOADSERVERICON[uploadServerIcon()]
        DELETEFILE[deleteFile()]
    end
    
    subgraph "Interfaces"
        UPLOADRESULT[UploadResult]
    end
```

## Exports

- **UploadResult** - No description

## Functions

### `uploadFile(file: File, bucket: string, path: string)`

No description available.

**Parameters:**
- `file: File`
- `bucket: string`
- `path: string`

**Returns:** Unknown

```typescript
export async function uploadFile(
  file: File,
  bucket: string,
  path: string
): Promise<UploadResult> {
```

### `uploadAvatar(file: File, userId: string)`

No description available.

**Parameters:**
- `file: File`
- `userId: string`

**Returns:** Unknown

```typescript
export async function uploadAvatar(file: File, userId: string): Promise<UploadResult> {
```

### `uploadServerIcon(file: File, serverId: string)`

No description available.

**Parameters:**
- `file: File`
- `serverId: string`

**Returns:** Unknown

```typescript
export async function uploadServerIcon(file: File, serverId: string): Promise<UploadResult> {
```

### `deleteFile(bucket: string, path: string)`

No description available.

**Parameters:**
- `bucket: string`
- `path: string`

**Returns:** Unknown

```typescript
export async function deleteFile(bucket: string, path: string): Promise<boolean> {
```




## Interfaces

### UploadResult

No description available.

```typescript
export interface UploadResult {
  success: boolean;
  url?: string;
  path?: string;
  error?: string;
}
```






## Source Code Insights

**File Size:** 3409 characters
**Lines of Code:** 133
**Imports:** 1

## Usage Example

```typescript
import { UploadResult } from '@/utils/fileUpload.ts'

// Example usage
uploadFile()
```

---

*This documentation was automatically generated from the source code.*