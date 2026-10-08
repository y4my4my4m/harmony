<template>
  <div
    class="server-folder"
    :class="{ 'is-expanded': folder.is_expanded }"
    :style="{ '--folder-color': folder.color }"
  >
    <div
      v-if="!folder.is_expanded"
      class="folder-collapsed"
      role="button"
      tabindex="0"
      data-rail-kind="folder"
      :data-rail-id="folder.id"
      :aria-label="label"
      aria-expanded="false"
    >
      <div class="server-pill" :class="{ 'has-unread': hasUnread }"></div>
      <div class="folder-grid">
        <div v-for="server in previewServers" :key="server.id" class="folder-grid-item">
          <img
            :src="iconUrl(server.icon)"
            alt=""
            class="folder-grid-icon"
            width="20"
            height="20"
            loading="lazy"
            decoding="async"
            draggable="false"
            @error="onIconError"
          />
        </div>
      </div>
      <div v-if="mentions > 0" class="unread-badge">{{ mentions > 99 ? '99+' : mentions }}</div>
    </div>

    <div v-else class="folder-expanded">
      <div
        class="folder-cap"
        role="button"
        tabindex="0"
        data-rail-kind="folder"
        :data-rail-id="folder.id"
        :aria-label="label"
        aria-expanded="true"
      >
        <svg class="folder-cap-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z"/>
        </svg>
      </div>
      <TransitionGroup tag="div" name="rail-move" class="folder-content" role="group" :aria-label="label">
        <div v-for="server in servers" :key="server.id" class="folder-member">
          <ServerRailItem :server="server" :folder-id="folder.id" />
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ServerRailItem from '@/components/serverRail/ServerRailItem.vue'
import { useRailFolderState } from '@/components/serverRail/railState'
import { getServerIconUrl } from '@/utils/serverUtils'
import { devicePixels } from '@/utils/imageTransformUtils'
import type { Server, ServerFolder } from '@/types'

const props = defineProps<{
  folder: ServerFolder
  servers: readonly Server[]
}>()

const { t } = useI18n()

const label = computed(() => props.folder.name || t('serverRail.folder.unnamed'))
const previewServers = computed(() => props.servers.slice(0, 4))
const { mentions, hasUnread } = useRailFolderState(() => props.servers)

// Grid tiles are 20 CSS px; requesting that size keeps the rail off full icons.
const tilePixels = devicePixels(20)
const iconUrl = (icon: string | null | undefined) => getServerIconUrl(icon, tilePixels)

const onIconError = (event: Event) => {
  const img = event.target as HTMLImageElement
  if (!img.src.endsWith('/default_server.webp')) img.src = '/default_server.webp'
}
</script>

<style scoped>
.server-folder {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  --folder-color: var(--harmony-primary);
}

.folder-collapsed {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--folder-color) 40%, var(--background-quaternary, var(--background-tertiary)));
  cursor: pointer;
  touch-action: pan-y;
  -webkit-touch-callout: none;
  user-select: none;
}

.folder-collapsed:focus-visible,
.folder-cap:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 3px;
}

.folder-grid {
  display: grid;
  grid-template-columns: 20px 20px;
  grid-template-rows: 20px 20px;
  gap: 2px;
  padding: 3px;
  border-radius: 16px;
  overflow: hidden;
}

.folder-grid-item {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  overflow: hidden;
}

.folder-grid-icon {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  -webkit-user-drag: none;
}

.folder-expanded {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 56px;
  padding-bottom: 6px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--folder-color) 25%, transparent);
}

.folder-cap {
  width: 48px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  cursor: pointer;
  color: var(--folder-color);
  touch-action: pan-y;
  user-select: none;
}

.folder-cap:hover {
  background: color-mix(in srgb, var(--folder-color) 25%, transparent);
}

.folder-cap-icon {
  width: 20px;
  height: 20px;
}

.folder-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.server-pill {
  position: absolute;
  left: -12px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 0;
  background: var(--text-primary);
  border-radius: 0 4px 4px 0;
  opacity: 0;
  transition: height 0.15s ease, opacity 0.15s ease;
}

.server-pill.has-unread {
  opacity: 1;
  height: 8px;
}

.folder-collapsed:hover .server-pill {
  opacity: 1;
  height: 20px;
}

.unread-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: bold;
  padding: 2px 5px;
  border-radius: 10px;
  min-width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 3px var(--background-tertiary);
  pointer-events: none;
}

.rail-move-move {
  transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}

@media (prefers-reduced-motion: reduce) {
  .rail-move-move {
    transition: none;
  }
}
</style>
