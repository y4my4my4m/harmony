# Code Examples

This section provides practical examples of how to use Harmony's components, services, and APIs.

## Quick Start Examples

### Basic Chat Integration

```vue
<template>
  <div class="chat-container">
    <MessageList :messages="messages" />
    <MessageInput @send="handleSendMessage" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useChatStore } from '@/stores/useChat'
import MessageDisplay from '@/components/MessageDisplay.vue'
import MessageInput from '@/components/chat/MessageInput.vue'

const chatStore = useChatStore()

// Reactive state
const messages = computed(() => chatStore.messages)

// Send a message
const handleSendMessage = async (content: string) => {
  await chatStore.sendMessage({
    content,
    channelId: 'current-channel-id'
  })
}

// Load messages on mount
onMounted(() => {
  chatStore.loadMessages('current-channel-id')
})
</script>
```

### ActivityPub Post Creation

```vue
<template>
  <div class="post-composer">
    <textarea
      v-model="postContent"
      placeholder="What's on your mind?"
      class="compose-input"
    />
    <button @click="publishPost" :disabled="!canPublish">
      Publish
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useActivityPubStore } from '@/stores/useActivityPub'

const activityPubStore = useActivityPubStore()
const postContent = ref('')

const canPublish = computed(() => 
  postContent.value.trim().length > 0 && 
  postContent.value.length <= 500
)

const publishPost = async () => {
  if (!canPublish.value) return
  
  await activityPubStore.createPost({
    content: postContent.value,
    visibility: 'public'
  })
  
  postContent.value = ''
}
</script>
```

## Component Usage Examples

### Using the Avatar Component

```vue
<template>
  <div class="user-profile">
    <!-- Basic avatar -->
    <Avatar :user="user" size="md" />
    
    <!-- Avatar with status indicator -->
    <Avatar 
      :user="user" 
      size="lg" 
      :show-status="true"
      :status="user.status"
    />
    
    <!-- Clickable avatar -->
    <Avatar 
      :user="user" 
      size="sm"
      clickable
      @click="showUserProfile"
    />
  </div>
</template>

<script setup lang="ts">
import Avatar from '@/components/shared/Avatar.vue'
import type { User } from '@/types'

interface Props {
  user: User
}

const props = defineProps<Props>()

const showUserProfile = () => {
  // Show user profile modal
  console.log('Show profile for:', props.user.username)
}
</script>
```

### Modal Integration

```vue
<template>
  <div>
    <button @click="showModal = true">
      Open Settings
    </button>
    
    <Modal
      v-model="showModal"
      title="User Settings"
      size="lg"
    >
      <UserSettingsForm 
        :user="currentUser"
        @save="handleSave"
        @cancel="showModal = false"
      />
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import Modal from '@/components/shared/Modal.vue'
import UserSettingsForm from '@/components/UserSettingsForm.vue'

const showModal = ref(false)

const handleSave = async (settings: any) => {
  // Save settings
  await saveUserSettings(settings)
  showModal.value = false
}
</script>
```

## Service Integration Examples

### Authentication Flow

```typescript
// login.ts
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'

export const useLogin = () => {
  const authStore = useAuthStore()
  const router = useRouter()
  
  const login = async (email: string, password: string) => {
    try {
      await authStore.login(email, password)
      
      // Redirect to app
      router.push('/chat')
      
    } catch (error) {
      console.error('Login failed:', error)
      throw error
    }
  }
  
  return { login }
}
```

### Real-time Subscriptions

