# fileService Service

**File:** `src/services/fileService.ts`

## Overview

```mermaid
graph TB
    subgraph "fileService Service"
        UPLOADPROGRESSCALLBACK[UploadProgressCallback]
        BACKGROUNDUPLOADMANAGER[backgroundUploadManager]
    end
    
    subgraph "Functions"
        HANDLEFILEDROP[handleFileDrop()]
        HANDLEFILEUPLOADWITHPROGRESS[handleFileUploadWithProgress()]
    end
    
    subgraph "Interfaces"
        UPLOADPROGRESSCALLBACK[UploadProgressCallback]
    end
```

## Exports

- **UploadProgressCallback** - No description
- **backgroundUploadManager** - No description

## Functions

### `handleFileDrop(userId: string, file: any)`

No description available.

**Parameters:**
- `userId: string`
- `file: any`

**Returns:** Unknown

```typescript
async function handleFileDrop(userId: string, file: any) {
```

### `handleFileUploadWithProgress(userId: string, file: File, onProgress?: UploadProgressCallback)`

No description available.

**Parameters:**
- `userId: string`
- `file: File`
- `onProgress?: UploadProgressCallback`

**Returns:** Unknown

```typescript
async function handleFileUploadWithProgress(
    userId: string, 
    file: File, 
    onProgress?: UploadProgressCallback
): Promise<string | null> {
```


## Classes

### BackgroundUploadManager

No description available.

**Methods:**
- `startUpload`
- `if`

**Properties:**
- `uploads`
- `callbacks`
- `uploadId`
- `userId`
- `file`


## Interfaces

### UploadProgressCallback

No description available.

```typescript
export interface UploadProgressCallback {
  (progress: number): void;
}
```






## Source Code Insights

**File Size:** 3835 characters
**Lines of Code:** 133
**Imports:** 2

## Usage Example

```typescript
import { UploadProgressCallback, backgroundUploadManager } from '@/services/fileService.ts'

// Example usage
handleFileDrop()
```

---

*This documentation was automatically generated from the source code.*