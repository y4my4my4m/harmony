<template>
    <div class="user-profile">
      <img v-if="profile?.avatar_url" :src="profile.avatar_url" alt="User Avatar" class="avatar">
      <p>{{ profile?.display_name }}</p>
      <p>{{ profile?.username }}</p>
      <button @click="goToSettings">Settings</button>
    </div>
  </template>
  
  <script lang="ts">
  import { defineComponent, onMounted, ref } from 'vue';
  import { useAuthStore } from '@/stores/auth';
  import { getProfileWithAvatarUrl } from '@/services/profileService';
  import { useRouter } from 'vue-router';
  import type { Profile } from '@/types';
  
  export default defineComponent({
    setup() {
      const authStore = useAuthStore();
      const profile = ref<Profile | null>(null);

      const router = useRouter();

      const goToSettings = () => {
        router.push({ name: 'Profile' });
      };

      onMounted(async () => {
        if (authStore.session?.user) {
          profile.value = await getProfileWithAvatarUrl(authStore.session.user.id);
        }
      });
  
      return { profile, goToSettings };
    },
  });
  </script>
  
  <style scoped>
    .user-profile {
      position:fixed;
      bottom:0;
      width:240px;
      background:#666;
      .avatar {
        width: 36px;
        height: 36px;
        border-radius: 50%;
      }
    }
  </style>
  