<script setup lang="ts">
/**
 * Lazy-rendered emoji section.
 *
 * Uses IntersectionObserver to only mount the default slot (the emoji grid)
 * when the section scrolls near the viewport. The `header` slot is always
 * rendered so category titles remain in the DOM for scrolling context.
 *
 * Once a section becomes visible it stays visible - no unmounting on scroll-out
 * to avoid flicker when scrolling back up (same pattern Discord uses).
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Number of emoji items in this section - used to estimate placeholder height. */
    emojiCount: number
    /** Grid column count. Defaults to 7 (fits a 320px popup). */
    columns?: number
  }>(),
  { columns: 7 },
)

const sectionEl = ref<HTMLElement | null>(null)
const isVisible = ref(false)
let observer: IntersectionObserver | null = null

const ITEM_HEIGHT = 42   // 36px item + 6px gap
const HEADER_HEIGHT = 36 // section title + margin

const placeholderHeight = computed(() => {
  const rows = Math.ceil(props.emojiCount / props.columns)
  return HEADER_HEIGHT + rows * ITEM_HEIGHT
})

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let current = el?.parentElement ?? null
  while (current) {
    const { overflowY } = getComputedStyle(current)
    if (overflowY === 'auto' || overflowY === 'scroll') return current
    current = current.parentElement
  }
  return null
}

onMounted(() => {
  if (!sectionEl.value) return
  const root = findScrollParent(sectionEl.value as unknown as HTMLElement)

  observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) {
        isVisible.value = true
        observer?.disconnect()
        observer = null
      }
    },
    { root, rootMargin: '400px 0px 400px 0px' },
  )
  observer.observe(sectionEl.value as unknown as Element)
})

onUnmounted(() => {
  observer?.disconnect()
})

defineExpose({ isVisible })
</script>

<template>
  <div
    ref="sectionEl"
    class="emoji-section"
    :style="!isVisible ? { minHeight: placeholderHeight + 'px' } : undefined"
  >
    <slot name="header" />
    <template v-if="isVisible">
      <slot />
    </template>
  </div>
</template>
