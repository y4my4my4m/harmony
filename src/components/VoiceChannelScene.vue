<template>
  <div v-if="isVoiceChannelPopupVisible" class="overlay" @click="closePopup">
    <div class="voice-channel-grid" @click.stop>
      <div ref="gridContainer" class="voice-channel-grid-container">
        <div 
          v-for="userId in usersInCurrentChannel" 
          :key="userId" 
          class="profile-avatar" 
          :style="getProfileStyle(userId)"
          @mousedown="startDrag(userId, $event)"
        >
          <img 
            :src="getUserAvatar(userId)" 
            alt="User Avatar"
            draggable="false"
          >
        </div>
        <SpaceTimeGrid :width="615" :height="550" :avatars="avatarPositions" />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
  import { defineComponent, ref, onMounted, nextTick, computed, watch } from 'vue';
  import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useVoiceChannelStore } from '@/stores/voiceChannel';
  import type { Point } from '@/types';

  import SpaceTimeGrid from '@/components/SpaceTimeGrid.vue'

  export default defineComponent({
    name: 'VoiceChannelGrid',
    props: {
      currentChannelId: {
        type: String,
        required: true
      },
    },
    components: {
      SpaceTimeGrid
    },
    setup(props) {
      const serverUsersStore = useServerUsersStore();
      const voiceChannelStore = useVoiceChannelStore();
      const isVoiceChannelPopupVisible = ref(false);
      const gridContainer = ref(null);
      const containerWidth = ref(0);
      const containerHeight = ref(0);
      const avatarPositions = ref<Point[]>([]);
      const usersInCurrentChannel = computed(() => {
        return serverUsersStore.usersInVoiceChannels[props.currentChannelId] || [];
      });

      watch(() => voiceChannelStore.positions, (newPositions) => {
        avatarPositions.value = usersInCurrentChannel.value.map(userId => {
          return newPositions[userId] || { x: 0, y: 0 };
        });
      }, { deep: true });

      watch (usersInCurrentChannel, () => {
        console.log(usersInCurrentChannel.value);
        if (usersInCurrentChannel.value.length > 0) {
          isVoiceChannelPopupVisible.value = true;
        } else {
          isVoiceChannelPopupVisible.value = false;
        }
      });

      const getUserAvatar = (userId: string): string => {
        return serverUsersStore.userProfiles[userId]?.avatar_url || '';
      };

      const getProfileStyle = (userId: string) => {
        const position = voiceChannelStore.positions[userId] || { x: 0, y: 0 };
        return {
          top: `${position.y}px`,
          left: `${position.x}px`
        };
      };

      let selectedUserId = ref<string | null>(null);
      let originalPosition = ref({ x: 0, y: 0 });

      const startDrag = (userId: string, event: MouseEvent) => {
        selectedUserId.value = userId;
        const currentPosition = voiceChannelStore.positions[userId] || { x: 0, y: 0 };
        originalPosition.value.x = event.clientX - currentPosition.x;
        originalPosition.value.y = event.clientY - currentPosition.y;
        window.addEventListener('mousemove', onDrag);
        window.addEventListener('mouseup', endDrag);
      };

      const onDrag = (event: MouseEvent) => {
        if (!selectedUserId.value) return;
        const containerBounds = gridContainer.value.getBoundingClientRect();

        const newPosition = {
          x: event.clientX - originalPosition.value.x,
          y: event.clientY - originalPosition.value.y
        };
        let newX = Math.max(0, Math.min(newPosition.x, containerBounds.width - 48)); // Assume avatar width is 48px
        let newY = Math.max(0, Math.min(newPosition.y, containerBounds.height - 48)); // Assume avatar height is 48px

        voiceChannelStore.setProfilePosition(selectedUserId.value, { x: newX, y: newY });
      };


      const endDrag = () => {
        window.removeEventListener('mousemove', onDrag);
        window.removeEventListener('mouseup', endDrag);
        selectedUserId.value = null;

      };

      const closePopup = () => {
        isVoiceChannelPopupVisible.value = false;
      };
      const updateDimensions = async () => {
        await nextTick();
        if (gridContainer.value) {
          containerWidth.value = gridContainer.value.clientWidth;
          containerHeight.value = gridContainer.value.clientHeight;
        }
      };

      onMounted(async () => {
        await updateDimensions();
      });

      watch(() => window.innerWidth, async () => {
        await updateDimensions();
      });
      
      return { 
        isVoiceChannelPopupVisible, 
        usersInCurrentChannel, 
        getUserAvatar, 
        startDrag, 
        closePopup,
        getProfileStyle,
        gridContainer,
        containerWidth,
        containerHeight,
        avatarPositions,
      };
    }
  });
</script>

  
<style scoped>
  .overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    /* justify-content: flex-start; */
    align-items: center;
  }
  
  .voice-channel-grid {
    position: relative;
    width: 90%;
    height: 60%;
    padding: 20px;
    box-shadow: 0 0 15px rgba(0, 0, 0, 0.5);
    background-color: #424242;
    border-radius: 5px;
  }
  .voice-channel-grid-container {
    position: relative;
    height: 100%;
  }
  
  .profile-avatar {
    position: absolute;
    cursor: pointer;
    width: 48px;
    height: 48px;
    z-index:100;
  }
  .profile-avatar img {
    width: 48px;
    height: 48px;
    border-radius: 50%;
  }
  
</style>