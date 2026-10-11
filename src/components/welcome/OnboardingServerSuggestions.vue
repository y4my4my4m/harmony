<template>
  <section class="onboarding-suggestions" :aria-labelledby="headingId" data-testid="onboarding-suggestions">
    <header class="os-header">
      <h2 :id="headingId" class="os-heading">
        {{ source === 'welcome' ? $t('welcomeServer.recommendedHeading') : $t('welcomeServer.featuredHeading', { instance: instanceName }) }}
      </h2>
      <p class="os-subheading">
        {{ source === 'welcome' ? $t('welcomeServer.recommendedSubheading') : $t('welcomeServer.featuredSubheading') }}
      </p>
    </header>

    <ul class="os-list">
      <li v-for="server in servers" :key="server.id" class="os-card" :class="{ 'is-primary': source === 'welcome' }">
        <div v-if="source === 'welcome'" class="os-banner" :class="{ 'has-image': !!bannerUrl(server) }" :style="bannerStyle(server)" aria-hidden="true"></div>
        <div class="os-body">
          <ServerIcon
            class="os-icon"
            :src="server.icon"
            :alt="server.name"
            :size="source === 'welcome' ? 'lg' : 'md'"
            shape="big-rounded"
            :show-title="false"
          />
          <div class="os-text">
            <h3 class="os-name">{{ server.name }}</h3>
            <p class="os-members">
              <Icon name="users" :size="13" />
              {{ $t('welcomeServer.memberCount', { count: formatCount(server.member_count) }, server.member_count) }}
            </p>
            <p v-if="server.description" class="os-description">{{ server.description }}</p>
          </div>
        </div>
        <!-- The joining button keeps focus (aria-disabled); the others are disabled. -->
        <button
          type="button"
          class="btn btn-primary os-join"
          :disabled="!!joiningId && joiningId !== server.id"
          :aria-disabled="joiningId === server.id || undefined"
          :aria-busy="joiningId === server.id || undefined"
          :aria-label="joiningId === server.id
            ? $t('welcomeServer.joiningNamed', { server: server.name })
            : $t('welcomeServer.joinNamed', { server: server.name })"
          data-testid="onboarding-join"
          @click="requestJoin(server.id)"
        >
          <span v-if="joiningId === server.id" class="os-spinner" aria-hidden="true"></span>
          {{ joiningId === server.id ? $t('welcomeServer.joining') : $t('welcomeServer.join') }}
        </button>
      </li>
    </ul>

    <button type="button" class="os-skip" :disabled="!!joiningId" data-testid="onboarding-skip" @click="emit('skip')">
      {{ skipLabel || $t('welcomeServer.skip') }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, useId, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import ServerIcon from '@/components/common/ServerIcon.vue'
import { getServerBannerUrl } from '@/utils/serverUtils'
import { withRenderFallback } from '@/utils/renderFallback'
import type { OnboardingServer } from '@/services/ServerWelcomeService'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { useT } from '@/composables/useT'
import { useServerChannelStore } from '@/stores/useServerChannel'

const props = withDefaults(defineProps<{
  servers: OnboardingServer[]
  source: 'welcome' | 'featured'
  instanceName: string
  joiningId?: string | null
  skipLabel?: string
}>(), {
  joiningId: null,
  skipLabel: '',
})

const emit = defineEmits<{
  join: [serverId: string]
  skip: []
}>()

const headingId = `os-${useId()}`
const { t } = useT()
const { polite } = useAnnouncer()

function requestJoin(serverId: string) {
  if (props.joiningId) return
  emit('join', serverId)
}

function serverName(id: string): string {
  return props.servers.find((s) => s.id === id)?.name ?? ''
}

/** True once the server is in the member's list; a failed join toasts on its own. */
function isMember(id: string): boolean {
  try {
    return useServerChannelStore().servers.some((s) => s.id === id)
  } catch {
    return false
  }
}

function announceJoined(id: string) {
  if (isMember(id)) polite(t('welcomeServer.joinedNamed', { server: serverName(id) }))
}

watch(
  () => props.joiningId,
  (id, previous) => {
    if (id) polite(t('welcomeServer.joiningNamed', { server: serverName(id) }))
    else if (previous) announceJoined(previous)
  },
)

// A successful join can unmount the parent before joiningId clears.
onBeforeUnmount(() => {
  if (props.joiningId) announceJoined(props.joiningId)
})

const numberFormat = new Intl.NumberFormat()
function formatCount(count: number): string {
  return numberFormat.format(count)
}

function bannerUrl(server: OnboardingServer): string | null {
  return withRenderFallback(getServerBannerUrl(server.banner, { width: 960, height: 240 }))
}

function bannerStyle(server: OnboardingServer): Record<string, string> {
  const url = bannerUrl(server)
  return url ? { backgroundImage: `url("${url}")` } : {}
}
</script>

<style scoped>
.onboarding-suggestions {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.os-heading {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.os-subheading {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.os-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.os-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.os-card.is-primary {
  flex-direction: column;
  align-items: stretch;
  padding: 0;
  border-color: color-mix(in srgb, var(--harmony-primary) 45%, var(--border-primary));
}

.os-banner {
  height: 72px;
  background:
    linear-gradient(135deg,
      color-mix(in srgb, var(--harmony-primary) 55%, transparent),
      color-mix(in srgb, var(--harmony-primary) 15%, var(--background-tertiary)));
  background-size: cover;
  background-position: center;
}

.os-banner.has-image {
  height: 96px;
}

.os-body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.is-primary .os-body {
  padding: 0 var(--space-4);
  margin-top: -28px;
}

.os-icon {
  flex-shrink: 0;
}

.is-primary .os-icon {
  border: 3px solid var(--background-secondary);
  border-radius: 18px;
  background: var(--background-secondary);
}

.os-text {
  flex: 1;
  min-width: 0;
}

.is-primary .os-text {
  padding-top: 32px;
}

.os-name {
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.os-members {
  margin: 2px 0 0;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.os-description {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.os-join {
  flex-shrink: 0;
  justify-content: center;
  gap: var(--space-2);
}

.is-primary .os-join {
  margin: 0 var(--space-4) var(--space-4);
  min-height: 44px;
}

.os-join[aria-disabled='true'] {
  opacity: 0.6;
  cursor: progress;
}

.os-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: os-spin 0.8s linear infinite;
}

@keyframes os-spin {
  to { transform: rotate(360deg); }
}

.os-skip {
  align-self: center;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: none;
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.os-skip:hover:not(:disabled) {
  color: var(--text-primary);
  text-decoration: underline;
}

.os-skip:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

@media (max-width: 480px) {
  .os-card:not(.is-primary) {
    flex-wrap: wrap;
  }

  .os-card:not(.is-primary) .os-join {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .os-spinner {
    animation-duration: 2.4s;
  }
}
</style>
