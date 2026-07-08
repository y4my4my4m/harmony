<template>
  <BaseModal
    :show="show"
    :show-header="false"
    :compact="true"
    :background-image="bannerUrl"
    @close="$emit('close')"
  >
    <div class="invite-consent">
      <div class="invite-consent__icon">
        <img v-if="iconUrl" :src="iconUrl" :alt="serverName" />
        <span v-else class="invite-consent__icon-fallback">{{ serverInitial }}</span>
      </div>

      <p class="invite-consent__muted">You've been invited to join</p>
      <h2 class="invite-consent__title">{{ serverName }}</h2>

      <div class="invite-consent__meta">
        <span class="meta-dot"></span>
        <span>{{ memberCount }} {{ memberCount === 1 ? 'Member' : 'Members' }}</span>
      </div>

      <p v-if="description" class="invite-consent__description">{{ description }}</p>

      <button class="invite-consent__btn primary" :disabled="joining" @click="$emit('accept')">
        {{ joining ? 'Joining…' : acceptLabel }}
      </button>
      <button class="invite-consent__btn ghost" @click="$emit('close')">
        No Thanks
      </button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'

const props = defineProps<{
  show: boolean
  serverName: string
  description?: string | null
  memberCount: number
  iconUrl?: string | null
  bannerUrl?: string | null
  acceptAsName?: string | null
  joining?: boolean
}>()

defineEmits<{
  close: []
  accept: []
}>()

const serverInitial = computed(() => props.serverName?.charAt(0).toUpperCase() || 'S')
const acceptLabel = computed(() =>
  props.acceptAsName ? `Accept as ${props.acceptAsName}` : 'Accept Invite'
)
</script>

<style scoped>
.invite-consent {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 12px 4px 4px;
  text-align: center;
}

.invite-consent__icon {
  width: 72px;
  height: 72px;
  border-radius: 20px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.invite-consent__icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.invite-consent__icon-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--harmony-primary, #0ea5e9), var(--harmony-primary-hover, #38bdf8));
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
}

.invite-consent__muted {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.invite-consent__title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.invite-consent__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

.meta-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted, #80848e);
}

.invite-consent__description {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.invite-consent__btn {
  width: 100%;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.invite-consent__btn.primary {
  margin-top: 8px;
  background: linear-gradient(135deg, var(--harmony-primary, #0ea5e9), var(--harmony-primary-hover, #0284c7));
  color: var(--text-primary);
}

.invite-consent__btn.primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(14, 165, 233, 0.35);
}

.invite-consent__btn.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.invite-consent__btn.ghost {
  background: transparent;
  color: var(--text-secondary);
  font-weight: 500;
  padding: 6px;
}

.invite-consent__btn.ghost:hover {
  color: var(--text-primary);
  text-decoration: underline;
}
</style>
