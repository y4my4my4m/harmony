<template>
  <BaseModal
    :show="show"
    :show-header="false"
    :compact="false"
    @close="$emit('close')"
  >
    <div v-if="user" class="profile-modal-content">
      <div class="profile-banner" :style="bannerStyle">
        <div class="banner-gradient" :style="bannerStyle" />
        <div class="banner-actions">
          <button class="close-button" aria-label="Close" @click="$emit('close')">
            <Icon name="close" :size="16" class="close-icon" />
          </button>
        </div>
      </div>

      <div class="profile-content">
        <div class="profile-header">
          <div class="avatar-container">
            <Avatar
              :src="user.avatarUrl || '/default_avatar.webp'"
              :alt="`${displayName}'s avatar`"
              class="profile-avatar"
            />
          </div>

          <div class="profile-info">
            <div class="name-section">
              <h1 class="display-name" :style="{ color: nameColor }">
                {{ displayName }}
              </h1>
              <p class="username">@{{ user.username }}</p>
            </div>

            <div class="discord-badge-row">
              <span class="discord-source-badge" title="Discord bridge member">
                <svg viewBox="0 0 24 24" fill="currentColor" class="discord-icon" aria-hidden="true">
                  <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09c-.01-.02-.04-.03-.07-.03c-1.5.26-2.93.71-4.27 1.33c-.01 0-.02.01-.03.02c-2.72 4.07-3.47 8.03-3.1 11.95c0 .02.01.04.03.05c1.8 1.32 3.53 2.12 5.24 2.65c.03.01.06 0 .07-.02c.4-.55.76-1.13 1.07-1.74c.02-.04 0-.08-.04-.09c-.57-.22-1.11-.48-1.64-.78c-.04-.02-.04-.08-.01-.11c.11-.08.22-.17.33-.25c.02-.02.05-.02.07-.01c3.44 1.57 7.15 1.57 10.55 0c.02-.01.05-.01.07.01c.11.09.22.17.33.26c.04.03.04.09-.01.11c-.52.31-1.07.56-1.64.78c-.04.01-.05.06-.04.09c.32.61.68 1.19 1.07 1.74c.03.01.06.02.09.01c1.72-.53 3.45-1.33 5.25-2.65c.02-.01.03-.03.03-.05c.44-4.53-.73-8.46-3.1-11.95c-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.83 2.12-1.89 2.12z"/>
                </svg>
                Discord
              </span>
            </div>

            <div v-if="sortedRoles.length" class="roles-container">
              <div
                v-for="role in sortedRoles"
                :key="role.id"
                class="role-badge"
                :style="roleBadgeStyle(role)"
              >
                {{ role.name }}
              </div>
            </div>
          </div>
        </div>

        <p class="bridge-note">
          This member is on Discord. Messages and mentions are bridged through the Harmony Discord bot.
        </p>

        <div class="user-stats">
          <div v-if="user.joinedAt" class="stat-item">
            <span class="stat-value">{{ formatDate(user.joinedAt) }}</span>
            <span class="stat-label">Joined Server</span>
          </div>
          <div v-if="user.createdAt" class="stat-item">
            <span class="stat-value">{{ formatDate(user.createdAt) }}</span>
            <span class="stat-label">Discord Member Since</span>
          </div>
        </div>

        <div class="profile-actions">
          <button class="secondary-action-btn" type="button" @click="copyDiscordId">
            <Icon name="copy" class="btn-icon" />
            Copy Discord ID
          </button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import type { BridgedChannelUser, BridgedDiscordRole } from '@/services/bridgedChannelUsersService'
import { debug } from '@/utils/debug'

const props = defineProps<{
  show: boolean
  user: BridgedChannelUser | null
}>()

defineEmits<{
  close: []
}>()

const displayName = computed(() => props.user?.displayName || props.user?.username || 'Discord User')

const sortedRoles = computed((): BridgedDiscordRole[] => {
  const roles = props.user?.roles ?? []
  return [...roles].sort((a, b) => b.position - a.position)
})

const nameColor = computed(() => {
  const colored = sortedRoles.value.find(r => r.color)
  return colored?.color ?? '#5865F2'
})

const bannerStyle = computed(() => {
  if (props.user?.bannerUrl) {
    return {
      backgroundImage: `url(${props.user.bannerUrl})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }
  }
  if (props.user?.accentColor) {
    return { backgroundColor: props.user.accentColor }
  }
  return { background: 'linear-gradient(135deg, #5865F2 0%, #3c45a5 100%)' }
})

function roleBadgeStyle(role: BridgedDiscordRole) {
  if (!role.color) {
    return {
      backgroundColor: 'rgba(255, 255, 255, 0.08)',
      borderColor: 'rgba(255, 255, 255, 0.12)',
      color: 'var(--text-primary)',
    }
  }
  return {
    backgroundColor: role.color,
    borderColor: `${role.color}33`,
    color: '#fff',
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

async function copyDiscordId() {
  if (!props.user?.id) return
  try {
    await navigator.clipboard.writeText(props.user.id)
  } catch (err) {
    debug.error('Failed to copy Discord ID:', err)
  }
}
</script>

<style scoped>
.profile-modal-content {
  margin: -20px -24px;
  overflow: hidden;
}

.profile-banner {
  position: relative;
  height: 120px;
  background: linear-gradient(135deg, #5865F2 0%, #3c45a5 100%);
}

.banner-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.4) 100%);
}

.banner-actions {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  gap: 8px;
}

.close-button {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.close-button:hover {
  background: rgba(0, 0, 0, 0.7);
}

.profile-content {
  padding: 0 24px 28px;
  margin-top: -40px;
  position: relative;
}

.profile-header {
  display: flex;
  gap: 16px;
  align-items: flex-end;
  margin-bottom: 16px;
}

.profile-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 6px solid var(--background-primary, #313338);
  flex-shrink: 0;
}

.profile-info {
  flex: 1;
  min-width: 0;
  padding-bottom: 4px;
}

.display-name {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
  line-height: 1.2;
}

.username {
  margin: 4px 0 0;
  color: var(--text-secondary);
  font-size: 14px;
}

.discord-badge-row {
  margin-top: 8px;
}

.discord-source-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #fff;
  background: #5865F2;
  padding: 4px 8px;
  border-radius: 4px;
}

.discord-icon {
  width: 14px;
  height: 14px;
}

.roles-container {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.role-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid transparent;
}

.bridge-note {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
  margin: 0 0 20px;
  padding: 12px;
  background: rgba(88, 101, 242, 0.1);
  border: 1px solid rgba(88, 101, 242, 0.2);
  border-radius: 8px;
}

.user-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.stat-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.profile-actions {
  display: flex;
  gap: 8px;
}

.secondary-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}

.secondary-action-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}

.btn-icon {
  width: 16px;
  height: 16px;
}
</style>
