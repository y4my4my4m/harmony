<template>
  <div class="main-navigation">
    <!-- DM Button -->
    <div class="nav-section">
      <router-link 
        to="/dm" 
        class="nav-item dm-button"
        :class="{ 'active': isDMRoute }"
        title="Direct Messages"
      >
        <div class="nav-icon">
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M12,2A2,2 0 0,1 14,4C14,4.74 13.6,5.39 13,5.73V7H14A7,7 0 0,1 21,14H22A1,1 0 0,1 23,15V18A1,1 0 0,1 22,19H21V20A2,2 0 0,1 19,22H5A2,2 0 0,1 3,20V19H2A1,1 0 0,1 1,18V15A1,1 0 0,1 2,14H3A7,7 0 0,1 10,7H11V5.73C10.4,5.39 10,4.74 10,4A2,2 0 0,1 12,2M5,9V19H19V9A5,5 0 0,0 14,4H10A5,5 0 0,0 5,9Z" fill="currentColor"/>
          </svg>
        </div>
        <div v-if="dmStore.getTotalUnreadCount > 0" class="unread-badge">
          {{ dmStore.getTotalUnreadCount > 99 ? '99+' : dmStore.getTotalUnreadCount }}
        </div>
      </router-link>
    </div>

    <!-- Divider -->
    <div class="nav-divider"></div>

    <!-- Server List -->
    <div class="nav-section servers-section">
      <div
        v-for="server in servers"
        :key="server.id"
        class="nav-item server-item"
        :class="{ 'active': isServerActive(server.id) }"
        @click="selectServer(server.id)"
        :title="server.name"
      >
        <div class="server-icon">
          <img 
            v-if="server.icon" 
            :src="server.icon" 
            :alt="server.name"
            class="server-image"
          />
          <div v-else class="server-acronym">
            {{ getServerAcronym(server.name) }}
          </div>
        </div>
        <div class="server-pill" :class="{ 'visible': isServerActive(server.id) }"></div>
      </div>

      <!-- Add Server Button -->
      <div 
        class="nav-item add-server-btn"
        @click="showAddServerModal = true"
        title="Add a Server"
      >
        <div class="nav-icon">
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
          </svg>
        </div>
      </div>

      <!-- Explore Public Servers -->
      <div 
        class="nav-item explore-btn"
        @click="$emit('showPublicServers')"
        title="Explore Public Servers"
      >
        <div class="nav-icon">
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
          </svg>
        </div>
      </div>
    </div>

    <!-- Bottom Section (User Settings) -->
    <div class="nav-section nav-bottom">
      <div class="nav-divider"></div>
      <router-link 
        to="/settings" 
        class="nav-item settings-btn"
        title="User Settings"
      >
        <div class="nav-icon">
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.22,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.22,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.68 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z" fill="currentColor"/>
          </svg>
        </div>
      </router-link>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useDMStore } from '@/stores/useDM'
import type { Server } from '@/types'

interface Props {
  servers: Server[]
  showAddServerModal?: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'showPublicServers': []
  'update:showAddServerModal': [value: boolean]
}>()

const route = useRoute()
const router = useRouter()
const serverChannelStore = useServerChannelStore()
const dmStore = useDMStore()

// Computed properties
const isDMRoute = computed(() => {
  return route.path.startsWith('/dm')
})

const showAddServerModal = computed({
  get: () => props.showAddServerModal || false,
  set: (value: boolean) => emit('update:showAddServerModal', value)
})

// Methods
const isServerActive = (serverId: string): boolean => {
  return route.params.serverId === serverId
}

const selectServer = (serverId: string) => {
  router.push({ name: 'Chat', params: { serverId } })
}

const getServerAcronym = (serverName: string): string => {
  return serverName
    .split(' ')
    .map(word => word.charAt(0).toUpperCase())
    .join('')
    .substring(0, 2)
}
</script>

