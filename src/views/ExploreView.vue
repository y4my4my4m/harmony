<template>
  <div class="explore-view">
    <div class="mony-header-container">
      <MonyHeader
        :current-view="currentView"
        :is-mobile="isMobile"
        :right-sidebar-open="rightSidebarOpen"
        @switch-feed="handleSwitchFeed"
        @refresh-timeline="handleRefresh"
        @open-composer="handleOpenComposer"
        @open-search="$emit('openSearch')"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-right-sidebar="$emit('toggleRightSidebar')"
      />
    </div>

    <div class="explore-content">
      <TrendingContent v-if="currentView === 'trending'" ref="trendingRef" />
      <InstancesContent v-else ref="instancesRef" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import TrendingContent from '@/components/activitypub/TrendingContent.vue'
import InstancesContent from '@/components/activitypub/InstancesContent.vue'
import MonyHeader from '@/components/activitypub/MonyHeader.vue'
import { useLayoutState } from '@/composables/useLayoutState'
import { useActivityPubStore } from '@/stores/useActivityPub'

interface Props {
  currentView: 'trending' | 'instances'
  rightSidebarOpen?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  rightSidebarOpen: false
})

defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  openSearch: []
}>()

const { isMobile } = useLayoutState()
const activityPubStore = useActivityPubStore()
const router = useRouter()

const trendingRef = ref<InstanceType<typeof TrendingContent> | null>(null)
const instancesRef = ref<InstanceType<typeof InstancesContent> | null>(null)

const handleRefresh = () => {
  if (props.currentView === 'trending') trendingRef.value?.refresh()
  else void instancesRef.value?.refreshContent()
}

const handleSwitchFeed = (feed: string) => {
  if (feed === props.currentView) {
    handleRefresh()
    return
  }
  router.push({ name: 'Social', params: { timeline: feed } })
}

const handleOpenComposer = () => {
  activityPubStore.openComposer()
}
</script>

<style scoped>
.explore-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mony-header-container {
  flex-shrink: 0;
}

.explore-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
