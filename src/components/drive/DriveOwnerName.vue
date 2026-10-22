<!-- A file owner's display name with the custom emoji drive_owner_json sends: renders for a
     viewer without an account, whose emoji cache is empty. -->
<template>
  <DisplayName :parts="parts" :fallback="owner.display_name || owner.username" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import DisplayName from '@/components/DisplayName.vue'
import { userDataService } from '@/services/userDataService'
import type { DriveCardOwner } from '@/services/drive/driveService'

const props = defineProps<{ owner: DriveCardOwner }>()

const parts = computed(() => userDataService.resolveDisplayNameParts(
  props.owner.display_name || props.owner.username,
  (props.owner.emojis ?? []).map((e) => ({ id: e.name, name: e.name, url: e.url })),
))
</script>
