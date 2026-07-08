// Global "join remote server" prompt state. Clicked invite URLs from foreign
// (compatible) instances open the federated join dialog instead of a new window.

import { ref, readonly } from 'vue'

const pendingUrl = ref<string | null>(null)

export function useRemoteInvitePrompt() {
  const open = (url: string): void => {
    pendingUrl.value = url
  }

  const close = (): void => {
    pendingUrl.value = null
  }

  return {
    pendingUrl: readonly(pendingUrl),
    open,
    close,
  }
}
