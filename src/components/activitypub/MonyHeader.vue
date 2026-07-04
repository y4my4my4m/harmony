<template>
  <div ref="headerRef" class="mony-header">
    <div class="header-left">
      <button 
        v-if="isMobile"
        class="mobile-menu-btn"
        @click="$emit('toggle-left-sidebar')"
      >
        <svg viewBox="0 0 24 24" class="menu-icon">
          <path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z" fill="currentColor"/>
        </svg>
      </button>
    </div>

    <div class="header-center">
      <div :class="['feed-switcher', { compact: isCompact }]">
        <button
          v-for="tab in feedTabs"
          :key="tab.id"
          @click="$emit('switch-feed', tab.id)"
          :class="['feed-tab', { active: currentView === tab.id }]"
          :title="tab.label"
        >
          <svg viewBox="0 0 24 24" class="tab-icon">
            <path :d="getIconPath(tab.icon)" fill="currentColor"/>
          </svg>
          <span class="tab-label">{{ tab.label }}</span>
        </button>
      </div>
    </div>

    <div class="header-actions">
      <button 
        class="action-btn search-btn"
        @click="$emit('open-search')"
        :title="$t('activitypub.searchAction')"
      >
        <svg viewBox="0 0 24 24" class="search-icon">
          <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
        </svg>
      </button>
      
      <button 
        class="action-btn composer-btn"
        data-testid="compose-btn"
        @click="$emit('open-composer')"
        :title="$t('activitypub.composeAction')"
      >
        <svg viewBox="0 0 24 24" class="composer-icon">
          <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
        </svg>
      </button>
      
      <button 
        class="action-btn refresh-btn"
        @click="$emit('refresh-timeline')"
        :title="$t('activitypub.refreshAction')"
      >
        <svg viewBox="0 0 24 24" class="refresh-icon">
          <path d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z" fill="currentColor"/>
        </svg>
      </button>
      
      <button 
        class="action-btn sidebar-btn"
        :class="{ active: rightSidebarOpen }"
        @click="$emit('toggle-right-sidebar')"
        :title="$t('activitypub.toggleSidebarAction')"
        v-if="!isMobile"
      >
        <svg viewBox="0 0 24 24" class="sidebar-icon">
          <path d="M3,3H21A2,2 0 0,1 23,5V19A2,2 0 0,1 21,21H3A2,2 0 0,1 1,19V5A2,2 0 0,1 3,3M3,5V19H13V5H3M15,5V19H21V5H15Z" fill="currentColor"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';

const { t } = useI18n();
const instanceSettings = useInstanceSettingsStore();

interface Props {
  currentView?: string
  isMobile?: boolean
  rightSidebarOpen?: boolean
}

// eslint-disable-next-line unused-imports/no-unused-vars
const props = withDefaults(defineProps<Props>(), {
  currentView: 'home',
  isMobile: false,
  rightSidebarOpen: false
})

// eslint-disable-next-line unused-imports/no-unused-vars
const emit = defineEmits<{
  'switch-feed': [feedType: string]
  'refresh-timeline': []
  'open-composer': []
  'open-search': []
  'toggle-left-sidebar': []
  'toggle-right-sidebar': []
}>()

const headerRef = ref<HTMLElement | null>(null);
const isCompact = ref(false);
let resizeObserver: ResizeObserver | null = null;

const COMPACT_THRESHOLD = 600;

onMounted(() => {
  if (headerRef.value) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        isCompact.value = entry.contentRect.width < COMPACT_THRESHOLD;
      }
    });
    resizeObserver.observe(headerRef.value as unknown as Element);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
});

