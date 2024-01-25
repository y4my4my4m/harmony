<template>
  <div class="user-settings">
    <div v-if="profile" class="profile">
      <img class="avatar" :src="profile.avatar_url" alt="Avatar">
      <div class="info">
        <p><span class="label">Display Name:</span> <span :style="{ color: profile.color }">{{ profile.display_name }}</span></p>
        <p><span class="label">Username:</span> {{ profile.username }}</p>
        <p><span class="label">About:</span> {{ profile.about }}</p>
        <div class="profile-color">
          <span>Profile Color:</span>
          <div 
            class="color-preview" 
            :style="{ backgroundColor: color }" 
            ref="colorPreviewRef"
            @click="openColorPicker"
          ></div>
          &nbsp;{{  color }}
        </div>
      </div>
    </div>
    <input type="file" @change="onFileChange" class="file-input" />
    <ColorPicker
      v-if="!isLoadingProfile"
      v-show="showColorPicker"
      v-click-outside="closeColorPicker"
      ref="colorPickerRef"
      theme="light"
      :color="color"
      @changeColor="changeColor"
    />
    <div class="buttons">
      <button @click="signOut" class="btn sign-out">Sign Out</button>
      <button @click="back" class="btn back">Back</button>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { getProfileWithAvatarUrl, updateProfile, uploadAvatar } from '@/services/profileService';
import type { User } from '@/types';
import { useRouter } from 'vue-router';

import { ColorPicker } from 'vue-color-kit';
import 'vue-color-kit/dist/vue-color-kit.css';

export default defineComponent({
  components: {
    ColorPicker,
  },
  setup() {
    const router = useRouter();
    const authStore = useAuthStore();
    const profile = ref<User | null>(null);
    const color = ref('#cc33ff');
    const suckerCanvas = ref(null);
    const suckerArea = ref(null);
    const showColorPicker = ref(false);
    const colorPickerRef = ref<InstanceType<typeof ColorPicker>>();
    const colorPreviewRef = ref<HTMLElement | null>(null);
    const isLoadingProfile = ref(true); // Flag to indicate if the profile is loading

    const openColorPicker = (event: MouseEvent) => {
      event.stopPropagation();
      showColorPicker.value = true;
    };

    const closeColorPicker = async () => {
      showColorPicker.value = false;
      // Update the profile with the selected color
      if (profile.value && authStore.session?.user) {
        await updateProfile(authStore.session.user.id, { color: color.value });
      }

    };
    
    onMounted(async () => {
      if (authStore.session?.user) {
        profile.value = await getProfileWithAvatarUrl(authStore.session.user.id);
        if (profile.value && profile.value.color) {
          color.value = profile.value.color;
        }
        isLoadingProfile.value = false; // Set loading flag to false after fetching
      }
    });

    // Watch for profile changes and update the color
    watch(() => profile.value, (newProfile) => {
      if (newProfile && newProfile.color) {
        color.value = newProfile.color;
      } else {
        color.value = '#ffffff'; // Default color if no profile color is set
      }
    }, { immediate: true });


    const signOut = async () => {
      await authStore.logout();
      router.go(0); // refresh page
    };

    const back = async () => {
      router.push({ name: 'Chat' });
    };

    const handleAvatarUpload = async (file: File) => {
      if (authStore.session?.user) {
        const filePath = await uploadAvatar(authStore.session.user.id, file);
        await updateProfile(authStore.session.user.id, { avatar_url: filePath });
        profile.value = { ...profile.value, avatar_url: filePath };
      }
    };

    const openSucker = () => {
      console.log('Color picker activated');
      // Add your logic for when the color picker is activated
    };

    const inputFocus = () => {
      console.log('Color input focused');
      // Add logic for when the color input receives focus
    };

    const inputBlur = () => {
      console.log('Color input lost focus');
      // Add logic for when the color input loses focus
    };


    const clickOutside = {
      beforeMount(el: HTMLElement, binding: any) {
        const onClick = (event: MouseEvent) => {
          // Check if the click is outside the color picker and not on the color preview
          if (el && !el.contains(event.target as Node) &&
              (!colorPreviewRef.value || !colorPreviewRef.value.contains(event.target as Node))) {
            binding.value();
          }
        };
        el.__vueClickOutside__ = onClick;
        document.addEventListener('click', onClick);
      },
      unmounted(el: HTMLElement) {
        document.removeEventListener('click', el.__vueClickOutside__);
        el.__vueClickOutside__ = null;
      },
    };

    onBeforeUnmount(() => {
      // Clean up
      if (showColorPicker.value && colorPickerRef.value) {
        document.removeEventListener('click', colorPickerRef.value.__vueClickOutside__);
      }
    });

    const changeColor = (newColor: { hex: string }) => {
      color.value = newColor.hex; // Store the selected color temporarily
      if (profile.value) {
        profile.value = { ...profile.value, color: color.value };
      }
    };

    const onFileChange = async (event: Event) => {
      const target = event.target as HTMLInputElement;
      if (target.files?.[0]) {
        await handleAvatarUpload(target.files[0]);
      }
    };

    return { 
      profile,
      onFileChange,
      back,
      signOut,
      changeColor,
      color,
      suckerCanvas,
      suckerArea,
      openSucker,
      inputFocus,
      inputBlur,
      showColorPicker,
      openColorPicker,
      closeColorPicker,
      clickOutside,
      colorPreviewRef,
      isLoadingProfile
    };
  },
});
</script>


<style scoped>
  .user-settings {
    background-color: #36393f;
    padding: 20px;
    border-radius: 8px;
    max-width: 400px;
    margin: auto;
    color: white;
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  }

  .profile {
    display: flex;
    align-items: center;
    margin-bottom: 20px;
  }

  .avatar {
    width: 128px;
    height: 128px;
    border-radius: 50%;
    object-fit: cover;
    margin-right: 20px;
  }

  .info p {
    margin: 5px 0;
    font-size: 0.9rem;
  }

  .label {
    font-weight: bold;
  }

  .file-input {
    margin-bottom: 10px;
    cursor: pointer;
  }

  .buttons {
    display: flex;
    justify-content: space-between;
  }

  .btn {
    padding: 10px 15px;
    border: none;
    border-radius: 5px;
    color: white;
    cursor: pointer;
    transition: background-color 0.2s;
  }

  .sign-out {
    background-color: #f04747; /* Red color for sign out */
  }

  .back {
    background-color: #5865f2; /* Discord's primary blue color */
  }
  .btn:hover {
  opacity: 0.8;
  }

  .profile-color {
    display: flex;
    align-items: center;
    margin-bottom: 10px;
  }

  .color-preview {
    width: 20px;
    height: 20px;
    border: 1px solid #ccc;
    margin-left: 10px;
    cursor: pointer;
  }
  .hu-color-picker {
    position:absolute;
    right: 37%;
    top: 19%;
    width: 218px!important;
  }
</style>