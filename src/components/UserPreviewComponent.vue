<template>
  <div class="user-preview" ref="profileCard">
    <Avatar :src="user.avatar_url" size="lg" alt="User avatar" class="preview-avatar" />
    <h2>{{ user.display_name }}</h2>
    <h4>{{ user.username }}</h4>
    <div class="user-preview-details">
      <div v-if="user.roles && user.roles.length > 0" class="role-pills">
        <span v-for="role in user.roles" :key="role.id" class="role-pill" :style="{ backgroundColor: role.color }">
          {{ role.name }}
        </span>
      </div>
      <hr/>
      <div class="about-title">About:</div>
      <textarea class="about" :value="user.bio" readonly>
      </textarea>
    </div>
    <!-- Additional profile details -->
  </div>
</template>


<script lang="ts">
import { defineComponent, ref, onMounted, onUnmounted } from 'vue';
import type { PropType, Ref } from 'vue';
import type { User } from '../types';
import Avatar from '@/components/common/Avatar.vue';

export default defineComponent({
  name: 'UserPreviewComponent',
  components: {
    Avatar
  },
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
  color: var(--text-primary);
}
.user-preview-details .bio-title {
  margin-top:1.25em;
  margin-bottom:.25em;
}
.user-preview-details .bio {
  border-radius: 4px;
  background-color: #292b2e; 
  padding: 10px 10px 120px 10px;
  box-shadow: 0 0 1px 1px rgba(255,255,255,0.03), inset 0 0 1px 1px rgba(0,0,0,0.1), inset 0 -1px 7px rgba(0,0,0,0.04);
  resize: none;
  width:100%;
  outline:none;
  border:0;
  color:#999;
  font-family: Arial, sans-serif;
}

hr {
  margin-top:1.25em;
  border-top: 1px solid hsl(216 10% 28% / 1);
  border-left: 0;
  border-bottom: 1px solid hsl(216 10% 13% / 1);
  border-right: 0;
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
  color: var(--text-primary);
}
</style>