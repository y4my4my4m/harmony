<!-- /drive/file/<id>, the 1.8.11 address of a Drive file: a reader moves on to the file's /d/
     address; anyone else gets a page that names nothing of the file. -->
<template>
  <DriveFilePage :state="state" @retry="load" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import DriveFilePage from '@/components/drive/DriveFilePage.vue'
import { getDriveFileCard, primeDriveFileCard } from '@/services/drive/driveService'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const route = useRoute()
const router = useRouter()
const state = ref<'loading' | 'denied' | 'error'>('loading')
let loadSeq = 0

const fileId = computed(() => String(route.params.fileId ?? ''))

async function load(): Promise<void> {
  const seq = ++loadSeq
  const id = fileId.value
  state.value = 'loading'
  if (!UUID.test(id)) {
    state.value = 'denied'
    return
  }
  try {
    const answer = await getDriveFileCard({ fileId: id })
    if (seq !== loadSeq) return
    if (answer.access && answer.via === 'file') {
      primeDriveFileCard(answer)
      void router.replace({ name: 'DriveLink', params: { token: answer.token } })
    } else {
      state.value = 'denied'
    }
  } catch {
    if (seq === loadSeq) state.value = 'error'
  }
}

watch(fileId, () => void load(), { immediate: true })
</script>
