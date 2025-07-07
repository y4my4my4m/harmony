<template>
  <svg 
    :class="['icon', `icon-${name}`, { [`icon-${size}`]: size }]"
    :width="iconSize" 
    :height="iconSize" 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    stroke-width="2" 
    stroke-linecap="round" 
    stroke-linejoin="round"
  >
    <!-- Camera -->
    <path v-if="name === 'camera'" d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
    <circle v-if="name === 'camera'" cx="12" cy="13" r="4"></circle>
    
    <!-- Camera Off -->
    <line v-if="name === 'camera-off'" x1="1" y1="1" x2="23" y2="23"></line>
    <path v-if="name === 'camera-off'" d="m21 21-3.6-3.6c-.2.1-.4.2-.6.2H3a2 2 0 0 1-2-2V8c0-.4.1-.8.3-1.2L5 10.7V19h10.7l-2.4-2.4"></path>
    
    <!-- Screen Share -->
    <rect v-if="name === 'screen-share'" x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
    <line v-if="name === 'screen-share'" x1="8" y1="21" x2="16" y2="21"></line>
    <line v-if="name === 'screen-share'" x1="12" y1="17" x2="12" y2="21"></line>
    
    <!-- Microphone -->
    <path v-if="name === 'mic'" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
    <path v-if="name === 'mic'" d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
    <line v-if="name === 'mic'" x1="12" y1="19" x2="12" y2="23"></line>
    <line v-if="name === 'mic'" x1="8" y1="23" x2="16" y2="23"></line>
    
    <!-- Microphone Off -->
    <line v-if="name === 'mic-off'" x1="1" y1="1" x2="23" y2="23"></line>
    <path v-if="name === 'mic-off'" d="M9 9v3a3 3 0 0 0 5.12 2.12l1.27-1.27A3 3 0 0 0 15 12V4a3 3 0 0 0-6 0v.17"></path>
    <path v-if="name === 'mic-off'" d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
    <line v-if="name === 'mic-off'" x1="12" y1="19" x2="12" y2="23"></line>
    <line v-if="name === 'mic-off'" x1="8" y1="23" x2="16" y2="23"></line>
    
    <!-- Headphones -->
    <path v-if="name === 'headphones'" d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
    <path v-if="name === 'headphones'" d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zm-14 0a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"></path>
    
    <!-- Headphones Off -->
    <path v-if="name === 'headphones-off'" d="M21 14h-1.343a2 2 0 0 0-1.414.586L17 16.828V19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 .586-1.414L14.828 13"></path>
    <path v-if="name === 'headphones-off'" d="M7 14H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2z"></path>
    <line v-if="name === 'headphones-off'" x1="1" y1="1" x2="23" y2="23"></line>
    
    <!-- Phone -->
    <path v-if="name === 'phone'" d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
    
    <!-- Phone Off -->
    <path v-if="name === 'phone-off'" d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path>
    <line v-if="name === 'phone-off'" x1="23" y1="1" x2="1" y2="23"></line>
    
    <!-- WiFi Low -->
    <path v-if="name === 'wifi-low'" d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9z"></path>
    <path v-if="name === 'wifi-low'" d="M5 13l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.24 9.24 8.76 9.24 5 13z"></path>
    <line v-if="name === 'wifi-low'" x1="1" y1="1" x2="23" y2="23"></line>
    
    <!-- Settings -->
    <circle v-if="name === 'settings'" cx="12" cy="12" r="3"></circle>
    <path v-if="name === 'settings'" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1 1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    
    <!-- Volume -->
    <polygon v-if="name === 'volume'" points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <path v-if="name === 'volume'" d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
    
    <!-- Volume Off -->
    <polygon v-if="name === 'volume-off'" points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <line v-if="name === 'volume-off'" x1="23" y1="9" x2="17" y2="15"></line>
    <line v-if="name === 'volume-off'" x1="17" y1="9" x2="23" y2="15"></line>
    
    <!-- Expand -->
    <polyline v-if="name === 'expand'" points="15,3 21,3 21,9"></polyline>
    <polyline v-if="name === 'expand'" points="9,21 3,21 3,15"></polyline>
    <line v-if="name === 'expand'" x1="21" y1="3" x2="14" y2="10"></line>
    <line v-if="name === 'expand'" x1="3" y1="21" x2="10" y2="14"></line>
    
    <!-- X (Close) -->
    <line v-if="name === 'x'" x1="18" y1="6" x2="6" y2="18"></line>
    <line v-if="name === 'x'" x1="6" y1="6" x2="18" y2="18"></line>
    
    <!-- Grid -->
    <rect v-if="name === 'grid'" x="3" y="3" width="7" height="7"></rect>
    <rect v-if="name === 'grid'" x="14" y="3" width="7" height="7"></rect>
    <rect v-if="name === 'grid'" x="14" y="14" width="7" height="7"></rect>
    <rect v-if="name === 'grid'" x="3" y="14" width="7" height="7"></rect>
    
    <!-- List -->
    <line v-if="name === 'list'" x1="8" y1="6" x2="21" y2="6"></line>
    <line v-if="name === 'list'" x1="8" y1="12" x2="21" y2="12"></line>
    <line v-if="name === 'list'" x1="8" y1="18" x2="21" y2="18"></line>
    <line v-if="name === 'list'" x1="3" y1="6" x2="3.01" y2="6"></line>
    <line v-if="name === 'list'" x1="3" y1="12" x2="3.01" y2="12"></line>
    <line v-if="name === 'list'" x1="3" y1="18" x2="3.01" y2="18"></line>
    
    <!-- Picture in Picture -->
    <path v-if="name === 'picture-in-picture'" d="M2 3a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h20a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H2z"></path>
    <path v-if="name === 'picture-in-picture'" d="M13 8.5v7h7v-7h-7z"></path>
    
    <!-- Keyboard -->
    <rect v-if="name === 'keyboard'" x="2" y="4" width="20" height="16" rx="2"></rect>
    <path v-if="name === 'keyboard'" d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M7 16h10"></path>

    <!-- Maximize -->
    <rect v-if="name === 'maximize'" x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <polyline v-if="name === 'maximize'" points="7 7 7 5 5 5 5 7"></polyline>
    <polyline v-if="name === 'maximize'" points="17 7 19 7 19 5 17 5"></polyline>
    <polyline v-if="name === 'maximize'" points="17 17 19 17 19 19 17 19"></polyline>
    <polyline v-if="name === 'maximize'" points="7 17 7 19 5 19 5 17"></polyline>

    <!-- Minimize -->
    <rect v-if="name === 'minimize'" x="3" y="11" width="18" height="2" rx="1" ry="1"></rect>
    
    <!-- User -->
    <circle v-if="name === 'user'" cx="12" cy="7" r="4"></circle>
    <path v-if="name === 'user'" d="M20 21v-2a7 5 0 0 0-16 0v2"></path>
    
    <!-- Map -->
    <polygon v-if="name === 'map'" points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
    <line v-if="name === 'map'" x1="8" y1="2" x2="8" y2="18"></line>
    <line v-if="name === 'map'" x1="16" y1="6" x2="16" y2="22"></line>
    
    <!-- Volume Spatial -->
    <polygon v-if="name === 'volume-spatial'" points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
    <circle v-if="name === 'volume-spatial'" cx="19" cy="9" r="2"></circle>
    <circle v-if="name === 'volume-spatial'" cx="17" cy="15" r="1.5"></circle>
    <circle v-if="name === 'volume-spatial'" cx="21" cy="15" r="1"></circle>
    
    <!-- Refresh -->
    <polyline v-if="name === 'refresh'" points="23 4 23 10 17 10"></polyline>
    <polyline v-if="name === 'refresh'" points="1 20 1 14 7 14"></polyline>
    <path v-if="name === 'refresh'" d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
    
    <!-- Shuffle -->
    <polyline v-if="name === 'shuffle'" points="16 3 21 3 21 8"></polyline>
    <line v-if="name === 'shuffle'" x1="4" y1="7" x2="4" y2="7"></line>
    <line v-if="name === 'shuffle'" x1="21" y1="3" x2="11" y2="13"></line>
    <line v-if="name === 'shuffle'" x1="16" y1="21" x2="21" y2="16"></line>
    <line v-if="name === 'shuffle'" x1="4" y1="17" x2="9" y2="12"></line>
    
    <!-- Check Circle -->
    <path v-if="name === 'check-circle'" d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
    <polyline v-if="name === 'check-circle'" points="22 4 12 14.01 9 11.01"></polyline>
    
    <!-- Circle -->
    <circle v-if="name === 'circle'" cx="12" cy="12" r="10"></circle>
  </svg>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';

export default defineComponent({
  name: 'IconComponent',
  props: {
    name: {
      type: String,
      required: true
    },
    size: {
      type: String,
      default: 'md',
      validator: (value: string) => ['xs', 'sm', 'md', 'lg', 'xl'].includes(value)
    }
  },
  setup(props) {
    const iconSize = computed(() => {
      const sizes = {
        xs: 12,
        sm: 16,
        md: 20,
        lg: 24,
        xl: 28
      };
      return sizes[props.size as keyof typeof sizes];
    });

    return {
      iconSize
    };
  }
});
</script>

<style scoped>
.icon {
  display: inline-block;
  vertical-align: middle;
  transition: all 0.2s ease;
}

.icon-xs { width: 12px; height: 12px; }
.icon-sm { width: 16px; height: 16px; }
.icon-md { width: 20px; height: 20px; }
.icon-lg { width: 24px; height: 24px; }
.icon-xl { width: 28px; height: 28px; }
</style>