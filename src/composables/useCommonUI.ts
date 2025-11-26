import { ref, onMounted, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'

export function useClickOutside() {
  const targetRef = ref<HTMLElement | null>(null)

  const handleClickOutside = (callback: () => void) => {
    const onClick = (event: MouseEvent) => {
      if (targetRef.value && !targetRef.value.contains(event.target as Node)) {
        callback()
      }
    }

    onMounted(() => {
      document.addEventListener('click', onClick)
    })

    onUnmounted(() => {
      document.removeEventListener('click', onClick)
    })

    return onClick
  }

  return {
    targetRef,
    handleClickOutside
  }
}

export function useKeyboardEvents() {
  const handleKeydown = (callback: (event: KeyboardEvent) => void) => {
    onMounted(() => {
      window.addEventListener('keydown', callback)
    })

    onUnmounted(() => {
      window.removeEventListener('keydown', callback)
    })
  }

  const handleEscapeKey = (callback: () => void) => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        callback()
      }
    }

    handleKeydown(onKeydown)
  }

  const handleEnterKey = (callback: () => void) => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === 'Return') {
        callback()
      }
    }

    handleKeydown(onKeydown)
  }

  return {
    handleKeydown,
    handleEscapeKey,
    handleEnterKey
  }
}

export function useAudioEffects() {
  // Deprecated: Use the new theme system instead
  // Import and use: const themeStore = useThemeStore()
  // Then call: themeStore.testAudio(audioAction)
  const playSound = (soundPath: string, volume = 0.5) => {
    debug.warn('useAudioEffects.playSound is deprecated. Use the theme system: themeStore.testAudio(audioAction)')
    const audio = new Audio(soundPath)
    audio.volume = volume
    audio.play().catch(debug.error)
  }

  return {
    playSound
  }
}