<!-- A music service's own player for a shared link (utils/musicEmbeds.ts). The frame loads
     lazily; on tauri:// it is framed through the instance's embed relay. -->
<template>
  <div
    class="music-embed"
    :class="[`music-embed--${embed.provider}`, { 'is-single': embed.single, 'is-loaded': loaded }]"
    :style="{ '--music-height': `${embed.height}px` }"
    data-testid="music-embed"
    :data-provider="embed.provider"
  >
    <div v-if="!loaded" class="music-embed__placeholder" aria-hidden="true">
      <img v-if="artwork" :src="artwork" alt="" class="music-embed__art" />
      <span v-else class="music-embed__art music-embed__art--empty"><Icon name="music" :size="22" /></span>
      <span class="music-embed__lines">
        <span class="music-embed__line" />
        <span class="music-embed__line music-embed__line--short" />
      </span>
    </div>
    <iframe
      :src="frameSrc"
      :title="title"
      loading="lazy"
      allow="autoplay *; clipboard-write; encrypted-media *; fullscreen *; picture-in-picture"
      sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"
      referrerpolicy="strict-origin-when-cross-origin"
      @load="onLoad"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import type { MusicEmbed } from '@/utils/musicEmbeds'
import { embedRelayOrigin, EMBED_RELAY_PATH } from '@/utils/embedDetection'

const props = withDefaults(defineProps<{ embed: MusicEmbed; title: string; artwork?: string | null }>(), { artwork: null })
const emit = defineEmits<{ load: [] }>()

const loaded = ref(false)

const frameSrc = computed(() => {
  const relay = embedRelayOrigin()
  return relay ? `${relay}${EMBED_RELAY_PATH}?src=${encodeURIComponent(props.embed.src)}` : props.embed.src
})

function onLoad(): void {
  loaded.value = true
  emit('load')
}
</script>

<style scoped>
.music-embed {
  position: relative;
  width: min(100%, 520px);
  height: var(--music-height);
  overflow: hidden;
  background: var(--background-secondary);
  border-radius: 12px;
}

.music-embed:not(.is-single) {
  width: min(100%, 560px);
}

.music-embed iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: inherit;
  opacity: 0;
  transition: opacity 0.25s ease;
}

.music-embed.is-loaded iframe {
  opacity: 1;
}

.music-embed__placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
}

.music-embed__art {
  flex-shrink: 0;
  width: min(calc(var(--music-height) - 32px), 120px);
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: 8px;
  background: var(--background-modifier-active);
}

.music-embed__art--empty {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.music-embed__lines {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
}

.music-embed__line {
  display: block;
  height: 10px;
  width: 70%;
  background: var(--background-modifier-active);
  border-radius: 5px;
  animation: music-embed-pulse 1.4s ease-in-out infinite;
}

.music-embed__line--short {
  width: 40%;
}

.music-embed--spotify { background: #282828; }
.music-embed--soundcloud { background: #f2f2f2; }
.music-embed--apple-music { background: #f5f5f7; }

@keyframes music-embed-pulse {
  50% { opacity: 0.5; }
}

@media (prefers-reduced-motion: reduce) {
  .music-embed iframe { transition: none; }
  .music-embed__line { animation: none; }
}
</style>
