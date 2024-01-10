<template>
  <div class="user-preview" ref="profileCard">
    <img :src="user.avatarUrl" alt="User avatar" class="preview-avatar">
    <div class="user-preview-details">
      <h2>{{ user.display_name }}</h2>
      <h4>{{ user.username }}</h4>
      <br/>
      <div class="role-pills">
        <span v-for="role in user.roles" :key="role.id" class="role-pill" :style="{ backgroundColor: role.color }">
          {{ role.name }}
        </span>
      </div>
      <br/>
      <div>
        <span>About:</span>
      </div>
    </div>
    <!-- Additional profile details -->
  </div>
</template>


<script lang="ts">
import { defineComponent, ref, onMounted, onUnmounted } from 'vue';
import type { PropType, Ref } from 'vue';
import type { User } from '../types';

export default defineComponent({
  name: 'UserPreviewComponent',
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
.user-preview {
  /* Styles for the user profile component */
  color: white;
}

.preview-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  margin-bottom: 10px;
}
.role-pill {
  display: inline-block;
  padding: 5px 10px;
  border-radius: 20px;
  margin: 0 5px;
  font-size: 0.8em;
  font-weight: bold;
  color: white;
}
</style>