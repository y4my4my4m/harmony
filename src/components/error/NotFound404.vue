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
            Go Back
          </button>
        </div>
        
        <!-- Helpful Links for authenticated users -->
        <div v-if="isAuthenticated" class="helpful-links">
          <h3>Quick navigation:</h3>
          <div class="link-grid">
            <router-link to="/chat" class="quick-link">
              <Icon name="message-circle" />
              Chat
            </router-link>
            <router-link to="/social/home" class="quick-link">
              <Icon name="users" />
              Social
            </router-link>
            <router-link to="/dm" class="quick-link">
              <Icon name="mail" />
              Direct Messages
            </router-link>
            <router-link to="/social/mentions" class="quick-link">
              <Icon name="at-sign" />
              Mentions
            </router-link>
          </div>
        </div>

        <!-- Login prompt for unauthenticated users -->
        <div v-else class="auth-prompt">
          <h3>Join Harmony</h3>
          <p>Sign in to access all features and connect with the community.</p>
          <div class="auth-actions">
            <router-link to="/login" class="auth-btn primary">
              <Icon name="log-in" />
              Sign In
            </router-link>
            <router-link to="/register" class="auth-btn secondary">
              <Icon name="user-plus" />
              Create Account
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
  return 'Page not found'
})

const computedDescription = computed(() => {
  if (props.description) return props.description
  
  // Context-aware description based on the route
  if (route.path.startsWith('/social/')) {
    return "This social content doesn't exist or has been removed."
  } else if (route.path.startsWith('/chat/') || route.path.startsWith('/dm/')) {
    return "This chat or conversation doesn't exist or you don't have access to it."
  } else if (route.path.startsWith('/settings/')) {
    return "This settings page doesn't exist."
  }
  
  return "The page you're looking for doesn't exist or has been moved."
})

const computedHomeButtonText = computed(() => {
  if (props.homeButtonText) return props.homeButtonText
  
  if (isAuthenticated.value) {
    // Context-aware button text
    if (route.path.startsWith('/social/')) {
      return 'Back to Social'
    } else if (route.path.startsWith('/chat/') || route.path.startsWith('/dm/')) {
      return 'Back to Chat'
    }
    return 'Go Home'
  }
  
  return 'Go Home'
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
.not-found-404 {
  width: 100%;
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: var(--h-background);
  color: var(--h-text-primary);
}

.error-container {
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
  transition: transform 0.3s ease;
}

.error-img:hover {
  transform: scale(1.02);
}

.error-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.error-title {
  font-size: 4rem;
  font-weight: 900;
  color: var(--h-primary);
  margin: 0;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-secondary));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.error-subtitle {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--h-text-primary);
  margin: 0;
}

.error-description {
  font-size: 1rem;
  color: var(--h-text-secondary);
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
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  text-decoration: none;
  border: none;
  font-size: 0.95rem;
  min-width: 120px;
  justify-content: center;
}

.primary-btn {
  background: var(--h-primary);
  color: var(--text-primary);
}

.primary-btn:hover {
  background: var(--h-primary-hover);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.secondary-btn {
  background: var(--h-background-secondary);
  color: var(--h-text-primary);
  border: 1px solid var(--h-border);
}

.secondary-btn:hover {
  background: var(--h-background-tertiary);
  border-color: var(--h-primary);
  transform: translateY(-1px);
}

.helpful-links,
.auth-prompt {
  margin-top: 2rem;
  padding: 2rem;
  border-radius: 12px;
  width: 100%;
}

.helpful-links {
  background: linear-gradient(135deg, var(--h-background-secondary), var(--h-background-tertiary));
  border: 1px solid var(--h-border);
}

.helpful-links h3,
.auth-prompt h3 {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--h-text-primary);
  margin: 0 0 1.5rem 0;
  text-align: center;
}

.auth-prompt {
  background: linear-gradient(135deg, var(--h-background-secondary), var(--h-background-tertiary));
  border: 1px solid var(--h-border);
}

.auth-prompt p {
  color: var(--h-text-secondary);
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
  background: var(--h-background-tertiary);
  color: var(--h-text-primary);
  text-decoration: none;
  border-radius: 10px;
  font-size: 0.95rem;
  font-weight: 500;
  transition: all 0.2s ease;
  border: 1px solid var(--h-border);
  position: relative;
  overflow: hidden;
}

.quick-link::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
  transition: left 0.5s;
}

.quick-link:hover::before {
  left: 100%;
}

.quick-link:hover {
  background: var(--h-primary);
  color: var(--text-primary);
  border-color: var(--h-primary);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
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
  border-radius: 10px;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.3s ease;
  font-size: 1rem;
  min-width: 140px;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.auth-btn::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
  transition: left 0.5s;
}

.auth-btn:hover::before {
  left: 100%;
}

.auth-btn.primary {
  background: linear-gradient(135deg, var(--h-primary), var(--h-primary-hover));
  color: var(--text-primary);
  border: none;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
}

.auth-btn.primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
}

.auth-btn.secondary {
  background: var(--h-background-tertiary);
  color: var(--h-text-primary);
  border: 2px solid var(--h-border);
}

.auth-btn.secondary:hover {
  background: var(--h-background-secondary);
  border-color: var(--h-primary);
  transform: translateY(-2px);
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
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
    font-size: 1.25rem;
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
  background: var(--h-background-secondary);
}

.error-img[src=""] {
  opacity: 0.5;
}

/* Accessibility improvements */
@media (prefers-reduced-motion: reduce) {
  .error-img:hover {
    transform: none;
  }
  
  .primary-btn:hover,
  .secondary-btn:hover,
  .quick-link:hover,
  .auth-btn:hover {
    transform: none;
  }
  
  .quick-link::before,
  .auth-btn::before {
    display: none;
  }
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .error-title {
    -webkit-text-fill-color: var(--h-primary);
    background: none;
  }
  
  .primary-btn,
  .secondary-btn,
  .quick-link,
  .auth-btn {
    border: 2px solid currentColor;
  }
}
</style>
