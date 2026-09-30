import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { usePinsStore } from '@/stores/usePins'
import type { Message } from '@/types'

/** Optimistic pin/unpin with a toast on rollback. Resolves false on failure. */
export function usePinActions() {
  const pinsStore = usePinsStore()
  const toast = useToast()
  const { t } = useI18n()

  const setPinned = async (message: Message, pinned: boolean): Promise<boolean> => {
    try {
      await pinsStore.setPinned(message, pinned)
      return true
    } catch (error) {
      // pin_message raises "Maximum pin limit (N) reached ...".
      const reason = String((error as { message?: string })?.message ?? '')
      if (pinned && /pin limit/i.test(reason)) {
        toast.error(t('chat.pinLimitReached'))
      } else {
        toast.error(t(pinned ? 'chat.pinFailed' : 'chat.unpinFailed'))
      }
      return false
    }
  }

  return { setPinned }
}
