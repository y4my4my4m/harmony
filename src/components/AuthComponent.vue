<template>
  <div class="auth-view" @mousemove="updateBackgroundRotation" :style="authStyles">
    <div class="auth-container">
      <div class="auth-content">
        <h1>Harmony</h1>
        <h2>{{ isLogin ? 'Login' : 'Register' }}</h2>
        
        <form @submit.prevent="handleSubmit" class="auth-form">
          <div class="form-group">
            <input 
              v-model="email" 
              type="email" 
              placeholder="Email" 
              class="input-base"
              required
            />
          </div>
          <div class="form-group">
            <input 
              v-model="password" 
              type="password" 
              placeholder="Password" 
              class="input-base"
              required
            />
          </div>
          <div class="button-group">
            <button type="submit" class="btn btn-primary">
              {{ isLogin ? 'Login' : 'Register' }}
            </button>
            <button 
              type="button" 
              @click="toggleMode" 
              class="btn btn-secondary"
            >
              {{ isLogin ? 'Register' : 'Login' }}
            </button>
          </div>
        </form>
        
        <img 
          src="/icon_3d.png" 
          class="logo" 
          alt="Logo" 
          @click="playSound('/assets/sounds/pirori-wet.mp3')" 
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useToast } from 'vue-toastification'
import { useAudioEffects } from '@/composables/useCommonUI'

export default defineComponent({
  name: 'AuthComponent',
  props: {
    isLogin: {
      type: Boolean,
      default: true
    }
  },
  setup(props) {
    const email = ref('')
    const password = ref('')
    const authStore = useAuthStore()
    const router = useRouter()
    const toast = useToast()
    const { playSound } = useAudioEffects()
    
    const randomBg = ref('')
    const bgRotation = ref(0)

    const authStyles = computed(() => ({
      '--random-bg': randomBg.value,
      '--bg-rotation-angle': bgRotation.value + 'deg'
    }))

    const handleSubmit = async () => {
      try {
        if (props.isLogin) {
          await authStore.login(email.value, password.value)
        } else {
          await authStore.register(email.value, password.value)
          router.push('/new-profile')
        }
      } catch (error: any) {
        console.error('Auth error:', error)
        toast.error(error.message || 'Authentication failed')
      }
    }

    const toggleMode = () => {
      const route = props.isLogin ? '/register' : '/login'
      router.push(route)
    }

    const updateBackgroundRotation = (event: MouseEvent) => {
      const x = event.clientX - (window.innerWidth / 2)
      const y = event.clientY - (window.innerHeight / 2)
      const angle = Math.atan2(y, x) * (180 / Math.PI)
      bgRotation.value = angle
    }

    onMounted(() => {
      randomBg.value = `url('/img/login_bg${Math.floor(Math.random() * 64) + 1}.png')`
    })

    return { 
      email, 
      password, 
      handleSubmit,
      toggleMode,
      updateBackgroundRotation,
      authStyles,
      playSound
    }
  },
})
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Arizonia&family=Press+Start+2P&family=Rubik+Moonrocks&display=swap');

.auth-view {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
  background: var(--random-bg) center center;
  background-size: cover;
  background-attachment: fixed;
}

.auth-container {
  position: absolute;
  z-index: 2;
  left: 200px;
}

.auth-container::before {
  position: absolute;
  content: '';
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--random-bg) center center;
  background-size: 100vw 100vh;
  background-position-x: -200px;
  z-index: 3;
  filter: blur(15px);
}

.auth-content {
  background: linear-gradient(var(--bg-rotation-angle), rgba(0,0,0,.9) 0%, rgba(0,0,0,0.7) 100%);
  padding: 40px 120px 100px 120px;
  position: relative;
  z-index: 5;
  border-radius: 24px;
  box-shadow: -3px 7px 16px rgba(0,0,0,0.32), 4px 8px 16px rgba(0,0,0,0.22);
}

h1 {
  text-align: center;
  margin: 0px auto;
  font-weight: 900;
  font-size: 9em;
  font-family: 'Arizonia', cursive;
  text-shadow: 3px 3px 4px #3141f8, 0px -3px 4px #e41616, -6px 6px 32px #3142f889, 5px -5px 32px #e4161678;
}

h2 {
  text-align: center;
  font-weight: 100;
  font-size: 2em;
  position: relative;
  top: -15px;
  color: white;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.button-group {
  display: flex;
  justify-content: space-between;
  gap: 20px;
}

.button-group .btn {
  flex: 1;
  margin: 0;
  padding: 15px;
  font-size: 1.15em;
  font-weight: bold;
}

.logo {
  display: block;
  margin: 15px auto;
  width: 8rem;
  height: 8rem;
  position: relative;
  top: 50px;
  cursor: pointer;
  transition: 0.3s;
}

.logo:hover {
  transform: scale(1.1);
}

/* Mobile styles */
@media screen and (max-width: 768px) {
  .auth-view {
    height: auto;
  }
  
  .auth-container {
    left: 0;
    position: relative;
  }
  
  .auth-container::before {
    display: none;
  }
  
  .auth-content {
    padding: 20px 60px 60px 60px;
    width: 100vw;
    height: 100vh;
    box-shadow: none;
    border-radius: 0;
  }
  
  h1 {
    font-size: 4.25rem;
  }
}
</style>