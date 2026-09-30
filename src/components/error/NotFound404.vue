<template>
  <div class="not-found-404">
    <div class="error-container">
      <!-- 404 Image -->
      <div class="error-image">
        <img 
          :src="selectedImage" 
          alt="404 - Page not found"
          class="error-img"
          @error="handleImageError"
        />
      </div>
      
      <!-- Error Content -->
      <div class="error-content">
        <h1 class="error-title">404</h1>
        <h2 class="error-subtitle">{{ computedTitle }}</h2>
        <p class="error-description">
          {{ computedDescription }}
        </p>
        
        <!-- Navigation Actions -->
        <div class="error-actions">
          <button 
            @click="goHome" 
            class="primary-btn"
          >
            <Icon name="home" />
            {{ computedHomeButtonText }}
          </button>
          
          <button 
            @click="goBack" 
            class="secondary-btn"
            v-if="canGoBack"
          >
            <Icon name="arrow-left" />
            {{ t('notFound.goBack') }}
          </button>
        </div>
        
        <!-- Helpful Links for authenticated users -->
        <div v-if="isAuthenticated" class="helpful-links">
          <h3>{{ t('notFound.quickNavigation') }}</h3>
          <div class="link-grid">
            <router-link to="/chat" class="quick-link">
              <Icon name="message-circle" />
              {{ t('nav.chat') }}
            </router-link>
            <router-link to="/social/home" class="quick-link">
              <Icon name="users" />
              {{ t('nav.social') }}
            </router-link>
            <router-link to="/dm" class="quick-link">
              <Icon name="mail" />
              {{ t('nav.directMessages') }}
            </router-link>
            <router-link to="/social/mentions" class="quick-link">
              <Icon name="at-sign" />
              {{ t('nav.mentions') }}
            </router-link>
          </div>
        </div>

        <!-- Login prompt for unauthenticated users -->
        <div v-else class="auth-prompt">
          <h3>{{ t('notFound.joinHarmony') }}</h3>
          <p>{{ t('notFound.signInPrompt') }}</p>
          <div class="auth-actions">
            <router-link to="/login" class="auth-btn primary">
              <Icon name="log-in" />
              {{ t('auth.signIn') }}
            </router-link>
            <router-link to="/register" class="auth-btn secondary">
              <Icon name="user-plus" />
              {{ t('auth.createAccountButton') }}
            </router-link>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/common/Icon.vue'
import { getRandom404Image } from '@/utils/backgroundUtils'

interface Props {
  /** Override the default title */
  title?: string
  /** Override the default description */
  description?: string
  /** Override the home button text */
  homeButtonText?: string
  /** Override the suggested home route */
  suggestedRoute?: string
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  description: '',
  homeButtonText: '',
  suggestedRoute: ''
})

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

// State
const selectedImage = ref('')
const imageError = ref(false)

// Computed properties
const isAuthenticated = computed(() => authStore.isLoggedIn)

const canGoBack = computed(() => window.history.length > 1)

// Smart context awareness using existing utilities
const notFoundContext = computed(() => {
  // Fallback context - can be enhanced later with utilities if needed
  return {
    isAuthenticated: isAuthenticated.value,
    suggestedRoute: isAuthenticated.value ? '/chat' : '/',
    layoutType: isAuthenticated.value ? 'base' : 'auth'
  }
})

const computedTitle = computed(() => {
  if (props.title) return props.title
  return t('notFound.pageNotFound')
})

const computedDescription = computed(() => {
  if (props.description) return props.description
  
  // Context-aware description based on the route
  if (route.path.startsWith('/social/')) {
    return t('notFound.socialNotFound')
  } else if (route.path.startsWith('/chat/') || route.path.startsWith('/dm/')) {
    return t('notFound.chatNotFound')
  } else if (route.path.startsWith('/settings/')) {
    return t('notFound.settingsNotFound')
  }
  
  return t('notFound.defaultNotFound')
})

const computedHomeButtonText = computed(() => {
  if (props.homeButtonText) return props.homeButtonText
  
  if (isAuthenticated.value) {
    // Context-aware button text
    if (route.path.startsWith('/social/')) {
      return t('notFound.backToSocial')
    } else if (route.path.startsWith('/chat/') || route.path.startsWith('/dm/')) {
      return t('notFound.backToChat')
    }
    return t('notFound.goHome')
  }
  
  return t('notFound.goHome')
})

const defaultRoute = computed(() => {
  if (props.suggestedRoute) {
    return props.suggestedRoute
  }
  return notFoundContext.value.suggestedRoute || (isAuthenticated.value ? '/chat' : '/')
})

// Methods
const selectRandomImage = async () => {
  try {
    selectedImage.value = await getRandom404Image()
  } catch (error) {
    debug.warn('Failed to load 404 image from manifest, using fallback:', error)
    // Fallback to legacy images
    const legacyImages = ['/backgrounds/404/1.webp', '/backgrounds/404/2.webp']
    const randomIndex = Math.floor(Math.random() * legacyImages.length)
    selectedImage.value = legacyImages[randomIndex]
  }
}

