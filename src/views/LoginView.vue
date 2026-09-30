<template>
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
import { consumePostAuthRedirect } from '@/utils/postAuthRedirect';

export default defineComponent({
  name: 'LoginView',
  components: {
    AuthComponent,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    watch(() => authStore.isLoggedIn, (isLoggedIn) => {
      debug.log('LoginView: isLoggedIn changed:', isLoggedIn);
      if (isLoggedIn) {
        try {
          const userId = authStore.session?.user?.id || '';
          debug.log('LoginView: Navigating to chat, userId:', userId);
          updateUserStatus(userId, UserStatus.Online);
          router.push(consumePostAuthRedirect('/chat')).then(() => {
            debug.log('LoginView: Navigation to /chat successful');
          }).catch((err) => {
            debug.error('LoginView: Navigation failed:', err);
          });
        } catch (error: any) {
          debug.error('LoginView: Error during login navigation:', error);
          router.push('/new-profile');
        }
      }
    }, { immediate: true }); // Add immediate to catch if already logged in

    return {};
  },
});
</script>
