<template>
  <div class="callback-wrapper">
    <div class="callback-card">
      <!-- Loading State -->
      <div v-if="status === 'loading'" class="callback-content">
        <div class="loader">
          <div class="loader-ring"></div>
          <img src="/icon_3d.png" alt="Harmony" class="loader-logo" />
        </div>
        <h2>{{ $t('auth.callback.signingIn') || 'Signing you in...' }}</h2>
        <p>{{ $t('auth.callback.pleaseWait') || 'Please wait while we complete your authentication.' }}</p>
      </div>

      <!-- Error State -->
      <div v-else-if="status === 'error'" class="callback-content error">
        <div class="error-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </div>
        <h2>{{ $t('auth.callback.error') || 'Authentication Failed' }}</h2>
        <p>{{ errorMessage }}</p>
        <button @click="goToLogin" class="btn-primary">
          {{ $t('auth.callback.tryAgain') || 'Try Again' }}
        </button>
      </div>

      <!-- Success State (brief flash before redirect) -->
      <div v-else-if="status === 'success'" class="callback-content success">
        <div class="success-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
        <h2>{{ $t('auth.callback.success') || 'Welcome!' }}</h2>
        <p>{{ $t('auth.callback.redirecting') || 'Redirecting you now...' }}</p>
      </div>
    </div>

    <!-- Background -->
    <div class="bg-gradient"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

const router = useRouter()
const authStore = useAuthStore()

const status = ref<'loading' | 'success' | 'error'>('loading')
const errorMessage = ref('')

const goToLogin = () => {
  router.push('/login')
}

onMounted(async () => {
  try {
    // The OAuth callback will have the code in the URL
    // Supabase client handles the token exchange automatically
    // when detectSessionInUrl is true (which it is in our config)
    
    // Get the session that was just created
    const { data: { session }, error } = await supabase.auth.getSession()
    
    if (error) {
      throw error
    }
    
    if (!session) {
      // Check if there's an error in the URL params
      const hashParams = new URLSearchParams(window.location.hash.substring(1))
      const queryParams = new URLSearchParams(window.location.search)
      
      const errorParam = hashParams.get('error') || queryParams.get('error')
      const errorDescription = hashParams.get('error_description') || queryParams.get('error_description')
      
      if (errorParam) {
        throw new Error(errorDescription || errorParam)
      }
      
      throw new Error('No session found after authentication')
    }
    
    // Check if user is suspended
    if (session.user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_suspended, suspension_reason')
        .eq('auth_user_id', session.user.id)
        .maybeSingle()
      
      if (profile?.is_suspended) {
        await supabase.auth.signOut()
        throw new Error(
          profile.suspension_reason 
            ? `Your account has been suspended: ${profile.suspension_reason}`
            : 'Your account has been suspended. Please contact an administrator.'
        )
      }
    }
    
    // Update auth store
    authStore.session = session
    
    // Brief success state
    status.value = 'success'
    
    // Check if this is a new user (no profile yet)
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('auth_user_id', session.user.id)
      .maybeSingle()
    
    // Wait a moment to show success, then redirect
    setTimeout(() => {
      if (!existingProfile || !existingProfile.username) {
        // New user - go to profile setup
        router.push('/new-profile')
      } else {
        // Existing user - go to chat
        router.push('/chat')
      }
    }, 800)
    
  } catch (error: any) {
    debug.error('OAuth callback error:', error)
    status.value = 'error'
    errorMessage.value = error.message || 'An error occurred during authentication'
  }
})
</script>

<style scoped>
.callback-wrapper {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0a0a0f;
  position: relative;
  overflow: hidden;
}

.bg-gradient {
  position: fixed;
  inset: 0;
  background: 
    radial-gradient(ellipse 60% 40% at 50% 40%, rgba(99, 102, 241, 0.15) 0%, transparent 50%),
    radial-gradient(ellipse 40% 30% at 70% 60%, rgba(139, 92, 246, 0.1) 0%, transparent 50%);
  pointer-events: none;
}

.callback-card {
  position: relative;
  z-index: 10;
  background: rgba(17, 17, 23, 0.9);
  backdrop-filter: blur(40px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 24px;
  padding: 48px;
  min-width: 360px;
  text-align: center;
  box-shadow: 0 32px 64px rgba(0, 0, 0, 0.4);
}

.callback-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.callback-content h2 {
  font-size: 1.5rem;
  font-weight: 600;
  color: #fff;
  margin: 0;
}

.callback-content p {
  font-size: 0.95rem;
  color: rgba(255, 255, 255, 0.6);
  margin: 0;
  max-width: 280px;
}

/* Loader */
.loader {
  position: relative;
  width: 80px;
  height: 80px;
  margin-bottom: 8px;
}

.loader-ring {
  position: absolute;
  inset: 0;
  border: 3px solid rgba(99, 102, 241, 0.2);
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.loader-logo {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 48px;
  height: 48px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Error State */
.error-icon {
  width: 64px;
  height: 64px;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ef4444;
  margin-bottom: 8px;
}

.error-icon svg {
  width: 32px;
  height: 32px;
}

.callback-content.error h2 {
  color: #ef4444;
}

/* Success State */
.success-icon {
  width: 64px;
  height: 64px;
  background: rgba(34, 197, 94, 0.1);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #22c55e;
  margin-bottom: 8px;
  animation: scaleIn 0.4s ease;
}

.success-icon svg {
  width: 32px;
  height: 32px;
}

@keyframes scaleIn {
  0% { transform: scale(0); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}

/* Button */
.btn-primary {
  margin-top: 16px;
  padding: 14px 32px;
  background: linear-gradient(135deg, #6366f1 0%, #818cf8 100%);
  border: none;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(99, 102, 241, 0.4);
}

@media (max-width: 480px) {
  .callback-card {
    margin: 20px;
    padding: 32px 24px;
    min-width: auto;
  }
}
</style>

