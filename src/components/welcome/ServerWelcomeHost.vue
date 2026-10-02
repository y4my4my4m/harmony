<template>
  <BaseModal
    :show="!!welcome"
    :show-header="false"
    :close-on-overlay="!mustAccept"
    overlay-class="server-welcome-overlay"
    @close="welcomeStore.dismiss()"
  >
    <ServerWelcomeScreen
      v-if="welcome"
      :server="{ name: welcome.name, icon: welcome.icon, banner: welcome.banner }"
      :message="welcome.message"
      :rules="welcome.rules"
      :action="action"
      :accepted-at="welcome.rules_accepted_at"
      :busy="welcomeStore.busy"
      :error="welcomeStore.error"
      @accept="welcomeStore.accept()"
      @close="welcomeStore.dismiss()"
    />
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import ServerWelcomeScreen from './ServerWelcomeScreen.vue'
import { useServerWelcomeStore } from '@/stores/useServerWelcome'
import { useServerChannelStore } from '@/stores/useServerChannel'

const props = withDefaults(defineProps<{ isDm?: boolean }>(), { isDm: false })

const welcomeStore = useServerWelcomeStore()
const serverChannelStore = useServerChannelStore()

const welcome = computed(() => welcomeStore.current)

const mustAccept = computed(() => !!welcome.value?.must_accept)

/** Accepting is offered to every member with acceptance pending, grandfathered or not. */
const action = computed<'accept' | 'ok'>(() => {
  const w = welcome.value
  if (!w) return 'ok'
  return w.require_acceptance && w.is_member && !w.can_manage && !w.rules_accepted_at ? 'accept' : 'ok'
})

// The screen is served by the server's home instance; remote servers have none.
watch(
  () => [serverChannelStore.currentServerId, props.isDm] as const,
  ([serverId, isDm]) => {
    if (!serverId || isDm) return
    const server = serverChannelStore.servers.find((s) => s.id === serverId)
    if (!server || server.is_local_server === false) return
    void welcomeStore.visit(serverId)
  },
  { immediate: true },
)
</script>
