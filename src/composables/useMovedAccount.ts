import { ref, watch, computed, type Ref } from 'vue'
import { supabase } from '@/supabase'
import { resolveMoveTarget, type AccountRef } from '@/utils/movedAccount'

interface MaybeMoved {
  id?: string | null
  moved_to_id?: string | null
  moved_to_uri?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The account a profile moved to. Reads moved_to_id / moved_to_uri from the object when it
 * carries them and from the profile row otherwise (user objects built from presence or
 * server member data lack them).
 */
export function useMovedAccount(source: () => MaybeMoved | null | undefined): {
  movedTo: Ref<AccountRef | null>
  isMoved: Ref<boolean>
} {
  const movedTo = ref<AccountRef | null>(null)
  const isMoved = computed(() => movedTo.value !== null)
  let generation = 0

  watch(
    () => {
      const s = source()
      return s ? [s.id ?? null, s.moved_to_id, s.moved_to_uri] as const : null
    },
    async (key) => {
      const current = ++generation
      movedTo.value = null
      if (!key) return
      const [id, movedToId, movedToUri] = key
      let targetId = movedToId
      let targetUri = movedToUri
      if (targetId === undefined && targetUri === undefined) {
        if (!id || !UUID.test(id)) return
        const { data } = await supabase
          .from('profiles')
          .select('moved_to_id, moved_to_uri')
          .eq('id', id)
          .maybeSingle()
        targetId = data?.moved_to_id ?? null
        targetUri = data?.moved_to_uri ?? null
      }
      if (!targetId && !targetUri) return
      const target = await resolveMoveTarget(targetId, targetUri)
      if (current === generation) movedTo.value = target
    },
    { immediate: true },
  )

  return { movedTo, isMoved }
}
