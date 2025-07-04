<template>
  <div class="webrtc-container">
    <!-- Local video stream -->
    <div v-if="localStream" class="local-video-container">
      <video 
        ref="localVideoRef"
        :srcObject="localStream"
        autoplay
        muted
        playsinline
        class="local-video"
      />
      <div class="local-video-controls">
        <button @click="toggleVideo" :class="{ active: isVideoEnabled }">
          <Camera v-if="isVideoEnabled" />
          <span v-else>📹</span>
        </button>
        <button @click="toggleScreenShare" :class="{ active: isScreenSharing }">
          🖥️
        </button>
      </div>
    </div>

    <!-- Remote video streams -->
    <div class="remote-videos-container">
      <div 
        v-for="userId in connectedUsers" 
        :key="userId"
        class="remote-video-wrapper"
      >
        <video 
          :ref="el => setRemoteVideoRef(userId, el)"
          :srcObject="getRemoteStream(userId)"
          autoplay
          playsinline
          class="remote-video"
        />
        <div class="remote-video-overlay">
          <div class="user-info">
            <img 
              :src="getUserAvatar(userId)"
              :alt="getUserName(userId)"
              class="user-avatar"
            />
            <span class="user-name">{{ getUserName(userId) }}</span>
          </div>
          <div class="audio-indicator" :class="{ active: getAudioLevel(userId) > 10 }">
            <div class="audio-level-bar" :style="{ height: `${getAudioLevel(userId) / 2}%` }"></div>
          </div>
          <div class="connection-state" :class="getConnectionState(userId)">
            <span v-if="getConnectionState(userId) === 'connecting'">🔄</span>
            <span v-else-if="getConnectionState(userId) === 'connected'">✅</span>
            <span v-else>❌</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Audio-only users (when video is disabled) -->
    <div class="audio-only-users">
      <div 
        v-for="userId in audioOnlyUsers" 
        :key="userId"
        class="audio-user"
      >
        <img 
          :src="getUserAvatar(userId)"
          :alt="getUserName(userId)"
          class="audio-user-avatar"
          :class="{ speaking: getAudioLevel(userId) > 10 }"
        />
        <span class="audio-user-name">{{ getUserName(userId) }}</span>
      </div>
    </div>

    <!-- Voice controls -->
    <div class="voice-controls">
      <button 
        @click="toggleMute" 
        :class="{ 
          active: !isMuted,
          muted: isMuted,
          deafened: isDeafened 
        }"
        class="control-button mic-button"
      >
        <Mic v-if="!isMuted" />
        <MicMuted v-else />
      </button>
      
      <button 
        @click="toggleDeafen" 
        :class="{ 
          active: !isDeafened,
          deafened: isDeafened 
        }"
        class="control-button headphones-button"
      >
        <Headphones v-if="!isDeafened" />
        <span v-else>🔇</span>
      </button>
      
      <button 
        @click="leaveChannel" 
        class="control-button leave-button"
      >
        📞
      </button>
    </div>

    <!-- Debug info -->
    <div v-if="showDebugInfo" class="debug-info">
      <div>Connected Users: {{ connectedUsers.length }}</div>
      <div>Audio: {{ isAudioEnabled ? 'On' : 'Off' }}</div>
      <div>Video: {{ isVideoEnabled ? 'On' : 'Off' }}</div>
      <div>Screen Share: {{ isScreenSharing ? 'On' : 'Off' }}</div>
      <div>Muted: {{ isMuted ? 'Yes' : 'No' }}</div>
      <div>Deafened: {{ isDeafened ? 'Yes' : 'No' }}</div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useVoiceChannelStore } from '@/stores/voiceChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import Camera from '@/components/icons/Camera.vue';
import Mic from '@/components/icons/Mic.vue';
import MicMuted from '@/components/icons/MicMuted.vue';
import Headphones from '@/components/icons/Headphones.vue';

