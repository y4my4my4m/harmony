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
      </div>
      <!-- TODO: implement this, this is for 3D audio spacial awareness -->
      <!-- <SpaceTimeGrid 
        :width="containerWidth" 
        :height="containerHeight" 
        :avatars="avatarPositions" /> -->
      
      <!-- WebRTC Video/Audio Component -->
      <WebRTCComponent 
        :channelId="currentChannelId"
        :serverId="serverId"
        :showDebugInfo="false"
      />
    </div>
  </div>
</template>

<script lang="ts">
  import { defineComponent, ref, onMounted, nextTick, computed, watch } from 'vue';
  import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useVoiceChannelStore } from '@/stores/voiceChannel';
  import type { Point } from '@/types';

  import SpaceTimeGrid from '@/components/SpaceTimeGrid.vue'
  import WebRTCComponent from '@/components/WebRTCComponent.vue'

  export default defineComponent({
    name: 'VoiceChannelGrid',
    props: {
      currentChannelId: {
        type: String,
        required: true
      },
      serverId: {
        type: String,
        required: true
      },
    },
    components: {
      SpaceTimeGrid,
      WebRTCComponent
    },
    setup(props) {
      const serverUsersStore = useServerUsersStore();
      const voiceChannelStore = useVoiceChannelStore();
      const isVoiceChannelPopupVisible = ref(false);
      const gridContainer = ref<HTMLElement | null>(null);
      const containerWidth = ref(0);
      const containerHeight = ref(0);
      const avatarPositions = ref<Point[]>([]);
      const usersInCurrentChannel = computed(() => {
        return serverUsersStore.usersInVoiceChannels[props.currentChannelId] || [];
      });

      watch(() => voiceChannelStore.positions, (newPositions) => {
        avatarPositions.value = usersInCurrentChannel.value.map(userId => {
          return {x: newPositions[userId].x, y: newPositions[userId].y, color: getUserColorInRGB(userId)};
        });
      }, { deep: true });

      watch (usersInCurrentChannel, () => {
        // console.log(usersInCurrentChannel.value);
        if (usersInCurrentChannel.value.length > 0) {
          isVoiceChannelPopupVisible.value = true;
        } else {
          isVoiceChannelPopupVisible.value = false;
        }
      });

      const getUserAvatar = (userId: string): string => {
        return serverUsersStore.userProfiles[userId]?.avatar_url || '';
      };

      const getUserColorInRGB = (userId:string) => {
        return hexToRgb(`${serverUsersStore.userProfiles[userId]?.color || '#dddddd'}`);
      };

      const getProfileStyle = (userId: string) => {
        const position = voiceChannelStore.positions[userId] || { x: 0, y: 0 };
        return {
          top: `${position.y}px`,
          left: `${position.x}px`
        };
      };

      const hexToRgb = (hex: string): string | null => {
        if (hex.charAt(0) === '#') {
            hex = hex.substr(1);
        }

        if (hex.length !== 3 && hex.length !== 6) {
            return null;
        }

        let r: number = 0
        let g: number = 0
        let b: number = 0;

        if (hex.length === 3) {
            r = parseInt(hex.charAt(0) + hex.charAt(0), 16);
            g = parseInt(hex.charAt(1) + hex.charAt(1), 16);
            b = parseInt(hex.charAt(2) + hex.charAt(2), 16);
        } 
        else {
            r = parseInt(hex.substr(0, 2), 16);
            g = parseInt(hex.substr(2, 2), 16);
            b = parseInt(hex.substr(4, 2), 16);
        }

        return `rgb(${r}, ${g}, ${b})`;
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
        if (!selectedUserId.value || !gridContainer.value) return;
        const containerBounds = gridContainer.value.getBoundingClientRect();

        updateDimensions();
        const newPosition = {
          x: event.clientX - originalPosition.value.x,
          y: event.clientY - originalPosition.value.y
        };
        let newX = Math.max(0, Math.min(newPosition.x, containerBounds.width - 24)); // Assume avatar width is 48px
        let newY = Math.max(0, Math.min(newPosition.y, containerBounds.height - 24)); // Assume avatar height is 48px

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


      const updateDimensions = () => {
        if (gridContainer.value) {
          containerWidth.value = gridContainer.value.clientWidth;
          containerHeight.value = gridContainer.value.clientHeight;
        }
      };

      onMounted(() => {
        updateDimensions();
      });

      watch(() => window.innerWidth, updateDimensions);

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
    z-index:20;
  }
  
  .voice-channel-grid {
    position: relative;
    width: 90%;
    height: 60%;
    padding: 20px;
    box-shadow: 0 0 15px rgba(0, 0, 0, 0.5);
    /* background-color: #424242; */
    background-color: #121212;
    border-radius: 5px;
  }
  .voice-channel-grid::before{
    position:absolute;
    top:0;
    left:0;
    content: '';
    width: 100%;
    height:100%;
    background-image: url('/img/grid_bg1.png');
    background-size:cover;
    opacity: 0.025;
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