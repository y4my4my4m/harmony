import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Placement of the desktop user panel (BaseLayout, bottom-left, 345x72).
 *
 * The panel floats over the bottom of the channel/social sidebar, which
 * reserves that strip. Without such a sidebar the strip holds page content, so
 * the panel docks into the server rail as the avatar alone and expands on
 * demand, as it does on mobile.
 */

const hostCount = ref(0)

/** True while no mounted sidebar reserves the panel's strip. */
export const userPanelDocked = computed(() => hostCount.value === 0)

/** Marks the calling component as reserving the panel's strip while mounted. */
export function useUserPanelHost(): void {
  onMounted(() => {
    hostCount.value++
  })
  onBeforeUnmount(() => {
    hostCount.value--
  })
}
