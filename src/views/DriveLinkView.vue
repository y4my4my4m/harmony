<!-- /d/<token>: a Drive file's address. A reader gets the file in the app; anyone else the public
     page while the file's general access is "Anyone with the link"; a signed-out visitor of a
     restricted file signs in and comes back here. -->
<template>
  <DrivePublicPage v-if="publicInfo !== undefined" :token="token" :info="publicInfo" />
  <DriveFilePage v-else :state="fileState" :card="card" @retry="load" @token="moveToToken" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DriveFilePage from '@/components/drive/DriveFilePage.vue'
import DrivePublicPage from '@/components/drive/DrivePublicPage.vue'
import { useAuthStore } from '@/stores/auth'
import { rememberPostAuthRedirect } from '@/utils/postAuthRedirect'
import {
  getDriveFileCard,
  primeDriveFileCard,
  resolveDriveLink,
  takePrimedDriveFileCard,
  type DriveFileCardFile,
  type DriveLinkInfo,
} from '@/services/drive/driveService'

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const token = computed(() => String(route.params.token ?? ''))
const card = ref<DriveFileCardFile | null>(null)
const fileState = ref<'loading' | 'ready' | 'denied' | 'error'>('loading')
/** The public page: undefined when not shown, null for a link that opens nothing. */
const publicInfo = ref<DriveLinkInfo | null | undefined>(undefined)
let loadSeq = 0

async function load(): Promise<void> {
  const seq = ++loadSeq
  const value = token.value
  card.value = null
  fileState.value = 'loading'
  publicInfo.value = undefined
  if (!TOKEN.test(value)) {
    if (authStore.isLoggedIn) fileState.value = 'denied'
    else publicInfo.value = null
    return
  }

  if (!authStore.isLoggedIn) {
    let info: DriveLinkInfo | null
    try {
      info = await resolveDriveLink(value)
    } catch {
      info = null
    }
    if (seq !== loadSeq) return
    if (info) {
      publicInfo.value = info
      return
    }
    rememberPostAuthRedirect(route.fullPath)
    void router.replace({ name: 'Login', query: { redirect: route.fullPath } })
    return
  }

  const primed = takePrimedDriveFileCard(value)
  if (primed) {
    card.value = primed
    fileState.value = 'ready'
    return
  }
  try {
    const answer = await getDriveFileCard({ token: value })
    if (seq !== loadSeq) return
    if (answer.access && answer.via === 'file') {
      card.value = answer
      fileState.value = 'ready'
    } else if (answer.access) {
      const { name, mime_type, kind, size_bytes, created_at, expires_at, owner } = answer
      publicInfo.value = { name, mime_type, kind, size_bytes, created_at, expires_at, owner }
    } else {
      fileState.value = 'denied'
    }
  } catch {
    if (seq === loadSeq) fileState.value = 'error'
  }
}

/** Reset link from the share dialog: the page moves to the new address. */
function moveToToken(next: string): void {
  if (card.value) primeDriveFileCard({ ...card.value, token: next })
  void router.replace({ name: 'DriveLink', params: { token: next } })
}

watch([token, () => authStore.isLoggedIn], () => void load(), { immediate: true })
</script>
