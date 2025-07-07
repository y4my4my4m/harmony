<template>
  <!-- 
    DEPRECATED: This component has been replaced by the new SpatialAudioPanel.vue
    The new spatial audio system is integrated into the voice dock and overlay components.
    
    To enable spatial audio:
    1. Join a voice channel
    2. Click the spatial audio button (map icon) in the voice dock or overlay
    3. Position users by dragging them around in the spatial panel
    
    This component is kept for backward compatibility but is no longer used.
  -->
  <div class="deprecated-notice">
    <p>VoiceChannelScene is deprecated. Use the new Spatial Audio Panel instead.</p>
  </div>
</template>

<script setup lang="ts">
// This component is deprecated in favor of the new SpatialAudioPanel
console.warn('VoiceChannelScene.vue is deprecated. Please use the new SpatialAudioPanel component.');
</script>

<style scoped>
.deprecated-notice {
  padding: 20px;
  background: #ffd700;
  color: #000;
  text-align: center;
  border-radius: 8px;
  margin: 20px;
}
</style>