const allFeedTabs = [
  { 
    id: 'home', 
    label: t('activitypub.home'), 
    icon: 'home',
    requiresFederation: false
  },
  { 
    id: 'local', 
    label: t('activitypub.local'), 
    icon: 'users',
    requiresFederation: false
  },
  { 
    id: 'public', 
    label: t('activitypub.federated'), 
    icon: 'globe',
    requiresFederation: true
  },
  { 
    id: 'trending', 
    label: t('activitypub.trending'), 
    icon: 'trending-up',
    requiresFederation: false
  },
  { 
    id: 'instances', 
    label: t('activitypub.instances'), 
    icon: 'server',
    requiresFederation: true
  }
]

const feedTabs = computed(() => 
  allFeedTabs.filter(tab => 
    !tab.requiresFederation || instanceSettings.isFederationEnabled
  )
)

// Icon paths
const getIconPath = (iconName: string): string => {
  const icons: Record<string, string> = {
    home: 'M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z',
    users: 'M12,5.5A3.5,3.5 0 0,1 15.5,9A3.5,3.5 0 0,1 12,12.5A3.5,3.5 0 0,1 8.5,9A3.5,3.5 0 0,1 12,5.5M5,8C5.56,8 6.08,8.15 6.53,8.42C6.38,9.85 6.8,11.27 7.66,12.38C7.16,13.34 6.16,14 5,14A3,3 0 0,1 2,11A3,3 0 0,1 5,8M19,8A3,3 0 0,1 22,11A3,3 0 0,1 19,14C17.84,14 16.84,13.34 16.34,12.38C17.2,11.27 17.62,9.85 17.47,8.42C17.92,8.15 18.44,8 19,8M5.5,18.25C5.5,16.18 8.41,14.5 12,14.5C15.59,14.5 18.5,16.18 18.5,18.25V20H5.5V18.25M0,20V18.5C0,17.11 1.89,15.94 4.45,15.6C3.86,16.28 3.5,17.22 3.5,18.25V20H0M24,20H20.5V18.25C20.5,17.22 20.14,16.28 19.55,15.6C22.11,15.94 24,17.11 24,18.5V20Z',
    globe: 'M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.78 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z',
    'trending-up': 'M16,6L18.29,8.29L13.41,13.17L9.41,9.17L2,16.59L3.41,18L9.41,12L13.41,16L19.71,9.71L22,12V6H16Z',
    server: 'M4,1H20A1,1 0 0,1 21,2V6A1,1 0 0,1 20,7H4A1,1 0 0,1 3,6V2A1,1 0 0,1 4,1M4,9H20A1,1 0 0,1 21,10V14A1,1 0 0,1 20,15H4A1,1 0 0,1 3,14V10A1,1 0 0,1 4,9M4,17H20A1,1 0 0,1 21,18V22A1,1 0 0,1 20,23H4A1,1 0 0,1 3,22V18A1,1 0 0,1 4,17M5,2V6H19V2H5M5,10V14H19V10H5M5,18V22H19V18H5M7,4H9V4.75H7V4M7,12H9V12.75H7V12M7,20H9V20.75H7V20Z'
  }
  return icons[iconName] || icons.home
}
</script>

<style scoped>
.mony-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  height: 48px;
  min-height: 48px;
}

.header-left {
  display: flex;
  align-items: center;
  width: 100px; /* Fixed width for balance */
}

.mobile-menu-btn {
  display: none;
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.mobile-menu-btn:hover {
  background: var(--background-secondary);
}

.menu-icon {
  width: 20px;
  height: 20px;
}

.header-center {
  flex: 1;
  display: flex;
  justify-content: center;
  min-width: 0;
}
/* Feed Switcher */
.feed-switcher {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--background-tertiary-alpha);
  /* border: 2px solid rgba(14, 165, 233, 0.3); */
  border: 2px solid var(--harmony-primary-alpha);
  border-radius: 16px;
  padding: 4px;
  backdrop-filter: blur(10px);
}

.feed-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px;
  background: transparent;
  border: none;
  border-radius: 12px;
  color: #80848e;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: nowrap;
  position: relative;
  overflow: hidden;
}

