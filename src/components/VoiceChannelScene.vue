<template>
  <div>
    <!-- 3D Spatial Audio Grid (shown when users are in voice channel) -->
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
      </div>
    </div>
    
    <!-- Unified WebRTC Component (always present for voice channels to handle auto-join) -->
    <UnifiedWebRTCComponent 
      v-if="isVoiceChannel"
      :channelId="currentChannelId"
      :serverId="serverId"
      :channel-name="getChannelName()"
      :auto-join="shouldAutoJoin"
    />
  </div>
</template>

<script lang="ts">
  import { defineComponent, ref, onMounted, nextTick, computed, watch } from 'vue';
  import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
  import { useServerChannelStore } from '@/stores/useServerChannel';
  import type { Point } from '@/types';

  import SpaceTimeGrid from '@/components/SpaceTimeGrid.vue'
  import UnifiedWebRTCComponent from '@/components/UnifiedWebRTCComponent.vue'

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
      UnifiedWebRTCComponent
    },
    setup(props) {
      const serverUsersStore = useServerUsersStore();
      const voiceChannelStore = useUnifiedVoiceChannelStore();
      const serverChannelStore = useServerChannelStore();
      const isVoiceChannelPopupVisible = ref(false);
      const shouldAutoJoin = ref(false);
      const gridContainer = ref<HTMLElement | null>(null);
      const containerWidth = ref(0);
      const containerHeight = ref(0);
      const avatarPositions = ref<Point[]>([]);
      const usersInCurrentChannel = computed(() => {
        return serverUsersStore.usersInVoiceChannels[props.currentChannelId] || [];
      });

      // Check if this is a voice channel by looking up the channel data
      const isVoiceChannel = computed(() => {
        const currentChannel = serverChannelStore.channels.find(
          channel => channel.id === props.currentChannelId
        );
        return currentChannel?.type === 1; // 1 = voice channel
      });

      // Note: Spatial positioning is disabled for now since it's part of the 3D audio feature
      // that's not currently implemented in the Discord-style WebRTC system
      // watch(() => voiceChannelStore.positions, (newPositions) => {
      //   avatarPositions.value = usersInCurrentChannel.value.map(userId => {
      //     return {x: newPositions[userId].x, y: newPositions[userId].y, color: getUserColorInRGB(userId)};
      //   });
      // }, { deep: true });

      // Check for auto-join flag on mount and whenever the channel changes
      watch(() => props.currentChannelId, () => {
        const hasAutoJoinFlag = sessionStorage.getItem('autoJoinVoiceChannel') === 'true';
        shouldAutoJoin.value = hasAutoJoinFlag && isVoiceChannel.value;
        
        console.log('🔍 VoiceChannelScene - Channel changed:', {
          channelId: props.currentChannelId,
          isVoiceChannel: isVoiceChannel.value,
          hasAutoJoinFlag,
          shouldAutoJoin: shouldAutoJoin.value
        });
      }, { immediate: true });

      // Show voice channel popup based on connection status and participants
      watch(() => [usersInCurrentChannel.value, voiceChannelStore.isConnected], () => {
        // Show popup if we're connected to this channel or if there are users in it
        const isCurrentChannelActive = voiceChannelStore.currentChannelId === props.currentChannelId;
        
        // Show if: connected to this channel or has users
        isVoiceChannelPopupVisible.value = isCurrentChannelActive || usersInCurrentChannel.value.length > 0;
      }, { immediate: true });

      const getUserAvatar = (userId: string): string => {
        return serverUsersStore.userProfiles[userId]?.avatar_url || '';
      };

      const getUserColorInRGB = (userId:string) => {
        return hexToRgb(`${serverUsersStore.userProfiles[userId]?.color || '#dddddd'}`);
      };

      const getProfileStyle = (userId: string) => {
        // For now, use a simple grid layout since 3D spatial positioning is disabled
        // TODO: Re-implement when 3D spatial audio feature is added back
        const index = usersInCurrentChannel.value.indexOf(userId);
        const position = { 
          x: (index % 3) * 100 + 50, 
          y: Math.floor(index / 3) * 100 + 50 
        };
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
        // Dragging is disabled for now since 3D spatial audio positioning is not implemented
        // in the Discord-style WebRTC system
        console.log('Dragging disabled - 3D spatial audio not implemented');
        return;
      };

      const onDrag = (event: MouseEvent) => {
        // Dragging is disabled for now
        return;
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

      const getChannelName = () => {
        const currentChannel = serverChannelStore.channels.find(
          channel => channel.id === props.currentChannelId
        );
        return currentChannel?.name || 'Voice Channel';
      };

      return { 
        isVoiceChannelPopupVisible, 
        isVoiceChannel,
        usersInCurrentChannel, 
        getUserAvatar, 
        startDrag, 
        closePopup,
        getProfileStyle,
        gridContainer,
        containerWidth,
        containerHeight,
        avatarPositions,
        getChannelName,
        shouldAutoJoin,
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