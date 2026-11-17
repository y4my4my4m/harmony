<!--
  Join control of an activity_started system row: the live player count and Join while the
  session runs, "Playing" while this client is in it. Reads the session on mount and every POLL_MS
  while it is active and on screen.
-->
<template>
  <span v-if="session && session.status === 'active'" class="pt-card" data-testid="activity-system-card">
    <span class="pt-card__count">{{ t('playTogether.playing', { n: session.members.length }, session.members.length) }}</span>
    <button
      v-if="!store.isJoined(session.id) && !session.refusal"
      type="button"
      class="pt-card__join"
      :disabled="joining"
      data-testid="activity-system-join"
      @click="join"
    >{{ t('playTogether.join') }}</button>
    <span v-else-if="store.isJoined(session.id)" class="pt-card__in">{{ t('playTogether.youArePlaying') }}</span>
    <span v-else-if="session.refusal === 'NOT_IN_CALL'" class="pt-card__in">{{ t('playTogether.joinTheCall') }}</span>
  </span>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useT } from '@/composables/useT'
import { usePlayTogetherStore } from '@/stores/playTogether'
import { getSession, type ActivitySession } from '@/services/playTogether/sessions'

const POLL_MS = 20_000

const props = defineProps<{ sessionId: string }>()
const { t } = useT()
const store = usePlayTogetherStore()
const session = ref<ActivitySession | null>(null)
const joining = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

async function read(): Promise<void> {
  if (document.visibilityState !== 'visible') return
  session.value = await getSession(props.sessionId).catch(() => session.value)
  if (session.value?.status !== 'active' && timer) {
    clearInterval(timer)
    timer = null
  }
}

async function join(): Promise<void> {
  if (!session.value || joining.value) return
  joining.value = true
  try {
    await store.join(session.value)
  } finally {
    joining.value = false
  }
}

watch(() => store.joined?.session.id, () => void read())

onMounted(() => {
  void read()
  timer = setInterval(() => void read(), POLL_MS)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.pt-card {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: 8px;
  vertical-align: middle;
}

.pt-card__count,
.pt-card__in {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-muted);
}

.pt-card__join {
  padding: 3px 12px;
  border: 0;
  border-radius: 6px;
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-semibold, 600);
  cursor: pointer;
}

.pt-card__join:disabled {
  opacity: 0.6;
}
</style>
