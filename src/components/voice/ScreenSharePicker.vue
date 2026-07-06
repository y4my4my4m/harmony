<template>
  <Teleport to="body">
    <Transition name="picker-fade">
      <div
        v-if="voiceStore.screenSourcePicker.visible"
        class="picker-backdrop"
        @click.self="cancel"
      >
        <div class="picker-modal">
          <div class="picker-header">
            <h3>Choose what to share</h3>
            <button class="picker-close" @click="cancel">
              <Icon name="x" />
            </button>
          </div>

          <div class="picker-tabs">
            <button
              v-for="tab in tabs"
              :key="tab.key"
              class="picker-tab"
              :class="{ active: activeTab === tab.key }"
              @click="activeTab = tab.key"
            >
              <Icon :name="tab.icon" />
              {{ tab.label }}
              <span class="tab-count">{{ tab.sources.length }}</span>
            </button>
          </div>

          <div class="picker-grid">
            <button
              v-for="source in visibleSources"
              :key="`${source.isWindow}:${source.id}`"
              class="picker-item"
              @click="pick(source)"
            >
              <div class="picker-thumb">
                <img
                  v-if="thumbnails[thumbKey(source)]"
                  :src="thumbnails[thumbKey(source)]!"
                  alt=""
                  class="thumb-img"
                />
                <Icon v-else :name="source.isWindow ? 'screen-share' : 'monitor'" class="thumb-placeholder" />
              </div>
              <span class="picker-label">
                {{ source.title || (source.isWindow ? 'Window' : 'Screen') }}
              </span>
            </button>

            <div v-if="visibleSources.length === 0" class="picker-empty">
              No {{ activeTab === 'screens' ? 'screens' : 'windows' }} available
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { nativeLiveKit, type NativeScreenSource } from '@/services/nativeLiveKit';
import Icon from '@/components/common/Icon.vue';

const voiceStore = useUnifiedVoiceChannelStore();

const activeTab = ref<'screens' | 'windows'>('screens');
const thumbnails = ref<Record<string, string | null>>({});

const thumbKey = (s: NativeScreenSource) => `${s.isWindow ? 'w' : 's'}:${s.id}`;

const screens = computed(() => voiceStore.screenSourcePicker.sources.filter((s) => !s.isWindow));
const windows = computed(() => voiceStore.screenSourcePicker.sources.filter((s) => s.isWindow));

const tabs = computed(() => [
  { key: 'screens' as const, label: 'Screens', icon: 'monitor', sources: screens.value },
  { key: 'windows' as const, label: 'Windows', icon: 'screen-share', sources: windows.value },
]);

const visibleSources = computed(() =>
  activeTab.value === 'screens' ? screens.value : windows.value
);

// lazily capture a preview for each source the first time it's shown
watch(
  [() => voiceStore.screenSourcePicker.visible, visibleSources],
  ([visible, sources]) => {
    if (!visible) return;
    for (const source of sources) {
      const key = thumbKey(source);
      if (key in thumbnails.value) continue;
      thumbnails.value[key] = null;
      nativeLiveKit.captureScreenThumbnail(source).then((url) => {
        thumbnails.value[key] = url;
      });
    }
  },
  { immediate: true }
);

watch(
  () => voiceStore.screenSourcePicker.visible,
  (visible) => {
    if (visible) {
      activeTab.value = screens.value.length > 0 ? 'screens' : 'windows';
    } else {
      thumbnails.value = {};
    }
  }
);

const pick = (source: NativeScreenSource) => {
  voiceStore.startScreenShare(source);
};

const cancel = () => {
  voiceStore.cancelScreenSharePicker();
};
</script>

<style scoped>
.picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
}

.picker-modal {
  width: min(760px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  background: var(--background-secondary);
  border: 1px solid var(--background-tertiary);
  border-radius: 12px;
  padding: 20px;
}

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.picker-header h3 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--text-primary);
}

.picker-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.picker-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--background-tertiary);
}

.picker-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.9rem;
}

.picker-tab.active {
  color: var(--text-primary);
  border-bottom-color: var(--accent-color, #5865f2);
}

.tab-count {
  font-size: 0.72rem;
  opacity: 0.6;
  background: var(--background-tertiary);
  border-radius: 999px;
  padding: 1px 7px;
}

.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  overflow-y: auto;
}

.picker-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--background-tertiary);
  border-radius: 8px;
  background: var(--background-primary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}

.picker-item:hover {
  border-color: var(--accent-color, #5865f2);
  color: var(--text-primary);
}

.picker-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 6px;
  overflow: hidden;
}

.thumb-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.thumb-placeholder {
  font-size: 1.6rem;
  opacity: 0.5;
}

.picker-label {
  font-size: 0.8rem;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-empty {
  grid-column: 1 / -1;
  text-align: center;
  padding: 32px;
  color: var(--text-secondary);
  opacity: 0.7;
}

.picker-fade-enter-active,
.picker-fade-leave-active {
  transition: opacity 0.15s ease;
}

.picker-fade-enter-from,
.picker-fade-leave-to {
  opacity: 0;
}
</style>