const handleImageError = () => {
  debug.warn('Failed to load 404 image:', selectedImage.value)
  imageError.value = true
  // Try fallback legacy images
  const legacyImages = ['/backgrounds/404/1.webp', '/backgrounds/404/2.webp']
  const currentIndex = legacyImages.indexOf(selectedImage.value)
  const fallbackIndex = currentIndex === 0 ? 1 : 0
  if (fallbackIndex !== currentIndex) {
    selectedImage.value = legacyImages[fallbackIndex]
  }
}

const goHome = () => {
  router.push(defaultRoute.value)
}

const goBack = () => {
  if (canGoBack.value) {
    router.go(-1)
  } else {
    goHome()
  }
}

// Lifecycle
onMounted(() => {
  selectRandomImage()
})
</script>

<style scoped>
/* Auto margins centre the card without clipping its top when it outgrows
   the viewport; align-items: center would. */
.not-found-404 {
  width: 100%;
  min-height: 100%;
  display: flex;
  overflow-y: auto;
  padding: 2rem;
  color: var(--text-primary);
}

.error-container {
  margin: auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2rem;
}

.error-image {
  width: 100%;
  max-width: 400px;
  margin-bottom: 1rem;
}

.error-img {
  width: 100%;
  height: auto;
}

.error-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.error-title {
  font-size: 4rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}

.error-subtitle {
  font-size: var(--font-size-2xl);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.error-description {
  font-size: var(--font-size-base);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
  max-width: 400px;
}

.error-actions {
  display: flex;
  gap: 1rem;
  margin-top: 1rem;
  flex-wrap: wrap;
  justify-content: center;
}

.primary-btn,
.secondary-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-radius: var(--radius-md);
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease;
  text-decoration: none;
  border: none;
  font-size: 0.95rem;
  min-width: 120px;
  justify-content: center;
}

.primary-btn {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.primary-btn:hover {
  background: var(--harmony-primary-hover);
}

.secondary-btn {
  background: var(--background-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
}

.secondary-btn:hover {
  background: var(--background-tertiary);
  border-color: var(--border-hover);
}

.helpful-links,
.auth-prompt {
  margin-top: 2rem;
  padding: 2rem;
  border-radius: var(--radius-lg);
  width: 100%;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
}

.helpful-links h3,
.auth-prompt h3 {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 1.5rem 0;
  text-align: center;
}

.auth-prompt p {
  color: var(--text-secondary);
  margin: 0 0 1.5rem 0;
  font-size: 0.95rem;
  line-height: 1.5;
}

.link-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: center;
  align-items: center;
}

.quick-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  background: var(--background-tertiary);
  color: var(--text-primary);
  text-decoration: none;
  border-radius: var(--radius-md);
  font-size: 0.95rem;
  font-weight: 500;
  transition: background-color 0.2s ease, border-color 0.2s ease;
  border: 1px solid var(--border-primary);
  position: relative;
  overflow: hidden;
}

.quick-link:hover {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
}

.auth-actions {
  display: flex;
  gap: 1.25rem;
  justify-content: center;
  flex-wrap: wrap;
}

.auth-btn {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.9rem 2rem;
  border-radius: var(--radius-md);
  font-weight: 600;
  text-decoration: none;
  transition: background-color 0.2s ease, border-color 0.2s ease;
  font-size: var(--font-size-base);
  min-width: 140px;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.auth-btn.primary {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  border: none;
}

.auth-btn.primary:hover {
  background: var(--harmony-primary-hover);
}

.auth-btn.secondary {
  background: var(--background-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
}

.auth-btn.secondary:hover {
  background: var(--background-secondary);
  border-color: var(--border-hover);
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .not-found-404 {
    padding: 1rem;
    min-height: 100vh;
  }
  
  .error-container {
    gap: 1.5rem;
  }
  
  .error-title {
    font-size: 3rem;
  }
  
  .error-subtitle {
    font-size: var(--font-size-xl);
  }
  
  .error-actions,
  .auth-actions {
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }
  
  .primary-btn,
  .secondary-btn,
  .auth-btn {
    width: 100%;
    max-width: 250px;
  }
  
  .link-grid {
    gap: 0.75rem;
    flex-direction: column;
  }
  
  .helpful-links,
  .auth-prompt {
    padding: 1.5rem;
    display: none;
  }
}

@media (max-width: 480px) {
  .error-image {
    max-width: 280px;
  }
  
  .error-title {
    font-size: 2.5rem;
  }
  
  .link-grid {
    gap: 0.75rem;
    flex-direction: column;
  }
  
  .helpful-links,
  .auth-prompt {
    margin-top: 1.5rem;
    padding: 1.25rem;
  }
  
  .auth-actions {
    gap: 0.75rem;
  }
  
  .auth-btn {
    padding: 0.8rem 1.5rem;
    font-size: 0.95rem;
  }
}

/* Loading state for when image is loading */
.error-img {
  background: var(--background-secondary);
}

.error-img[src=""] {
  opacity: 0.5;
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .primary-btn,
  .secondary-btn,
  .quick-link,
  .auth-btn {
    border: 2px solid currentColor;
  }
}
</style>
