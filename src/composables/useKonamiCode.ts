/**
 * Konami Code Detector
 * 
 * Detects the classic Konami code sequence:
 * Up, Up, Down, Down, Left, Right, Left, Right, B, A, Enter
 */

import { ref, onMounted, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'

// Konami code sequence
const KONAMI_SEQUENCE = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'KeyB',
  'KeyA',
  'Enter',
]

const RESET_TIMEOUT = 3000 // Reset sequence if no key pressed for 3 seconds

export function useKonamiCode(onActivate: () => void) {
  const sequence = ref<string[]>([])
  const isActive = ref(false)
  let resetTimer: ReturnType<typeof setTimeout> | null = null

  const handleKeyDown = (event: KeyboardEvent) => {
    // Don't detect if typing in input fields
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return
    }

    const keyCode = event.code

    // Clear reset timer
    if (resetTimer) {
      clearTimeout(resetTimer)
      resetTimer = null
    }

    // Check if this key matches the next in sequence
    const expectedKey = KONAMI_SEQUENCE[sequence.value.length]
    
    if (keyCode === expectedKey) {
      sequence.value.push(keyCode)
      debug.log(`🎮 [Konami] Progress: ${sequence.value.length}/${KONAMI_SEQUENCE.length}`)
      
      // Check if sequence is complete
      if (sequence.value.length === KONAMI_SEQUENCE.length) {
        debug.log('🎮 [Konami] Code activated!')
        isActive.value = true
        onActivate()
        sequence.value = []
      } else {
        // Set reset timer
        resetTimer = setTimeout(() => {
          debug.log('🎮 [Konami] Sequence reset (timeout)')
          sequence.value = []
        }, RESET_TIMEOUT)
      }
    } else {
      // Wrong key - reset sequence
      if (sequence.value.length > 0) {
        debug.log(`🎮 [Konami] Wrong key (expected ${expectedKey}, got ${keyCode}), resetting`)
        sequence.value = []
      }
    }
  }

  const reset = () => {
    sequence.value = []
    isActive.value = false
    if (resetTimer) {
      clearTimeout(resetTimer)
      resetTimer = null
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    debug.log('🎮 [Konami] Detector initialized')
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeyDown, { capture: true })
    if (resetTimer) {
      clearTimeout(resetTimer)
    }
    debug.log('🎮 [Konami] Detector cleaned up')
  })

  return {
    isActive,
    reset,
  }
}

