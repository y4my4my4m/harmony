<template>
  <div class="color-picker">
    <div class="color-picker-content">
      <!-- Predefined Colors -->
      <div class="color-section">
        <h4 class="section-title">Preset Colors</h4>
        <div class="preset-colors">
          <div
            v-for="presetColor in presetColors"
            :key="presetColor"
            class="preset-color"
            :class="{ active: color === presetColor }"
            :style="{ backgroundColor: presetColor }"
            @click="selectColor(presetColor)"
          ></div>
        </div>
      </div>

      <!-- Custom Color Input -->
      <div class="color-section">
        <h4 class="section-title">Custom Color</h4>
        <div class="custom-color-input">
          <input
            v-model="localColor"
            type="text"
            class="hex-input"
            placeholder="#0EA5E9"
            @input="onHexInput"
            @blur="validateAndEmit"
          />
          <input
            v-model="localColor"
            type="color"
            class="color-input"
            @input="onColorInput"
          />
        </div>
      </div>

      <!-- Color Preview -->
      <div class="color-section">
        <h4 class="section-title">Preview</h4>
        <div class="color-preview-large" :style="{ backgroundColor: color }">
          <span class="preview-text">Sample Text</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'

// Props
interface Props {
  color?: string
}

const props = withDefaults(defineProps<Props>(), {
  color: '#0EA5E9'
})

// Emits
const emit = defineEmits<{
  'update:color': [color: string]
  'change': [color: string]
}>()

// State
const localColor = ref(props.color)

// Preset colors (Main palette)
const presetColors = [
  '#0EA5E9', // Main
  '#57f287', // Green
  '#fee75c', // Yellow
  '#eb459e', // Pink
  '#ed4245', // Red
  '#f1c40f', // Gold
  '#e67e22', // Orange
  '#9b59b6', // Purple
  '#3498db', // Blue
  '#2ecc71', // Emerald
  '#e91e63', // Rose
  '#00bcd4', // Cyan
  '#795548', // Brown
  '#607d8b', // Blue Grey
  '#ffffff', // White
  '#000000', // Black
]

// Methods
const selectColor = (color: string) => {
  localColor.value = color
  emit('update:color', color)
  emit('change', color)
}

const onHexInput = () => {
  // Auto-add # if not present
  if (localColor.value && !localColor.value.startsWith('#')) {
    localColor.value = '#' + localColor.value
  }
}

const onColorInput = () => {
  emit('update:color', localColor.value)
  emit('change', localColor.value)
}

const validateAndEmit = () => {
  // Validate hex color format
  const hexRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/
  if (localColor.value && hexRegex.test(localColor.value)) {
    emit('update:color', localColor.value)
    emit('change', localColor.value)
  } else {
    // Revert to previous valid color
    localColor.value = props.color
  }
}

// Watchers
watch(() => props.color, (newColor) => {
  localColor.value = newColor
})

onMounted(() => {
  localColor.value = props.color
})
</script>

<style scoped>
.color-picker {
  width: 280px;
  user-select: none;
}

.color-picker-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.color-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, var(--text-secondary));
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0;
}

.preset-colors {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 8px;
}

.preset-color {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  transition: all 0.15s ease;
  position: relative;
}

.preset-color:hover {
  transform: scale(1.1);
}

.preset-color.active {
  border-color: var(--text-primary);
  box-shadow: 0 0 0 2px var(--h-chat-light);
}

.custom-color-input {
  display: flex;
  gap: 8px;
  align-items: center;
}

.hex-input {
  flex: 1;
  padding: 8px 12px;
  background-color: var(--h-chat-darker);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: var(--text-primary, #ffffff);
  font-size: 14px;
  font-family: 'Courier New', monospace;
}

.hex-input:focus {
  outline: none;
  border-color: var(--h-primary, #0EA5E9);
}

.color-input {
  width: 40px;
  height: 32px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  background: none;
}

.color-input::-webkit-color-swatch-wrapper {
  padding: 0;
}

.color-input::-webkit-color-swatch {
  border-radius: 4px;
  border: 1px solid var(--h-chat-light);
}

.color-preview-large {
  height: 60px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--h-chat-light);
  position: relative;
  overflow: hidden;
}

.preview-text {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6), 0 0 8px rgba(0, 0, 0, 0.4);
}

@media (max-width: 480px) {
  .color-picker {
    width: 240px;
  }
  
  .preset-colors {
    grid-template-columns: repeat(6, 1fr);
  }
}
</style>