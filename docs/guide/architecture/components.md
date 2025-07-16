# Component Structure

Harmony's component architecture follows Vue 3 best practices with a clear hierarchy and separation of concerns.

## Component Hierarchy

```mermaid
graph TB
    subgraph "Application Root"
        APP[App.vue]
    end
    
    subgraph "Layout Layer"
        APP --> MAIN_NAV[MainNavigation]
        APP --> SIDEBAR[SidebarComponent] 
        APP --> CONTENT[MainContentArea]
    end
    
    subgraph "Feature Components"
        SIDEBAR --> SERVER_SIDEBAR[ServerSidebar]
        SIDEBAR --> CHANNEL_SIDEBAR[ChannelSidebar]
        SIDEBAR --> DM_SIDEBAR[DMSidebar]
        
        CONTENT --> CHAT[ChatComponent]
        CONTENT --> ACTIVITY[ActivityPubContent]
        CONTENT --> SETTINGS[SettingsPanel]
    end
    
    subgraph "Shared Components"
        CHAT --> MESSAGE_DISPLAY[MessageDisplay]
        CHAT --> MESSAGE_INPUT[MessageInput]
        MESSAGE_DISPLAY --> MESSAGE_CONTENT[MessageContent]
        
        ACTIVITY --> POST_COMPOSER[PostComposer]
        ACTIVITY --> TIMELINE[Timeline]
        ACTIVITY --> USER_CARD[UserCard]
    end
    
    subgraph "UI Components"
        MESSAGE_INPUT --> EMOJI_UI[EmojiUI]
        MESSAGE_INPUT --> FILE_UPLOAD[FileUpload]
        POST_COMPOSER --> RICH_EDITOR[RichTextEditor]
        
        MODAL[Modal Components]
        BUTTON[Button Components]
        FORM[Form Components]
    end
```

## Component Categories

### 1. Layout Components

**Purpose**: Structure the application layout and provide navigation

```mermaid
graph LR
    subgraph "Layout Structure"
        NAVIGATION[MainNavigation] --> CONTENT_AREA[Content Area]
        SIDEBAR[Sidebar] --> CONTENT_AREA
        HEADER[Header] --> CONTENT_AREA
    end
```

**Key Components**:
- `MainNavigation.vue` - Primary app navigation
- `SidebarComponent.vue` - Contextual sidebar container
- `MainContentAreaHeader.vue` - Content area header

### 2. Feature Components

**Purpose**: Implement core application features

```mermaid
graph TB
    subgraph "Chat Feature"
        CHAT_COMP[ChatComponent]
        MSG_DISPLAY[MessageDisplay]
        MSG_INPUT[MessageInput]
        REACTIONS[MessageReactions]
    end
    
    subgraph "Social Feature"
        COMPOSER[PostComposer]
        TIMELINE[Timeline]
        PROFILE[UserProfile]
    end
    
    subgraph "Server Management"
        SERVER_CREATE[CreateServer]
        CHANNEL_CREATE[CreateChannel]
        INVITE_MODAL[InviteModal]
    end
```

### 3. Shared Components

**Purpose**: Reusable components across features

```mermaid
graph TB
    subgraph "Media Components"
        EMOJI[EmojiUI]
        FILE_PREVIEW[FilePreview]
        AVATAR[Avatar]
        IMAGE_GALLERY[ImageGallery]
    end
    
    subgraph "Form Components"
        INPUT[UnifiedInput]
        BUTTON[UnifiedButton]
        MODAL[UnifiedModal]
        DROPDOWN[Dropdown]
    end
    
    subgraph "Content Components"
        MARKDOWN[MarkdownContent]
        CODE_BLOCK[CodeBlock]
        LINK_PREVIEW[LinkPreview]
    end
```

## Component Communication Patterns

### Parent-Child Communication

```mermaid
sequenceDiagram
    participant Parent
    participant Child
    
    Note over Parent,Child: Props Down
    Parent->>Child: Pass props
    Child->>Child: Use props in template
    
    Note over Parent,Child: Events Up
    Child->>Parent: Emit event
    Parent->>Parent: Handle event
    Parent->>Child: Update props
```

### Sibling Communication via Store

```mermaid
sequenceDiagram
    participant ComponentA
    participant Store
    participant ComponentB
    
    ComponentA->>Store: Dispatch action
    Store->>Store: Update state
    Store-->>ComponentB: Reactive update
    ComponentB->>ComponentB: Re-render with new data
```

### Composable Integration

```mermaid
graph TB
    subgraph "Component"
        TEMPLATE[Template]
        SCRIPT[Script Setup]
    end
    
    subgraph "Composables"
        USER_DATA[useUserData]
        LAYOUT[useLayoutState]
        REACTIONS[useMessageReactions]
    end
    
    subgraph "Stores"
        AUTH_STORE[Auth Store]
        CHAT_STORE[Chat Store]
        UI_STORE[UI Store]
    end
    
    SCRIPT --> USER_DATA
    SCRIPT --> LAYOUT
    SCRIPT --> REACTIONS
    
    USER_DATA --> AUTH_STORE
    LAYOUT --> UI_STORE
    REACTIONS --> CHAT_STORE
    
    AUTH_STORE --> TEMPLATE
    CHAT_STORE --> TEMPLATE
    UI_STORE --> TEMPLATE
```

## Component Lifecycle