.feed-tab::before {
  content: '';
  position: absolute;
  inset: 0;
  /* background: linear-gradient(135deg, rgba(14, 165, 233, 0.1), rgba(14, 165, 233, 0.05)); */
  background: linear-gradient(135deg, var(--harmony-primary-alpha), var(--harmony-primary-alpha-light));
  opacity: 0;
  transition: opacity 0.3s ease;
}

.feed-tab:hover {
  color: var(--text-primary);
  transform: translateY(-1px);
}

.feed-tab:hover::before {
  opacity: 1;
}

.feed-tab.active {
  /* background: linear-gradient(135deg, var(--harmony-primary), #0284C7); */
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  color: var(--text-primary);
  /* box-shadow:  */
    /* 0 0 13px rgba(14, 165, 233, 0.4), */
    /* inset 0 -2px 2px rgba(0, 0, 0, 0.3), */
    /* inset 0 1px 0 rgba(255, 255, 255, 0.2); */
  box-shadow:
    0 0 13px var(--harmony-primary-alpha),
    inset 0 -2px 2px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.feed-tab.active::before {
  opacity: 0;
}

.tab-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.tab-label {
  display: inline-block;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: max-width 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.25s ease,
              margin-left 0.35s cubic-bezier(0.4, 0, 0.2, 1);
}

.compact .feed-tab:not(.active) .tab-label {
  max-width: 0;
  opacity: 0;
  margin-left: 0;
}

.compact .feed-tab.active .tab-label {
  max-width: 120px;
  opacity: 1;
  margin-left: 4px;
}

/* Small mode at 1550px and under: only the selected view's name is displayed */
@media (max-width: 1550px) {
  .feed-switcher .feed-tab:not(.active) .tab-label {
    max-width: 0;
    opacity: 0;
    margin-left: 0;
  }

  .feed-switcher .feed-tab.active .tab-label {
    max-width: 120px;
    opacity: 1;
    margin-left: 4px;
  }
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100px; /* Fixed width for balance */
  justify-content: flex-end;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  color: var(--text-primary);
  padding: 5px;
}

.action-btn:hover {
  background: var(--harmony-primary-hover, #0284C7);
  color: var(--text-light);
}

.action-btn:active {
  background: var(--harmony-primary-hover, #0284C7);
  color: var(--text-light);
}

.search-icon,
.composer-icon,
.refresh-icon,
.sidebar-icon {
  width: 18px;
  height: 18px;
}
.sidebar-btn.active {
  color: var(--harmony-primary, #0EA5E9);
  /* background: var(--harmony-primary-alpha, rgba(14, 165, 233, 0.1)); */
}
.sidebar-btn:hover {
  color: var(--harmony-primary, #0EA5E9);
}

/* Mobile styles */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }

  /* Standard mobile app-bar height; 48px left the 36px buttons with almost
     no breathing room. */
  .mony-header {
    height: 56px;
    min-height: 56px;
    padding: 8px 12px;
    gap: 8px;
  }

  .header-left,
  .header-actions {
    width: auto;
  }

  .header-actions {
    gap: 4px;
  }

  .feed-switcher {
    gap: 2px;
    padding: 3px;
  }

  .feed-tab {
    padding: 6px 10px;
    font-size: 12px;
  }

  .action-btn {
    width: 36px;
    height: 36px;
  }

  .search-icon,
  .composer-icon,
  .refresh-icon,
  .sidebar-icon {
    width: 20px;
    height: 20px;
  }
}

/* Extra small mobile */
@media (max-width: 480px) {
  .mony-header {
    padding: 8px;
  }

  .feed-switcher {
    gap: 1px;
  }

  .feed-tab {
    padding: 6px 8px;
  }

  .tab-icon {
    width: 14px;
    height: 14px;
  }

  /* Timeline refreshes on tab switch and via new-post realtime; the manual
     refresh button is the first to go when width runs out. */
  .refresh-btn {
    display: none;
  }
}
</style>