<style scoped>
.main-navigation {
  width: 72px;
  min-width: 72px;
  background: var(--h-server-sidebar, #202225);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  height: 100vh;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.main-navigation::-webkit-scrollbar {
  display: none;
}

.nav-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.nav-bottom {
  margin-top: auto;
}

.nav-divider {
  width: 32px;
  height: 2px;
  background: var(--h-chat-light, #40444b);
  border-radius: 1px;
  margin: 8px 0;
}

.nav-item {
  position: relative;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  cursor: pointer;
  transition: all 0.15s ease;
  text-decoration: none;
  overflow: hidden;
}

.nav-item:hover {
  border-radius: 16px;
  background: var(--h-brand, #5865f2);
}

.nav-item.active {
  border-radius: 16px;
  background: var(--h-brand, #5865f2);
}

.dm-button {
  background: var(--h-chat, #36393f);
  color: #ffffff;
}

.dm-button:hover,
.dm-button.active {
  background: var(--h-brand, #5865f2);
}

.nav-icon {
  width: 24px;
  height: 24px;
  color: #b9bbbe;
  transition: color 0.15s ease;
}

.nav-item:hover .nav-icon,
.nav-item.active .nav-icon {
  color: #ffffff;
}

.dm-button .nav-icon {
  color: #ffffff;
}

.icon {
  width: 100%;
  height: 100%;
}

.unread-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #f04747;
  color: #ffffff;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--h-server-sidebar, #202225);
  line-height: 1;
}

.servers-section {
  flex: 1;
  padding: 8px 0;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.servers-section::-webkit-scrollbar {
  display: none;
}

.server-item {
  background: var(--h-chat, #36393f);
  position: relative;
}

.server-item:hover {
  background: var(--h-brand, #5865f2);
}

.server-item.active {
  background: var(--h-brand, #5865f2);
}

.server-icon {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: inherit;
  overflow: hidden;
}

.server-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}

.server-acronym {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  text-align: center;
  line-height: 1;
}

.server-pill {
  position: absolute;
  left: -4px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 8px;
  background: #ffffff;
  border-radius: 0 4px 4px 0;
  opacity: 0;
  transition: all 0.15s ease;
}

.server-pill.visible {
  opacity: 1;
  height: 40px;
}

.server-item:hover .server-pill {
  opacity: 1;
  height: 20px;
}

.add-server-btn,
.explore-btn,
.settings-btn {
  background: var(--h-chat, #36393f);
  color: #3ba55c;
}

.add-server-btn:hover,
.explore-btn:hover,
.settings-btn:hover {
  background: #3ba55c;
  color: #ffffff;
}

.add-server-btn .nav-icon,
.explore-btn .nav-icon {
  color: #3ba55c;
}

.add-server-btn:hover .nav-icon,
.explore-btn:hover .nav-icon,
.settings-btn:hover .nav-icon {
  color: #ffffff;
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .main-navigation {
    width: 60px;
    min-width: 60px;
    padding: 8px 0;
  }
  
  .nav-item {
    width: 40px;
    height: 40px;
  }
  
  .nav-icon {
    width: 20px;
    height: 20px;
  }
  
  .server-acronym {
    font-size: 14px;
  }
  
  .unread-badge {
    font-size: 9px;
    padding: 1px 4px;
    min-width: 14px;
    height: 14px;
  }
}

@media (max-width: 480px) {
  .main-navigation {
    width: 100%;
    height: auto;
    flex-direction: row;
    padding: 8px;
    overflow-x: auto;
    overflow-y: hidden;
  }
  
  .nav-section {
    flex-direction: row;
    min-width: fit-content;
  }
  
  .servers-section {
    flex: none;
    padding: 0 8px;
  }
  
  .nav-bottom {
    margin-top: 0;
    margin-left: auto;
  }
  
  .nav-divider {
    width: 2px;
    height: 32px;
    margin: 0 8px;
  }
}
</style>