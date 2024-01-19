<template>
  <LoginComponent />
</template>

<script lang="ts">
import { defineComponent, watch } from 'vue';
import { useRouter } from 'vue-router';
import LoginComponent from '@/components/LoginComponent.vue';
import { useAuthStore } from '@/stores/auth';
import { UserStatus } from '@/types';
import { updateUserStatus } from '@/services/profileService';

export default defineComponent({
  components: {
    LoginComponent,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();

    watch(() => authStore.isLoggedIn, (isLoggedIn) => {
      if (isLoggedIn) {
        try {
          const userId = authStore.session?.user?.id || '';
          updateUserStatus(userId, UserStatus.Online);
          router.push('/chat');
        } catch (error: any) {
          console.log(error);
          router.push('/new-profile');
        }
      }
    });

    return {};
  },
});
</script>