```typescript
// useRealtimeMessages.ts
import { onMounted, onUnmounted } from 'vue'
import { useChatStore } from '@/stores/useChat'
import { supabase } from '@/supabase'

export const useRealtimeMessages = (channelId: string) => {
  const chatStore = useChatStore()
  let subscription: any = null
  
  onMounted(() => {
    // Subscribe to new messages
    subscription = supabase
      .channel(`messages:${channelId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${channelId}`
      }, (payload) => {
        chatStore.addMessage(payload.new)
      })
      .subscribe()
  })
  
  onUnmounted(() => {
    subscription?.unsubscribe()
  })
}
```

### File Upload Example

```vue
<template>
  <div class="file-upload">
    <input
      ref="fileInput"
      type="file"
      @change="handleFileSelect"
      accept="image/*,video/*"
      multiple
    />
    
    <div v-if="uploading" class="upload-progress">
      <progress :value="uploadProgress" max="100">
        {{ uploadProgress }}%
      </progress>
    </div>
    
    <div v-if="uploadedFiles.length" class="uploaded-files">
      <div 
        v-for="file in uploadedFiles" 
        :key="file.id"
        class="uploaded-file"
      >
        <img v-if="file.type.startsWith('image')" :src="file.url" />
        <video v-else-if="file.type.startsWith('video')" :src="file.url" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { fileService } from '@/services/fileService'

const fileInput = ref<HTMLInputElement>()
const uploading = ref(false)
const uploadProgress = ref(0)
const uploadedFiles = ref<any[]>([])

const handleFileSelect = async (event: Event) => {
  const files = (event.target as HTMLInputElement).files
  if (!files) return
  
  uploading.value = true
  uploadProgress.value = 0
  
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      
      const uploadedFile = await fileService.uploadFile(file, {
        bucket: 'user_media',
        onProgress: (progress) => {
          uploadProgress.value = (i / files.length + progress / files.length) * 100
        }
      })
      
      uploadedFiles.value.push(uploadedFile)
    }
  } catch (error) {
    console.error('Upload failed:', error)
  } finally {
    uploading.value = false
    uploadProgress.value = 0
  }
}
</script>
```

## Advanced Integration Examples

### Custom Composable with Multiple Stores

```typescript
// useServerManagement.ts
import { computed, ref } from 'vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'
import { useServerUsersStore } from '@/stores/useServerUsers'

export const useServerManagement = () => {
  const serverStore = useServerChannelStore()
  const authStore = useAuthStore()
  const usersStore = useServerUsersStore()
  
  const loading = ref(false)
  
  // Computed properties
  const currentServer = computed(() => serverStore.currentServer)
  const isServerOwner = computed(() => 
    currentServer.value?.owner === authStore.currentUser?.id
  )
  const serverMembers = computed(() => 
    usersStore.getServerUsers(currentServer.value?.id)
  )
  
  // Actions
  const createServer = async (serverData: any) => {
    loading.value = true
    try {
      const server = await serverStore.createServer(serverData)
      await switchToServer(server.id)
      return server
    } finally {
      loading.value = false
    }
  }
  
  const switchToServer = async (serverId: string) => {
    await serverStore.setCurrentServer(serverId)
    await usersStore.loadServerUsers(serverId)
  }
  
  const inviteUser = async (email: string) => {
    if (!currentServer.value) return
    
    // Implementation for user invitation
    // This would integrate with your invitation system
  }
  
  return {
    // State
    loading,
    currentServer,
    isServerOwner,
    serverMembers,
    
    // Actions
    createServer,
    switchToServer,
    inviteUser
  }
}
```

### Error Handling Pattern

```typescript
// useErrorHandling.ts
import { ref } from 'vue'
import { useToast } from 'vue-toastification'

export const useErrorHandling = () => {
  const toast = useToast()
  const errors = ref<string[]>([])
  
  const handleError = (error: any, context?: string) => {
    console.error('Error in', context, ':', error)
    
    let message = 'An unexpected error occurred'
    
    if (error.message) {
      message = error.message
    } else if (typeof error === 'string') {
      message = error
    }
    
    errors.value.push(message)
    toast.error(message)
  }
  
  const clearErrors = () => {
    errors.value = []
  }
  
  const withErrorHandling = async <T>(
    fn: () => Promise<T>,
    context?: string
  ): Promise<T | null> => {
    try {
      return await fn()
    } catch (error) {
      handleError(error, context)
      return null
    }
  }
  
  return {
    errors,
    handleError,
    clearErrors,
    withErrorHandling
  }
}
```

## Testing Examples

### Component Testing

```typescript
// Avatar.test.ts
import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import Avatar from '@/components/shared/Avatar.vue'

describe('Avatar', () => {
  const mockUser = {
    id: '1',
    username: 'testuser',
    avatar: 'https://example.com/avatar.jpg'
  }
  
  it('renders user avatar correctly', () => {
    const wrapper = mount(Avatar, {
      props: {
        user: mockUser,
        size: 'md'
      }
    })
    
    expect(wrapper.find('img').attributes('src')).toBe(mockUser.avatar)
    expect(wrapper.find('img').attributes('alt')).toBe(mockUser.username)
  })
  
  it('emits click event when clickable', async () => {
    const wrapper = mount(Avatar, {
      props: {
        user: mockUser,
        clickable: true
      }
    })
    
    await wrapper.find('.avatar').trigger('click')
    expect(wrapper.emitted('click')).toBeTruthy()
  })
})
```

### Store Testing

```typescript
// chatStore.test.ts
import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '@/stores/useChat'

describe('Chat Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  
  it('sends message correctly', async () => {
    const store = useChatStore()
    
    const messageData = {
      content: 'Test message',
      channelId: 'channel-1'
    }
    
    await store.sendMessage(messageData)
    
    expect(store.messages).toContainEqual(
      expect.objectContaining({
        content: 'Test message',
        channel_id: 'channel-1'
      })
    )
  })
})
```

## Best Practices

### Performance Optimization

```vue
<template>
  <div class="optimized-list">
    <!-- Use v-memo for expensive computations -->
    <div
      v-for="item in expensiveList"
      :key="item.id"
      v-memo="[item.lastModified]"
    >
      {{ expensiveComputation(item) }}
    </div>
    
    <!-- Use v-show for frequently toggled elements -->
    <div v-show="showDetails" class="details">
      <!-- Expensive content -->
    </div>
    
    <!-- Lazy load heavy components -->
    <Suspense>
      <AsyncHeavyComponent v-if="shouldLoadHeavyComponent" />
      <template #fallback>
        <LoadingSkeleton />
      </template>
    </Suspense>
  </div>
</template>
```

### Accessibility Best Practices

```vue
<template>
  <div class="accessible-form">
    <!-- Proper labeling -->
    <label for="username">Username</label>
    <input
      id="username"
      v-model="username"
      type="text"
      :aria-describedby="usernameError ? 'username-error' : undefined"
      :aria-invalid="!!usernameError"
    />
    <div
      v-if="usernameError"
      id="username-error"
      role="alert"
      class="error-message"
    >
      {{ usernameError }}
    </div>
    
    <!-- Keyboard navigation -->
    <button
      @click="submit"
      @keydown.enter="submit"
      :disabled="!isValid"
      aria-label="Submit form"
    >
      Submit
    </button>
  </div>
</template>
```

---

These examples demonstrate common patterns and best practices for building features in Harmony. For more specific use cases, check the individual component and API documentation.
