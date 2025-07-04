<template>
  <div 
    class="voice-user-card"
    :class="{
      speaking: isActivelySpeaking,
      muted: isMuted,
      'video-enabled': hasVideo,
      'screen-sharing': isScreenSharing,
      'connection-poor': connectionQuality === 'poor',
      'connection-good': connectionQuality === 'good',
      'self': isSelf
    }"
  >
    <!-- Video Stream -->
    <div v-if="hasVideo || isScreenSharing" class="video-container">
      <video
        :ref="el => setVideoRef(el)"
        :srcObject="videoStream"
        autoplay
        playsinline
        :muted="isSelf"
        class="video-stream"
      />
      
      <!-- Video overlay controls -->
      <div class="video-overlay">
        <div class="video-controls" v-if="isSelf">
          <button 
            @click="$emit('toggleVideo')"
            class="control-btn video-btn"
            :class="{ active: hasVideo }"
          >
            <Icon name="camera" />
          </button>
          <button 
            @click="$emit('toggleScreenShare')"
            class="control-btn screen-btn"
            :class="{ active: isScreenSharing }"
          >
            <Icon name="screen-share" />
          </button>
        </div>
        
        <!-- Connection indicator -->
        <div class="connection-indicator" :class="connectionQuality">
          <div class="connection-dots">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </div>
    </div>

    <!-- Avatar/Audio-only view -->
    <div v-else class="avatar-container">
      <div class="avatar-wrapper">
        <img 
          :src="user.avatar_url || '/default_avatar.png'"
          :alt="user.display_name || user.username"
          class="user-avatar"
        />
        
        <!-- Voice activity ring -->
        <div class="voice-ring" :style="{ '--intensity': voiceIntensity }">
          <svg class="voice-ring-svg" viewBox="0 0 100 100">
            <circle 
              cx="50" 
              cy="50" 
              r="45" 
              class="voice-ring-bg"
            />
            <circle 
              cx="50" 
              cy="50" 
              r="45" 
              class="voice-ring-active"
              :style="{ strokeDashoffset: voiceRingOffset }"
            />
          </svg>
        </div>
        
        <!-- Status indicators -->
        <div class="status-indicators">
          <div v-if="isMuted" class="status-indicator muted">
            <Icon name="mic-off" />
          </div>
          <div v-if="isDeafened" class="status-indicator deafened">
            <Icon name="headphones-off" />
          </div>
          <div v-if="connectionQuality === 'poor'" class="status-indicator connection-poor">
            <Icon name="wifi-low" />
          </div>
        </div>
      </div>
    </div>

    <!-- User info -->
    <div class="user-info">
      <div class="username" :class="{ speaking: isActivelySpeaking }">
        {{ user.display_name || user.username || 'Unknown' }}
      </div>
      <div v-if="showActivity" class="user-activity">
        {{ getUserActivity }}
      </div>
    </div>

    <!-- Audio visualizer bars -->
    <div v-if="showAudioBars && isActivelySpeaking" class="audio-bars">
      <div 
        v-for="i in 5" 
        :key="i"
        class="audio-bar"
        :style="{ 
          '--delay': `${i * 50}ms`,
          '--height': `${getBarHeight(i)}%`
        }"
      ></div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch } from 'vue';
import Icon from '@/components/common/Icon.vue';

export default defineComponent({
  name: 'VoiceUserCard',
  components: { Icon },
  props: {
    user: {
      type: Object,
      required: true
    },
    videoStream: {
      type: MediaStream,
      default: null
    },
    audioLevel: {
      type: Number,
      default: 0
    },
    isMuted: {
      type: Boolean,
      default: false
    },
    isDeafened: {
      type: Boolean,
      default: false
    },
    hasVideo: {
      type: Boolean,
      default: false
    },
    isScreenSharing: {
      type: Boolean,
      default: false
    },
    connectionState: {
      type: String,
      default: 'connected'
    },
    isSelf: {
      type: Boolean,
      default: false
    },
    showActivity: {
      type: Boolean,
      default: true
    },
    showAudioBars: {
      type: Boolean,
      default: true
    }
  },
  emits: ['toggleVideo', 'toggleScreenShare'],
  setup(props) {
    const videoRef = ref<HTMLVideoElement | null>(null);
    
    // Voice activity computed properties
    const isActivelySpeaking = computed(() => props.audioLevel > 15);
    const voiceIntensity = computed(() => Math.min(props.audioLevel / 100, 1));
    
    // Connection quality
    const connectionQuality = computed(() => {
      if (props.connectionState === 'connecting') return 'connecting';
      if (props.connectionState === 'disconnected') return 'poor';
      return props.audioLevel > 50 ? 'good' : 'fair';
    });
    
    // Voice ring animation
    const voiceRingOffset = computed(() => {
      const circumference = 2 * Math.PI * 45;
      const progress = voiceIntensity.value;
      return circumference - (progress * circumference);
    });
    
    // User activity text
    const getUserActivity = computed(() => {
      if (props.isScreenSharing) return 'Screen sharing';
      if (props.hasVideo) return 'Camera on';
      if (props.isMuted) return 'Muted';
      if (props.isDeafened) return 'Deafened';
      if (isActivelySpeaking.value) return 'Speaking';
      return 'In voice';
    });
    
    // Audio bar heights for visualization
    const getBarHeight = (barIndex: number) => {
      const baseHeight = 20;
      const intensity = voiceIntensity.value;
      const variation = Math.sin(Date.now() / 100 + barIndex) * 0.3;
      return baseHeight + (intensity * 60) + (variation * 20);
    };
    
    // Video ref management
    const setVideoRef = (el: HTMLVideoElement | null) => {
      videoRef.value = el;
      // Set initial stream if available
      if (el && props.videoStream) {
        el.srcObject = props.videoStream;
      }
    };
    
    // Update video stream when prop changes
    watch(() => props.videoStream, (newStream) => {
      if (videoRef.value) {
        videoRef.value.srcObject = newStream;
      }
    }, { immediate: true });
    
    return {
      isActivelySpeaking,
      voiceIntensity,
      connectionQuality,
      voiceRingOffset,
      getUserActivity,
      getBarHeight,
      setVideoRef
    };
  }
});
</script>

