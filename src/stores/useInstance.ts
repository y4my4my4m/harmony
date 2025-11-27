import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

const CACHE_DURATION_MS = 5 * 60 * 1000 // 5 minutes

export const useInstanceStore = defineStore('instance', () => {
  // State
  const domain = ref<string>(import.meta.env.VITE_DOMAIN || window.location.hostname)
  const userCount = ref<number>(0)
  const postCount = ref<number>(0)
  const lastFetched = ref<number | null>(null)
  const isLoading = ref(false)

  // Computed
  const isCacheValid = computed(() => {
    if (!lastFetched.value) return false
    return Date.now() - lastFetched.value < CACHE_DURATION_MS
  })

  // Actions
  async function fetchStats(force = false) {
    // Skip if cache is valid and not forcing
    if (isCacheValid.value && !force) {
      debug.log('📊 Instance stats: using cached values')
      return
    }

    // Skip if already loading
    if (isLoading.value) return

    isLoading.value = true
    
    try {
      debug.log('🔄 Fetching instance stats from database...')
      
      const [usersResult, postsResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('*', { count: 'exact', head: true })
          .eq('is_local', true),
        supabase
          .from('posts')
          .select('*', { count: 'exact', head: true })
          .eq('is_local', true)
          .eq('is_deleted', false)
      ])
      
      userCount.value = usersResult.count || 0
      postCount.value = postsResult.count || 0
      lastFetched.value = Date.now()
      
      debug.log('✅ Instance stats cached:', {
        users: userCount.value,
        posts: postCount.value
      })
    } catch (error) {
      debug.error('Failed to fetch instance stats:', error)
    } finally {
      isLoading.value = false
    }
  }

  // Increment post count optimistically (when user creates a post)
  function incrementPostCount() {
    postCount.value++
  }

  // Decrement post count optimistically (when user deletes a post)
  function decrementPostCount() {
    if (postCount.value > 0) postCount.value--
  }

  return {
    // State
    domain,
    userCount,
    postCount,
    isLoading,
    
    // Actions
    fetchStats,
    incrementPostCount,
    decrementPostCount,
  }
})

