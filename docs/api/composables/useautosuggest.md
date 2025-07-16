# useAutoSuggest Composable

**File:** `src/composables/useAutoSuggest.ts`

## Overview

```mermaid
graph TB
    subgraph "useAutoSuggest Composable"
        AUTOSUGGESTTRIGGER[AutoSuggestTrigger]
        AUTOSUGGESTSTATE[AutoSuggestState]
        AUTOSUGGESTCONFIG[AutoSuggestConfig]
        USEAUTOSUGGEST[useAutoSuggest]
    end
    
    subgraph "Functions"
        USEAUTOSUGGEST[useAutoSuggest()]
        SEARCHACTIVITYPUBUSERS[searchActivityPubUsers()]
        HANDLEINPUT[handleInput()]
        CLOSESUGGESTIONS[closeSuggestions()]
        UPDATEPOSITION[updatePosition()]
    end
    
    subgraph "Interfaces"
        AUTOSUGGESTTRIGGER[AutoSuggestTrigger]
        AUTOSUGGESTSTATE[AutoSuggestState]
        AUTOSUGGESTCONFIG[AutoSuggestConfig]
        RICHTEXTEDITORREF[RichTextEditorRef]
    end
```

## Exports

- **AutoSuggestTrigger** - No description
- **AutoSuggestState** - No description
- **AutoSuggestConfig** - No description
- **useAutoSuggest** - No description

## Functions

### `useAutoSuggest(inputElement: Ref<InputElementType | null>, getCurrentText?: ()`

No description available.

**Parameters:**
- `inputElement: Ref<InputElementType | null>`
- `getCurrentText?: (`

**Returns:** Unknown

```typescript
export function useAutoSuggest(
  inputElement: Ref<InputElementType | null>,
  getCurrentText?: () => string,
  updateText?: (newText: string, cursorPosition?: number) => void,
  config: AutoSuggestConfig = {
```

### `searchActivityPubUsers(query: string)`

No description available.

**Parameters:**
- `query: string`

**Returns:** Unknown

```typescript
const searchActivityPubUsers = async (query: string) =>
```

### `handleInput(value: string, cursorPosition: number)`

No description available.

**Parameters:**
- `value: string`
- `cursorPosition: number`

**Returns:** Unknown

```typescript
const handleInput = (value: string, cursorPosition: number) =>
```

### `closeSuggestions()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const closeSuggestions = () =>
```

### `updatePosition()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const updatePosition = () =>
```




## Interfaces

### AutoSuggestTrigger

No description available.

```typescript
export interface AutoSuggestTrigger {
  char: string;
  pattern: RegExp;
  type: 'emoji' | 'mention';
}
```

### AutoSuggestState

No description available.

```typescript
export interface AutoSuggestState {
  isActive: boolean;
  triggerType: 'emoji' | 'mention' | null;
  query: string;
  triggerPosition: number;
  selectedIndex: number;
  position: SuggestionPosition;
}
```

### AutoSuggestConfig

No description available.

```typescript
export interface AutoSuggestConfig {
  mode: 'chat' | 'activitypub';
  enableEmojis?: boolean;
  enableMentions?: boolean;
  maxSuggestions?: number;
}
```

### RichTextEditorRef

No description available.

```typescript
interface RichTextEditorRef {
  getCursorPosition?: () => number;
  focus?: () => void;
  insertTextAtCursor?: (text: string) => void;
  $el?: HTMLElement;
}
```


## Type Definitions

### InputElementType

No description available.

```typescript
type InputElementType = HTMLTextAreaElement | HTMLInputElement | RichTextEditorRef | any
```




## Source Code Insights

**File Size:** 19565 characters
**Lines of Code:** 581
**Imports:** 8

## Usage Example

```typescript
import { AutoSuggestTrigger, AutoSuggestState, AutoSuggestConfig, useAutoSuggest } from '@/composables/useAutoSuggest.ts'

// Example usage
useAutoSuggest()
```

---

*This documentation was automatically generated from the source code.*