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
            @mousedown="startDrag()"
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
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'

interface Props {
  currentChannelId: string
  serverId: string
}

const props = defineProps<Props>()

const serverUsersStore = useServerUsersStore()
const voiceChannelStore = useUnifiedVoiceChannelStore()
const isVoiceChannelPopupVisible = ref(false)
const gridContainer = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
const containerHeight = ref(0)

const usersInCurrentChannel = computed(() => {
  return serverUsersStore.usersInVoiceChannels[props.currentChannelId] || []
})

// Show voice channel popup based on connection status and participants
watch(() => [usersInCurrentChannel.value, voiceChannelStore.isConnected], () => {
  // Show popup if we're connected to this channel or if there are users in it
  const isCurrentChannelActive = voiceChannelStore.currentChannelId === props.currentChannelId
  
  // Show if: connected to this channel or has users
  isVoiceChannelPopupVisible.value = isCurrentChannelActive || usersInCurrentChannel.value.length > 0
}, { immediate: true })

const getUserAvatar = (userId: string): string => {
  return serverUsersStore.userProfiles[userId]?.avatar_url || ''
}

const getProfileStyle = (userId: string) => {
  // For now, use a simple grid layout since 3D spatial positioning is disabled
  // TODO: Re-implement when 3D spatial audio feature is added back
  const index = usersInCurrentChannel.value.indexOf(userId)
  const position = { 
    x: (index % 3) * 100 + 50, 
    y: Math.floor(index / 3) * 100 + 50 
  }
  return {
    top: `${position.y}px`,
    left: `${position.x}px`
  }
}

const startDrag = () => {
  // Dragging is disabled for now since 3D spatial audio positioning is not implemented
  // in the Discord-style WebRTC system
  console.log('Dragging disabled - 3D spatial audio not implemented')
}

const closePopup = () => {
  isVoiceChannelPopupVisible.value = false
}

const updateDimensions = () => {
  if (gridContainer.value) {
    containerWidth.value = gridContainer.value.clientWidth
    containerHeight.value = gridContainer.value.clientHeight
  }
}

onMounted(() => {
  updateDimensions()
  window.addEventListener('resize', updateDimensions)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateDimensions)
})
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