<template>
  <div v-if="sections.length" class="sticker-picker-sections" data-testid="custom-stickers">
    <section
      v-for="section in sections"
      :key="section.key"
      class="sticker-picker-section"
      :aria-labelledby="`${baseId}-${section.key}`"
      :data-testid="`custom-stickers-${section.scope}`"
    >
      <h3 :id="`${baseId}-${section.key}`" class="sticker-picker-heading">{{ section.label }}</h3>
      <div class="sticker-picker-grid">
        <button
          v-for="sticker in section.stickers"
          :key="sticker.id"
          type="button"
          class="sticker-pick"
          :title="sticker.name"
          :aria-label="t('stickers.pickLabel', { name: sticker.name, description: sticker.description })"
          data-testid="sticker-pick"
          @click="emit('send', sticker)"
        >
          <img :src="sticker.url" alt="" loading="lazy" draggable="false" class="sticker-pick-img" />
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useStickersStore } from '@/stores/useStickers'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useProfileStore } from '@/stores/useProfile'
import { hasCapability } from '@/services/instanceCapabilities'
import type { Sticker, StickerScope } from '@/services/stickerService'
import { uid } from '@/utils/a11y/focus'

const props = defineProps<{
  /** Search text; matches a sticker's name or description. */
  query: string
  /** Server channel the sticker goes to; null in a DM. Server stickers show only in their server. */
  channelId?: string | null
}>()

const emit = defineEmits<{ (e: 'send', sticker: Sticker): void }>()

const { t } = useI18n()
const stickers = useStickersStore()
const serverChannelStore = useServerChannelStore()
const profileStore = useProfileStore()
const baseId = uid('sticker-section')

const enabled = hasCapability('custom-stickers')
const serverId = computed(() => (props.channelId ? serverChannelStore.currentServerId ?? null : null))
const profileId = computed(() => profileStore.profile?.id ?? null)

function matches(sticker: Sticker, query: string): boolean {
  if (!query) return true
  return sticker.name.toLowerCase().includes(query) || sticker.description.toLowerCase().includes(query)
}

interface Section {
  key: string
  scope: StickerScope
  label: string
  stickers: Sticker[]
}

const sections = computed((): Section[] => {
  if (!enabled) return []
  const query = props.query.trim().toLowerCase()
  const all: Section[] = []
  if (serverId.value) {
    all.push({
      key: `server-${serverId.value}`,
      scope: 'server',
      label: serverChannelStore.currentServer?.name || t('stickers.picker.server'),
      stickers: stickers.cached(`server:${serverId.value}`),
    })
  }
  all.push({ key: 'instance', scope: 'instance', label: t('stickers.picker.instance'), stickers: stickers.cached('instance') })
  if (profileId.value) {
    all.push({ key: 'mine', scope: 'user', label: t('stickers.picker.mine'), stickers: stickers.cached(`user:${profileId.value}`) })
  }
  return all
    .map((section) => ({ ...section, stickers: section.stickers.filter((s) => matches(s, query)) }))
    .filter((section) => section.stickers.length > 0)
})

onMounted(() => {
  if (enabled) void stickers.loadPicker(serverId.value, profileId.value)
})
</script>

<style scoped>
.sticker-picker-sections {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.sticker-picker-heading {
  margin: 0 0 6px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-muted, inherit);
}

.sticker-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 8px;
}

.sticker-pick {
  aspect-ratio: 1;
  padding: 6px;
  border: none;
  border-radius: 10px;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sticker-pick:hover,
.sticker-pick:focus-visible {
  background: var(--hover-bg, rgba(127, 127, 127, 0.15));
}

.sticker-pick-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
</style>
