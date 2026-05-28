<template>
  <!-- <h2>Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login Login </h2> -->
  <AuthComponent :isLogin="true" />
</template>

<script lang="ts">
import { defineComponent, watch } from 'vue';
import { useRouter } from 'vue-router';
import AuthComponent from '@/components/AuthComponent.vue';
import { useAuthStore } from '@/stores/auth';
import { UserStatus } from '@/types';
import { updateUserStatus } from '@/services/ProfileService';
import { debug } from '@/utils/debug';

export default defineComponent({
  name: 'LoginView',
  components: {
    AuthComponent,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    watch(() => authStore.isLoggedIn, (isLoggedIn) => {
      debug.log('🔐 LoginView: isLoggedIn changed:', isLoggedIn);
      if (isLoggedIn) {
        try {
          const userId = authStore.session?.user?.id || '';
          debug.log('🔐 LoginView: Navigating to chat, userId:', userId);
          updateUserStatus(userId, UserStatus.Online);
          router.push('/chat').then(() => {
            debug.log('✅ LoginView: Navigation to /chat successful');
          }).catch((err) => {
            debug.error('❌ LoginView: Navigation failed:', err);
          });
        } catch (error: any) {
          debug.error('❌ LoginView: Error during login navigation:', error);
          router.push('/new-profile');
        }
      }
    }, { immediate: true }); // Add immediate to catch if already logged in

    return {};
  },
});
</script>

<style scoped>
  h2 {
    background-clip: text;
    -webkit-text-fill-color: transparent; 
    -moz-text-fill-color: transparent;
    background-image: linear-gradient(45deg, #3416f7, #c41d1d);
    width: 180%;
    height: 100%;
    position: absolute;
    display: block;
    top: -390px;
    margin: 0 auto;
    left: -480px;
    right: 0;
    text-align: center;
    font-weight: 900;
    opacity: .1;
    font-size: 20em;
    text-shadow: 0 3px 10px rgba(0,0,0,0.7);
    transform: skew(6deg, 8deg) rotate3d(7, 0, 0, 30deg);
  }
</style>