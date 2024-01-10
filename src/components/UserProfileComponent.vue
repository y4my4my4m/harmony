<template>
  <div class="user-profile" ref="profileCard">
    <h2>{{ user.username }}'s Profile</h2>
    <img :src="user.avatarUrl" alt="User avatar" class="profile-avatar">
    <!-- Additional profile details -->
  </div>
</template>


<script lang="ts">
import { defineComponent, ref, onMounted, onUnmounted } from 'vue';
import type { PropType, Ref } from 'vue';
import type { User } from '../types';

export default defineComponent({
  name: 'UserProfileComponent',
  props: {
    user: {
      type: Object as PropType<User>,
      required: true
    },
    closeProfile: Function
  },
  setup(props) {
    const profileCard: Ref<HTMLElement | null> = ref(null);

    const handleClickOutside = (event: MouseEvent) => {
    // Type assertion for event.target as Node
    const target = event.target as Node;

    if (profileCard.value && !profileCard.value.contains(target)) {
      if (props.closeProfile) {
        props.closeProfile();
      }
      }
    };

    onMounted(() => {
      document.addEventListener('click', handleClickOutside);
    });

    onUnmounted(() => {
      document.removeEventListener('click', handleClickOutside);
    });

    return { profileCard };
  }
});
</script>

<style scoped>
.user-profile {
  /* Styles for the user profile component */
  color: white;
}

.profile-avatar {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  margin-bottom: 10px;
}
</style>