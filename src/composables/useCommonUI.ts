import { ref, onMounted, onUnmounted } from 'vue'

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
  const playSound = (soundPath: string, volume = 0.5) => {
    const audio = new Audio(soundPath)
    audio.volume = volume
    audio.play().catch(console.error)
  }

  return {
    playSound
  }
}