<!-- Drive's file viewer: the media viewer over the files of the view, opened at `startId`. -->
<template>
  <MediaLightbox
    v-model:index="index"
    :visible="true"
    :imgs="items"
    :download="download"
    autoplay
    @hide="emit('close')"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import MediaLightbox from '@/components/common/MediaLightbox.vue'
import { useT } from '@/composables/useT'
import { driveFileDisplayName, type DriveFile } from '@/services/drive/driveService'
import { driveViewerItem } from './driveFormat'

const props = defineProps<{ files: DriveFile[]; startId: string }>()
const emit = defineEmits<{ close: []; download: [file: DriveFile] }>()

const { t } = useT()
const index = ref(Math.max(0, props.files.findIndex((f) => f.id === props.startId)))

const items = computed(() =>
  props.files.map((file) => driveViewerItem(file, driveFileDisplayName(file, t('drive.file.unnamed')))))

function download(at: number): void {
  const file = props.files[at]
  if (file) emit('download', file)
}
</script>
