<template>
  <div class="keybind-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.keybinds.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.keybinds.description') }}
      </p>
    </div>

    <!-- Global Keybinds -->
    <div class="settings-section">
      <h3 class="section-title">Global Keybinds</h3>
      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Push to Talk</h4>
          <p class="keybind-description">Hold to talk in voice channels (coming soon).</p>
        </div>
        <div class="keybind-control">
          <div class="keybind-display not-implemented">Not configured</div>
        </div>
      </div>
    </div>

    <!-- Voice Overlay Keybinds -->
    <div class="settings-section">
      <h3 class="section-title">Voice Chat (when overlay is open)</h3>
      
      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Toggle Mute</h4>
          <p class="keybind-description">Mute or unmute your microphone.</p>
        </div>
        <div class="keybind-control">
          <div class="keybind-display">M</div>
        </div>
      </div>

      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Toggle Deafen</h4>
          <p class="keybind-description">Deafen or undeafen yourself.</p>
        </div>
        <div class="keybind-control">
          <div class="keybind-display">D</div>
        </div>
      </div>

      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Toggle Camera</h4>
          <p class="keybind-description">Turn camera on or off.</p>
        </div>
        <div class="keybind-control">
          <div class="keybind-display">V</div>
        </div>
      </div>

      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Toggle Screen Share</h4>
          <p class="keybind-description">Start or stop screen sharing.</p>
        </div>
        <div class="keybind-control">
          <div class="keybind-display">S</div>
        </div>
      </div>

      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Open Settings</h4>
          <p class="keybind-description">Open voice settings panel.</p>
        </div>
        <div class="keybind-control">
          <div class="keybind-display">,</div>
        </div>
      </div>

      <div class="keybind-item">
        <div class="keybind-info">
          <h4 class="keybind-label">Exit / Close</h4>
          <p class="keybind-description">Exit fullscreen or close panels.</p>
        </div>
        <div class="keybind-control">
          <div class="keybind-display">Esc</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  loading: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-keybinds': [settings: any]
}>()
</script>

<style scoped>
.keybind-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--h-chat);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 20px 0;
}

.keybind-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--h-chat-light);
}

.keybind-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.keybind-info {
  flex: 1;
  margin-right: 16px;
}

.keybind-label {
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
  margin: 0 0 4px 0;
}

.keybind-description {
  font-size: 12px;
  color: #b9bbbe;
  margin: 0;
  line-height: 1.4;
}

.keybind-control {
  flex-shrink: 0;
}

.keybind-display {
  padding: 6px 12px;
  background-color: var(--h-chat-darker);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: #ffffff;
  font-size: 12px;
  font-family: monospace;
}

.keybind-display.not-implemented {
  color: #72767d;
  font-style: italic;
  font-family: inherit;
}
</style>