export default defineComponent({
  name: 'WebRTCComponent',
  components: {
    Camera,
    Mic,
    MicMuted,
    Headphones,
  },
  props: {
    channelId: {
      type: String,
      required: true,
    },
    serverId: {
      type: String,
      required: true,
    },
    showDebugInfo: {
      type: Boolean,
      default: false,
    },
  },
  setup(props) {
    const voiceChannelStore = useVoiceChannelStore();
    const serverUsersStore = useServerUsersStore();
    
    const localVideoRef = ref<HTMLVideoElement | null>(null);
    const remoteVideoRefs = ref<Map<string, HTMLVideoElement>>(new Map());
    
    // Computed properties
    const localStream = computed(() => voiceChannelStore.localStream);
    const connectedUsers = computed(() => voiceChannelStore.connectedUsers);
    const isVideoEnabled = computed(() => voiceChannelStore.isVideoEnabled);
    const isScreenSharing = computed(() => voiceChannelStore.isScreenSharing);
    const isMuted = computed(() => voiceChannelStore.isMuted);
    const isDeafened = computed(() => voiceChannelStore.isDeafened);
    const isAudioEnabled = computed(() => voiceChannelStore.isAudioEnabled);
    
    // Audio-only users (users without video streams)
    const audioOnlyUsers = computed(() => {
      return connectedUsers.value.filter(userId => {
        const stream = voiceChannelStore.getUserStream(userId);
        return !stream || stream.getVideoTracks().length === 0;
      });
    });
    
    // Methods
    const setRemoteVideoRef = (userId: string, el: HTMLVideoElement | null) => {
      if (el) {
        remoteVideoRefs.value.set(userId, el);
        // Set the stream if it exists
        const stream = voiceChannelStore.getUserStream(userId);
        if (stream) {
          el.srcObject = stream;
        }
      }
    };
    
    const getRemoteStream = (userId: string) => {
      return voiceChannelStore.getUserStream(userId);
    };
    
    const getUserAvatar = (userId: string) => {
      const user = serverUsersStore.userProfiles[userId];
      return user?.avatar_url || '/default_avatar.png';
    };
    
    const getUserName = (userId: string) => {
      const user = serverUsersStore.userProfiles[userId];
      return user?.display_name || user?.username || 'Unknown';
    };
    
    const getAudioLevel = (userId: string) => {
      return voiceChannelStore.getAudioLevel(userId);
    };
    
    const getConnectionState = (userId: string) => {
      return voiceChannelStore.getConnectionState(userId);
    };
    
    // Control methods
    const toggleVideo = async () => {
      await voiceChannelStore.toggleVideo();
    };
    
    const toggleScreenShare = async () => {
      await voiceChannelStore.toggleScreenShare();
    };
    
    const toggleMute = () => {
      voiceChannelStore.toggleMute();
    };
    
    const toggleDeafen = () => {
      voiceChannelStore.toggleDeafen();
    };
    
    const leaveChannel = async () => {
      await voiceChannelStore.leaveVoiceChannel();
    };
    
    // Auto-connect when component mounts
    onMounted(async () => {
      if (props.channelId && props.serverId) {
        await voiceChannelStore.joinVoiceChannel(props.channelId, props.serverId);
      }
    });
    
    // Auto-disconnect when component unmounts
    onUnmounted(async () => {
      await voiceChannelStore.leaveVoiceChannel();
    });
    
    // Watch for local stream changes
    const updateLocalVideo = () => {
      nextTick(() => {
        if (localVideoRef.value && localStream.value) {
          localVideoRef.value.srcObject = localStream.value;
        }
      });
    };
    
    // Watch for remote stream changes
    const updateRemoteVideos = () => {
      nextTick(() => {
        connectedUsers.value.forEach(userId => {
          const videoEl = remoteVideoRefs.value.get(userId);
          const stream = voiceChannelStore.getUserStream(userId);
          if (videoEl && stream) {
            videoEl.srcObject = stream;
          }
        });
      });
    };
    
    // Update videos when streams change
    const unwatchLocalStream = voiceChannelStore.$subscribe((mutation, state) => {
      if (mutation.type === 'direct' && mutation.payload && 'localStream' in mutation.payload) {
        updateLocalVideo();
      }
    });
    
    const unwatchRemoteStreams = voiceChannelStore.$subscribe((mutation, state) => {
      if (mutation.type === 'direct' && mutation.payload && 'remoteStreams' in mutation.payload) {
        updateRemoteVideos();
      }
    });
    
    onUnmounted(() => {
      unwatchLocalStream();
      unwatchRemoteStreams();
    });
    
    return {
      localVideoRef,
      localStream,
      connectedUsers,
      audioOnlyUsers,
      isVideoEnabled,
      isScreenSharing,
      isMuted,
      isDeafened,
      isAudioEnabled,
      setRemoteVideoRef,
      getRemoteStream,
      getUserAvatar,
      getUserName,
      getAudioLevel,
      getConnectionState,
      toggleVideo,
      toggleScreenShare,
      toggleMute,
      toggleDeafen,
      leaveChannel,
    };
  },
});
</script>

