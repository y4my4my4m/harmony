<template>
  <div v-if="isActive" class="confetti-container">
    <div
      v-for="(confetti, index) in confettiPieces"
      :key="index"
      class="confetti-piece"
      :style="confetti.style"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

interface Props {
  isActive: boolean
  duration?: number // Duration in milliseconds
}

const props = withDefaults(defineProps<Props>(), {
  duration: 10000, // 10 seconds default
})

const confettiPieces = ref<Array<{ style: Record<string, string> }>>([])
const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#f0932b', '#eb4d4b', '#6c5ce7', '#a29bfe']

const generateConfetti = () => {
  const pieces: Array<{ style: Record<string, string> }> = []
  const count = 150

  for (let i = 0; i < count; i++) {
    const color = colors[Math.floor(Math.random() * colors.length)]
    const left = Math.random() * 100
    const animationDelay = Math.random() * 2
    const animationDuration = 3 + Math.random() * 2
    const size = 8 + Math.random() * 6
    const rotation = Math.random() * 360

    pieces.push({
      style: {
        '--color': color,
        '--left': `${left}%`,
        '--delay': `${animationDelay}s`,
        '--duration': `${animationDuration}s`,
        '--size': `${size}px`,
        '--rotation': `${rotation}deg`,
      },
    })
  }

  confettiPieces.value = pieces
}

onMounted(() => {
  if (props.isActive) {
    generateConfetti()
  }
})

// Regenerate when activated
const isActive = computed(() => props.isActive)
watch(isActive, (active) => {
  if (active) {
    generateConfetti()
  }
})
</script>

<style scoped>
.confetti-container {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 10001;
  overflow: hidden;
}

.confetti-piece {
  position: absolute;
  width: var(--size);
  height: var(--size);
  background-color: var(--color);
  left: var(--left);
  top: -10px;
  opacity: 0.9;
  animation: confetti-fall var(--duration) var(--delay) linear forwards;
  transform: rotate(var(--rotation));
}

.confetti-piece:nth-child(odd) {
  border-radius: 50%;
}

.confetti-piece:nth-child(even) {
  clip-path: polygon(50% 0%, 0% 100%, 100% 100%);
}

@keyframes confetti-fall {
  0% {
    transform: translateY(0) rotate(var(--rotation));
    opacity: 1;
  }
  100% {
    transform: translateY(100vh) rotate(calc(var(--rotation) + 720deg));
    opacity: 0;
  }
}
</style>

