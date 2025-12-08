<template>
  <div v-if="isActive" class="megaman-game-overlay">
    <button class="close-button" @click="closeGame" title="Close game">
      <Icon name="x" />
    </button>
    <canvas ref="canvasRef" class="megaman-canvas" />
  </div>
</template>

<script setup lang="ts">
/**
 * MegamanGame Component - Thin Vue wrapper for the refactored game engine
 * 
 * The game logic has been refactored into a modular architecture:
 * - game/core/          - Types, constants, and events
 * - game/managers/      - Sound, sprite, and effect management
 * - game/systems/       - Physics, input, animation, and rendering
 * - game/entities/      - Player, bullet, and pickup entities
 * - game/network/       - Network abstraction and Supabase adapter
 * - game/GameEngine.ts  - Main orchestrator
 * 
 * This wrapper handles Vue lifecycle and props/emits integration.
 */
import { ref, onMounted, onUnmounted, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { createGameEngine, type GameEngine, getSpriteManager } from './megaman/game'
import { useUserData } from '@/composables/useUserData'

interface Props {
  isActive: boolean
  channelId: string
  userId: string
  participants: Array<{ userId: string; username?: string }>
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
}>()

// Get user data composable for usernames and profile pictures
const { getUserDisplayName, getUserAvatarUrl } = useUserData()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let gameEngine: GameEngine | null = null

/**
 * Initialize and start the game
 */
async function initializeGame() {
  if (!canvasRef.value || !props.channelId || !props.userId) return

  // Fetch user data for participants - unwrap computed refs
  const participantsWithData = props.participants.map((participant) => {
    const displayNameRef = getUserDisplayName(participant.userId)
    const avatarUrlRef = getUserAvatarUrl(participant.userId)
    return {
      userId: participant.userId,
      username: displayNameRef.value || participant.username,
      profilePicture: avatarUrlRef.value,
    }
  })

  // Create game engine
  gameEngine = createGameEngine({
    channelId: props.channelId,
    userId: props.userId,
    participants: participantsWithData,
  })

  // Set close callback
  gameEngine.setOnClose(() => {
    emit('close')
  })

  // Initialize with canvas
  await gameEngine.initialize(canvasRef.value)

  // Load profile pictures
  const spriteManager = getSpriteManager()
  for (const participant of participantsWithData) {
    if (participant.profilePicture) {
      spriteManager.loadProfilePicture(participant.userId, participant.profilePicture)
    }
  }

  // Start the game
  gameEngine.start()
}

/**
 * Stop and cleanup the game
 */
function stopGame() {
  if (gameEngine) {
    gameEngine.cleanup()
    gameEngine = null
  }
}

/**
 * Close the game
 */
function closeGame() {
  stopGame()
  emit('close')
}

// Watch for active state changes
watch(() => props.isActive, async (active) => {
  if (active) {
    await initializeGame()
  } else {
    stopGame()
  }
})

// Watch for participants changes
watch(() => props.participants, (newParticipants) => {
  if (gameEngine && props.isActive) {
    // Fetch user data for new participants - unwrap computed refs
    const participantsWithData = newParticipants.map((participant) => {
      const displayNameRef = getUserDisplayName(participant.userId)
      const avatarUrlRef = getUserAvatarUrl(participant.userId)
      return {
        userId: participant.userId,
        username: displayNameRef.value || participant.username,
        profilePicture: avatarUrlRef.value,
      }
    })

    // Load profile pictures for new participants
    const spriteManager = getSpriteManager()
    for (const participant of participantsWithData) {
      if (participant.profilePicture) {
        spriteManager.loadProfilePicture(participant.userId, participant.profilePicture)
      }
    }

    gameEngine.updateParticipants(participantsWithData)
  }
}, { deep: true })

onMounted(async () => {
  if (props.isActive) {
    await initializeGame()
  }
})

onUnmounted(() => {
  stopGame()
})
</script>

<style scoped>
.megaman-game-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  height: 100%;
  z-index: 10003;
  pointer-events: all;
  overflow: hidden;
}

.megaman-canvas {
  border: 2px solid #4ecdc4;
  backdrop-filter: blur(2px);
  box-shadow: 0 0 20px rgba(78, 205, 196, 0.6);
  image-rendering: pixelated;
  image-rendering: crisp-edges;
  display: block;
  position: fixed;
  z-index: 10003;
  top: 0;
  left: 0;
  bottom: 0;
  right: 0;
  margin: auto;
}

.close-button {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 10005;
  background: rgba(0, 0, 0, 0.8);
  border: 2px solid #4ecdc4;
  border-radius: 4px;
  color: #4ecdc4;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  pointer-events: all;
}

.close-button:hover {
  background: rgba(78, 205, 196, 0.2);
  transform: scale(1.1);
}

.close-button:active {
  transform: scale(0.95);
}
</style>