<style scoped>
.webrtc-container {
  position: absolute;
  width: 100%;
  height: 100%;
  inset: 0;
  background: #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
}

.local-video-container {
  position: absolute;
  bottom: 20px;
  right: 20px;
  width: 200px;
  height: 150px;
  border-radius: 8px;
  overflow: hidden;
  background: #2a2a2a;
  z-index: 10;
  border: 2px solid #444;
}

.local-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.local-video-controls {
  position: absolute;
  bottom: 5px;
  right: 5px;
  display: flex;
  gap: 5px;
}

.local-video-controls button {
  background: rgba(0, 0, 0, 0.7);
  border: none;
  border-radius: 50%;
  width: 30px;
  height: 30px;
  color: white;
  cursor: pointer;
  font-size: 12px;
}

.local-video-controls button.active {
  background: #5865f2;
}

.remote-videos-container {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 10px;
  padding: 20px;
  height: 100%;
}

.remote-video-wrapper {
  position: relative;
  background: #2a2a2a;
  border-radius: 8px;
  overflow: hidden;
  min-height: 200px;
}

.remote-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.remote-video-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 70%, rgba(0,0,0,0.7) 100%);
  pointer-events: none;
}

.user-info {
  position: absolute;
  bottom: 10px;
  left: 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  color: white;
}

.user-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 2px solid white;
}

.user-name {
  font-size: 14px;
  font-weight: 500;
}

.audio-indicator {
  position: absolute;
  bottom: 10px;
  right: 10px;
  width: 20px;
  height: 20px;
  background: rgba(0, 0, 0, 0.7);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.audio-indicator.active {
  background: #00ff00;
}

.audio-level-bar {
  width: 4px;
  background: #00ff00;
  transition: height 0.1s;
}

.connection-state {
  position: absolute;
  top: 10px;
  right: 10px;
  font-size: 12px;
}

.connection-state.connecting {
  color: #ffaa00;
}

.connection-state.connected {
  color: #00ff00;
}

.connection-state.disconnected {
  color: #ff0000;
}

.audio-only-users {
  position: absolute;
  top: 20px;
  left: 20px;
  display: flex;
  flex-wrap: wrap;
  gap: 15px;
  z-index: 5;
}

.audio-user {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
}

.audio-user-avatar {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  border: 3px solid #444;
  transition: border-color 0.2s;
}

.audio-user-avatar.speaking {
  border-color: #00ff00;
  box-shadow: 0 0 10px rgba(0, 255, 0, 0.3);
}

.audio-user-name {
  font-size: 12px;
  color: white;
  text-align: center;
}

.voice-controls {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  z-index: 10;
}

.control-button {
  background: rgba(0, 0, 0, 0.7);
  border: none;
  border-radius: 50%;
  width: 50px;
  height: 50px;
  color: white;
  cursor: pointer;
  font-size: 16px;
  transition: all 0.2s;
}

.control-button:hover {
  background: rgba(0, 0, 0, 0.9);
}

.control-button.active {
  background: #5865f2;
}

.mic-button.muted {
  background: #ed4245;
}

.headphones-button.deafened {
  background: #ed4245;
}

.leave-button {
  background: #ed4245;
}

.leave-button:hover {
  background: #c13236;
}

.debug-info {
  position: absolute;
  top: 10px;
  left: 10px;
  background: rgba(0, 0, 0, 0.8);
  color: white;
  padding: 10px;
  border-radius: 5px;
  font-size: 12px;
  z-index: 10;
}

.debug-info div {
  margin-bottom: 5px;
}
</style>