### Standard Component Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Mounted: Component mounts
    Mounted --> Updated: Props/state change
    Updated --> Updated: Reactive updates
    Updated --> Unmounted: Component unmounts
    Unmounted --> [*]
    
    state Mounted {
        [*] --> SetupReactive
        SetupReactive --> RegisterListeners
        RegisterListeners --> InitializeData
    }
    
    state Unmounted {
        [*] --> Cleanup
        Cleanup --> RemoveListeners
        RemoveListeners --> [*]
    }
```

### Chat Component Lifecycle

```mermaid
sequenceDiagram
    participant Component
    participant Store
    participant Subscription
    participant Supabase
    
    Note over Component: onMounted
    Component->>Store: Initialize chat state
    Store->>Subscription: Subscribe to messages
    Subscription->>Supabase: WebSocket connection
    
    loop Message Updates
        Supabase-->>Subscription: New message
        Subscription-->>Store: Update state
        Store-->>Component: Reactive update
    end
    
    Note over Component: onUnmounted
    Component->>Subscription: Unsubscribe
    Subscription->>Supabase: Close connection
```

## Prop Patterns

### Configuration Props

```typescript
interface ComponentProps {
  // Configuration
  mode: 'chat' | 'social' | 'voice'
  layout: 'compact' | 'comfortable' | 'spacious'
  theme: 'light' | 'dark' | 'auto'
  
  // Data props
  messages: Message[]
  users: User[]
  
  // Behavior props
  readonly: boolean
  autoScroll: boolean
  showTimestamps: boolean
}
```

### Event Props

```typescript
interface ComponentEmits {
  // User interactions
  (e: 'messageSelect', message: Message): void
  (e: 'userClick', user: User): void
  
  // State changes
  (e: 'loadMore'): void
  (e: 'scrollToBottom'): void
  
  // Data mutations
  (e: 'messageCreate', content: string): void
  (e: 'messageUpdate', id: string, content: string): void
  (e: 'messageDelete', id: string): void
}
```

## Slot Patterns

### Content Slots

```vue
<template>
  <div class="message-container">
    <!-- Default content slot -->
    <slot name="content" :message="message">
      <MessageContent :message="message" />
    </slot>
    
    <!-- Actions slot with data -->
    <slot name="actions" :message="message" :onReact="handleReact">
      <MessageActions :message="message" @react="handleReact" />
    </slot>
    
    <!-- Optional metadata slot -->
    <slot name="metadata" :message="message" />
  </div>
</template>
```

### Layout Slots

```vue
<template>
  <div class="layout-container">
    <!-- Header slot -->
    <header v-if="$slots.header">
      <slot name="header" />
    </header>
    
    <!-- Main content with sidebar -->
    <main class="main-content">
      <aside v-if="$slots.sidebar" class="sidebar">
        <slot name="sidebar" />
      </aside>
      
      <section class="content">
        <slot /> <!-- Default slot -->
      </section>
    </main>
    
    <!-- Footer slot -->
    <footer v-if="$slots.footer">
      <slot name="footer" />
    </footer>
  </div>
</template>
```

## State Management Integration

### Component Store Binding

```vue
<script setup lang="ts">
import { useChatStore } from '@/stores/useChat'
import { useAuthStore } from '@/stores/auth'

// Store bindings
const chatStore = useChatStore()
const authStore = useAuthStore()

// Computed properties from stores
const messages = computed(() => chatStore.messages)
const currentUser = computed(() => authStore.user)
const isLoading = computed(() => chatStore.isLoading)

// Store actions
const sendMessage = (content: string) => {
  chatStore.sendMessage({
    content,
    channelId: props.channelId,
    authorId: currentUser.value?.id
  })
}
</script>
```

### Reactive State Patterns

```vue
<script setup lang="ts">
// Reactive references
const searchQuery = ref('')
const selectedUsers = ref<User[]>([])
const isModalOpen = ref(false)

// Computed derived state
const filteredUsers = computed(() => {
  return users.value.filter(user => 
    user.name.toLowerCase().includes(searchQuery.value.toLowerCase())
  )
})

// Watchers for side effects
watch(searchQuery, (newQuery) => {
  if (newQuery.length > 2) {
    performSearch(newQuery)
  }
})

// Lifecycle hooks
onMounted(() => {
  fetchUsers()
})

onUnmounted(() => {
  cleanup()
})
</script>
```

## Component Testing Structure

### Component Test Patterns

```typescript
describe('ChatComponent', () => {
  beforeEach(() => {
    // Setup test store
    setActivePinia(createPinia())
  })

  test('renders messages correctly', () => {
    const messages = [
      { id: '1', content: 'Hello', author: 'User1' },
      { id: '2', content: 'World', author: 'User2' }
    ]
    
    const wrapper = mount(ChatComponent, {
      props: { messages }
    })
    
    expect(wrapper.findAll('[data-testid="message"]')).toHaveLength(2)
  })

  test('emits send event on message submit', async () => {
    const wrapper = mount(ChatComponent)
    
    await wrapper.find('[data-testid="message-input"]').setValue('Test message')
    await wrapper.find('[data-testid="send-button"]').trigger('click')
    
    expect(wrapper.emitted('messageCreate')).toBeTruthy()
    expect(wrapper.emitted('messageCreate')[0]).toEqual(['Test message'])
  })
})
```

This component structure ensures:
- **Maintainability**: Clear separation of concerns
- **Reusability**: Shared components across features
- **Testability**: Well-defined interfaces and props
- **Performance**: Efficient reactivity and lifecycle management
- **Type Safety**: TypeScript integration throughout
