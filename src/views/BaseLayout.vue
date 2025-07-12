
import { computed, ref, onMounted, watch, nextTick } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/useTheme'
import { useTrendingStore } from '@/stores/useTrending'
import { getProfileWithAvatarUrl } from '@/services/profileService'
import { useUserData } from '@/composables/useUserData'
import type { User } from '@/types'
import AdminPanel from '@/components/AdminPanel.vue'
import SettingsModal from '@/components/SettingsModal.vue'
import UserSidebar from '@/components/UserSidebar.vue'
import UserProfileComponent from '@/components/UserProfileComponent.vue'
import ChannelSidebar from '@/components/ChannelSidebar.vue'
import ChannelView from '@/components/ChannelView.vue'
import UnifiedView from '@/views/UnifiedView.vue'
import VoiceChannelIndicator from '@/components/VoiceChannelIndicator.vue'
import DMSidebar from '@/components/DMSidebar.vue'

const authStore = useAuthStore()
const themeStore = useThemeStore()
const trendingStore = useTrendingStore()

// NOTE: This BaseLayout is deprecated - userDataService initialization removed to prevent conflicts
// The main BaseLayout is in src/layouts/BaseLayout.vue

const profile = ref<User | null>(null)
const currentTheme = ref('dark')
const showSettings = ref(false)
const isAppInitialized = ref(false)

const isLoggedIn = computed(() => authStore.isLoggedIn)
const isAdmin = computed(() => profile.value?.is_admin || false)

// Simplified initialization without userDataService conflicts
const initializeApp = async () => {
  try {
    if (!authStore.session?.user) {
      console.warn('⚠️ No user session available')
      return
    }

    const userId = authStore.session.user.id
    
    console.log('🚀 Initializing application for user:', userId)
    
    // Load user profile
    profile.value = await getProfileWithAvatarUrl(userId)
    
    console.log('👤 User profile loaded:', { userId })
    
    // Initialize trending data in background
    try {
      await trendingStore.initialize()
    } catch (trendingError) {
      console.warn('⚠️ Trending initialization failed (non-critical):', trendingError)
    }
    
    isAppInitialized.value = true
    console.log('✅ Application initialization complete')
    
  } catch (error) {
    console.error('❌ Application initialization failed:', error)
    // Don't prevent the app from loading if initialization fails
    isAppInitialized.value = true
  }
}

// Handle login/logout
watch(() => authStore.isLoggedIn, async (newValue) => {
  if (newValue) {
    await nextTick()
    await initializeApp()
  } else {
    // Reset on logout
    profile.value = null
    isAppInitialized.value = false
  }
})

const toggleSettings = () => {
  showSettings.value = !showSettings.value
}

onMounted(async () => {
  // Set initial theme
  themeStore.setTheme(currentTheme.value)
  
  if (authStore.isLoggedIn) {
    await initializeApp()
  }
})