<style scoped>
.voice-user-card {
  position: relative;
  background: linear-gradient(145deg, #2a2d35, #1e2127);
  border-radius: 16px;
  padding: 16px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  border: 2px solid transparent;
  overflow: hidden;
  min-height: 200px;
  box-shadow: 
    0 4px 12px rgba(0, 0, 0, 0.15),
    0 1px 3px rgba(0, 0, 0, 0.2);
}

.voice-user-card:hover {
  transform: translateY(-2px);
  box-shadow: 
    0 8px 25px rgba(0, 0, 0, 0.2),
    0 3px 8px rgba(0, 0, 0, 0.15);
}

.voice-user-card.speaking {
  border-color: #00d4aa;
  background: linear-gradient(145deg, #2a3b35, #1e2a27);
  box-shadow: 
    0 4px 12px rgba(0, 212, 170, 0.2),
    0 0 20px rgba(0, 212, 170, 0.1);
}

.voice-user-card.self {
  border-color: #5865f2;
  background: linear-gradient(145deg, #2a2d45, #1e2137);
}

.voice-user-card.connection-poor {
  border-color: #faa61a;
}

/* Video Container */
.video-container {
  position: relative;
  width: 100%;
  height: 160px;
  border-radius: 12px;
  overflow: hidden;
  background: #000;
  margin-bottom: 12px;
}

.video-stream {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.video-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    transparent 70%,
    rgba(0, 0, 0, 0.8) 100%
  );
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  padding: 12px;
}

.video-controls {
  display: flex;
  gap: 8px;
}

.control-btn {
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(8px);
  border: none;
  border-radius: 50%;
  width: 32px;
  height: 32px;
  color: #ffffff;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.control-btn:hover {
  background: rgba(0, 0, 0, 0.8);
  transform: scale(1.1);
}

.control-btn.active {
  background: #5865f2;
  color: white;
}

/* Avatar Container */
.avatar-container {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 160px;
  margin-bottom: 12px;
}

.avatar-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.user-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  object-fit: cover;
  border: 3px solid #40444b;
  transition: all 0.3s ease;
}

.voice-user-card.speaking .user-avatar {
  border-color: #00d4aa;
  box-shadow: 0 0 20px rgba(0, 212, 170, 0.3);
}

/* Voice Ring Animation */
.voice-ring {
  position: absolute;
  top: -10px;
  left: -10px;
  right: -10px;
  bottom: -10px;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.voice-user-card.speaking .voice-ring {
  opacity: 1;
}

.voice-ring-svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.voice-ring-bg {
  fill: none;
  stroke: rgba(0, 212, 170, 0.2);
  stroke-width: 2;
}

.voice-ring-active {
  fill: none;
  stroke: #00d4aa;
  stroke-width: 3;
  stroke-linecap: round;
  stroke-dasharray: 283;
  transition: stroke-dashoffset 0.1s ease;
  filter: drop-shadow(0 0 4px #00d4aa);
}

/* Status Indicators */
.status-indicators {
  position: absolute;
  bottom: -4px;
  right: -4px;
  display: flex;
  gap: 4px;
}

.status-indicator {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  border: 2px solid #2a2d35;
}

.status-indicator.muted {
  background: #ed4245;
  color: white;
}

.status-indicator.deafened {
  background: #faa61a;
  color: white;
}

.status-indicator.connection-poor {
  background: #faa61a;
  color: white;
}

/* Connection Indicator */
.connection-indicator {
  display: flex;
  align-items: center;
}

.connection-dots {
  display: flex;
  gap: 2px;
}

.connection-dots span {
  width: 4px;
  height: 4px;
  background: #40444b;
  border-radius: 50%;
  transition: all 0.3s ease;
}

.connection-indicator.good .connection-dots span {
  background: #00d4aa;
}

.connection-indicator.fair .connection-dots span:nth-child(-n+2) {
  background: #faa61a;
}

.connection-indicator.poor .connection-dots span:first-child {
  background: #ed4245;
}

.connection-indicator.connecting .connection-dots span {
  background: #5865f2;
  animation: pulse 1.5s infinite;
}

/* User Info */
.user-info {
  text-align: center;
}

.username {
  font-weight: 600;
  font-size: 14px;
  color: #dcddde;
  margin-bottom: 4px;
  transition: color 0.3s ease;
}

.username.speaking {
  color: #00d4aa;
}

.user-activity {
  font-size: 12px;
  color: #b9bbbe;
  opacity: 0.8;
}

/* Audio Bars */
.audio-bars {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
  align-items: flex-end;
  height: 20px;
}

.audio-bar {
  width: 3px;
  background: linear-gradient(to top, #00d4aa, #00f5d4);
  border-radius: 2px;
  transition: height 0.1s ease;
  animation: audioWave 0.8s ease-in-out infinite;
  animation-delay: var(--delay);
  height: var(--height);
  min-height: 4px;
}

/* Animations */
@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

@keyframes audioWave {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(1.5); }
}

/* Responsive */
@media (max-width: 768px) {
  .voice-user-card {
    min-height: 150px;
    padding: 12px;
  }
  
  .video-container,
  .avatar-container {
    height: 120px;
  }
  
  .user-avatar {
    width: 60px;
    height: 60px;
  }
}
</style>