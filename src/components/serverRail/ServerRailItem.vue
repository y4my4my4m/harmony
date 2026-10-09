<template>
  <div
    class="rail-server"
    :class="{ 'is-muted': muted }"
    role="button"
    tabindex="0"
    data-rail-kind="server"
    :data-rail-id="server.id"
    :data-rail-folder="folderId ?? undefined"
    :aria-label="serverDisplayLabel(server)"
    :aria-current="selected ? 'page' : undefined"
  >
    <div class="server-pill" :class="{ visible: selected, 'has-unread': hasUnread && !selected }"></div>
    <ServerIcon
      :id="server.id"
      :src="server.icon"
      :alt="server.name"
      size="md"
      class="server-item"
      :class="{ selected }"
      shape="round"
      :interactive="true"
      :show-title="false"
    />
    <div v-if="server.is_local_server === false" class="remote-server-badge" aria-hidden="true">
      <Icon name="globe" :size="10" />
    </div>
    <div v-if="mentions > 0" class="unread-badge">{{ mentions > 99 ? '99+' : mentions }}</div>
  </div>
</template>

<script setup lang="ts">
import ServerIcon from '@/components/common/ServerIcon.vue'
import Icon from '@/components/common/Icon.vue'
import { serverDisplayLabel } from '@/utils/serverUtils'
import { useRailServerState } from './railState'
import type { Server } from '@/types'

const props = defineProps<{
  server: Server
  folderId: string | null
}>()

const { selected, mentions, hasUnread, muted } = useRailServerState(() => props.server)
</script>

<style scoped>
.rail-server {
  position: relative;
  width: 48px;
  height: 48px;
  cursor: pointer;
  touch-action: pan-y;
  -webkit-touch-callout: none;
  user-select: none;
}

.rail-server:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 3px;
  border-radius: 16px;
}

.server-item {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  transition: border-radius 0.15s ease;
}

.rail-server:hover .server-item {
  border-radius: 16px;
}

.server-item.selected {
  border: 2px solid var(--harmony-secondary);
  border-radius: 16px;
}

.server-item :deep(img) {
  user-select: none;
  -webkit-user-drag: none;
  pointer-events: none;
}

/* The picture takes the container's shape: round at rest, rounded square on hover and
   selection. Qualified to outrank ServerIcon's shape-round. */
.rail-server .server-item :deep(.server-image) {
  border-radius: 50%;
  transition: border-radius 0.15s ease;
}

.rail-server:hover .server-item :deep(.server-image) {
  border-radius: 16px;
}

/* Inside the 2px ring: concentric with its 16px outer corner. */
.rail-server .server-item.selected :deep(.server-image) {
  border-radius: 14px;
}

.rail-server.is-muted .server-item {
  opacity: 0.55;
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

.rail-server:hover .server-pill {
  opacity: 1;
  height: 20px;
}

.server-pill.visible,
.rail-server:hover .server-pill.visible {
  opacity: 1;
  height: 36px;
}

/* Server hosted by another instance; opposite corner from the unread badge. */
.remote-server-badge {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background-secondary);
  color: var(--text-secondary);
  box-shadow: 0 0 0 2px var(--background-tertiary);
  pointer-events: none;
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
</style>
