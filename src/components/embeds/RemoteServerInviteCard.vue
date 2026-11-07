<template>
  <InviteCardLayout
    :state="state"
    :label="label"
    :name="server?.name"
    :icon-url="serverIcon"
    :description="server?.description"
    :member-count="server?.memberCount ?? null"
    :online-count="server?.onlineCount ?? null"
    :error-title="errorTitle"
    :error-message="errorMessage"
    :action="copyId ? 'open' : 'join'"
    data-testid="remote-invite-card"
    :data-status="invite?.status ?? 'invalid'"
    @join="join"
    @open="goToServer"
  >
    <template #below-action>
      <p class="remote-invite__instance" data-testid="remote-invite-instance" :title="instanceTitle">
        <img
          :src="instanceIcon"
          alt=""
          class="remote-invite__instance-icon"
          width="16"
          height="16"
          referrerpolicy="no-referrer"
          loading="lazy"
          decoding="async"
          @error="instanceIconFailed = true"
        />
        <span class="sr-only">{{ t('embeds.remoteInvite.hostedOn', { instance: instanceName }) }}</span>
        <span class="remote-invite__instance-name" aria-hidden="true">{{ instanceName }}</span>
      </p>
    </template>
  </InviteCardLayout>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import InviteCardLayout from './InviteCardLayout.vue'
import { useOpenServer } from '@/composables/useOpenServer'
import { useRemoteInvitePrompt } from '@/composables/useRemoteInvitePrompt'
import { federationServerService, remoteServerUuid } from '@/services/federation'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { readRemoteInvite, remoteInviteLink } from '@/utils/remoteInvite'
import { serverMonogramUrl } from '@/utils/serverMonogram'
import type { EmbedPayload, RemoteInviteSummary } from '@/types'

/** The Harmony app icon; the host runs Harmony. */
const INSTANCE_ICON_FALLBACK = '/img/app_icon_square.webp'

const props = defineProps<{ payload: EmbedPayload }>()
const emit = defineEmits<{ load: [] }>()

const { t } = useI18n()
const openServer = useOpenServer()
const serverStore = useServerChannelStore()

const link = computed(() => remoteInviteLink(props.payload.url))
const stored = computed(() => readRemoteInvite(props.payload.url, props.payload.remoteInvite))
const live = ref<RemoteInviteSummary | null>(null)
const invite = computed(() => live.value ?? stored.value)
const server = computed(() => (invite.value?.status === 'valid' ? invite.value.server ?? null : null))

const state = computed(() => (server.value ? 'ready' : 'error'))
const instanceName = computed(() => invite.value?.instance.name ?? link.value?.domain ?? '')
const instanceTitle = computed(() => {
  const domain = link.value?.domain
  return domain && domain !== instanceName.value ? `${instanceName.value} · ${domain}` : instanceName.value
})

const errorTitle = computed(() => (invite.value?.status === 'closed'
  ? t('embeds.remoteInvite.closedTitle')
  : t('embeds.invite.invalid')))

const label = computed(() => (server.value ? t('embeds.invite.label', { name: server.value.name }) : errorTitle.value))

const errorMessage = computed(() => (invite.value?.status === 'closed'
  ? t('embeds.remoteInvite.closedMessage', { instance: instanceName.value })
  : t('embeds.remoteInvite.notFound')))

const serverIcon = computed(() => (server.value ? server.value.icon ?? serverMonogramUrl(server.value.name) : null))

const instanceIconFailed = ref(false)
const instanceIcon = computed(() => (!instanceIconFailed.value && invite.value?.instance.icon) || INSTANCE_ICON_FALLBACK)
watch(() => invite.value?.instance.icon, () => { instanceIconFailed.value = false })

/** The viewer's copy of the server: a server hosted elsewhere whose Group is the invite's. */
const copyId = computed(() => {
  const groupId = server.value?.id
  if (!groupId) return null
  const uuid = remoteServerUuid(groupId)
  const inbox = `${groupId}/inbox`
  const copy = serverStore.servers.find((s) =>
    s.is_local_server === false && ((!!uuid && s.id === uuid) || s.federation_inbox_url === inbox))
  return copy?.id ?? null
})

function join(): void {
  if (link.value) useRemoteInvitePrompt().open(link.value.href)
}

function goToServer(): void {
  if (copyId.value) void openServer(copyId.value)
}

/** Counts and validity as the host answers now, through this instance's backend. A dead invite stays dead. */
async function refresh(): Promise<void> {
  const url = link.value?.href
  if (!url || stored.value?.status === 'invalid') return
  const answer = readRemoteInvite(url, await federationServerService.remoteInviteCard(url))
  if (answer && link.value?.href === url) live.value = answer
}

watch(() => props.payload.url, () => {
  live.value = null
  void refresh()
})

onMounted(() => {
  emit('load')
  void refresh()
})
</script>

<style scoped>
.remote-invite__instance {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 9.5rem;
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
}

.remote-invite__instance-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  object-fit: cover;
}

.remote-invite__instance-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Phones: the row sits centred under the full-width button (InviteCardLayout). */
@media (max-width: 520px) {
  .remote-invite__instance {
    justify-content: center;
    max-width: none;
  }
}
</style>
