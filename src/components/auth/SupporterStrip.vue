<!--
  SupporterStrip - "Recent supporters" under the sign-in card: one approved supporter message
  at a time, from get_public_supporter_messages (nothing unless the instance shows them
  publicly). One line, clipped with an ellipsis; text interpolation only. Moves on every
  ROTATE_MS while not hovered or focused, and not at all with reduced motion; the arrow
  button steps by hand. Colours are the sign-in page's (AuthShell's --surface, --border,
  --text, --text-muted).
-->
<template>
  <section
    v-if="current"
    class="supporter-strip"
    :aria-label="t('support.landing.label')"
    data-testid="supporter-strip"
    @mouseenter="paused = true"
    @mouseleave="paused = false"
    @focusin="paused = true"
    @focusout="paused = false"
  >
    <Icon name="heart" :size="14" class="supporter-strip__heart" aria-hidden="true" />
    <Transition name="supporter-strip-fade" mode="out-in">
      <p :key="current.id" class="supporter-strip__item" data-testid="supporter-strip-item">
        <q class="supporter-strip__body" data-testid="supporter-strip-body">{{ current.body }}</q>
        <span class="supporter-strip__name" data-testid="supporter-strip-name">{{ current.name ?? t('support.wall.anonymous') }}</span>
      </p>
    </Transition>
    <button
      v-if="messages.length > 1"
      type="button"
      class="supporter-strip__next"
      :aria-label="t('support.landing.next')"
      data-testid="supporter-strip-next"
      @click="step"
    >
      <Icon name="chevron-right" :size="14" aria-hidden="true" />
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { fundingService, type PublicSupporterMessage } from '@/services/FundingService'

const ROTATE_MS = 7000

const { t } = useT()
const messages = ref<PublicSupporterMessage[]>([])
const index = ref(0)
const paused = ref(false)
const current = computed(() => messages.value[index.value] ?? null)
let timer: ReturnType<typeof setInterval> | null = null

function step() {
  if (messages.value.length) index.value = (index.value + 1) % messages.value.length
}

onMounted(async () => {
  messages.value = await fundingService.getPublicSupporterMessages(6)
  const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (messages.value.length > 1 && !still) {
    timer = setInterval(() => { if (!paused.value && document.visibilityState === 'visible') step() }, ROTATE_MS)
  }
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.supporter-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 420px;
  min-height: 40px;
  margin: 16px 0 0;
  padding: 4px 6px 4px 14px;
  background: var(--surface-light);
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
  contain: paint;
}

.supporter-strip__heart {
  flex-shrink: 0;
  color: var(--harmony-primary);
}

.supporter-strip__item {
  display: flex;
  flex: 1;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 0.8125rem;
  line-height: 1.4;
  white-space: nowrap;
}

.supporter-strip__body {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
}

.supporter-strip__name {
  flex-shrink: 1;
  max-width: 40%;
  overflow: hidden;
  color: var(--text-muted);
  text-overflow: ellipsis;
}

.supporter-strip__name::before {
  content: '\2014\00a0';
}

.supporter-strip__next {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 999px;
  color: var(--text-muted);
  cursor: pointer;
}

.supporter-strip__next:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.supporter-strip__next:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

/* The narrow sign-in page runs the card edge to edge; the strip keeps the page gutter. */
@media (max-width: 959px) {
  .supporter-strip {
    align-self: stretch;
    width: auto;
    max-width: none;
    margin: 12px 16px 0;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .supporter-strip-fade-enter-active,
  .supporter-strip-fade-leave-active {
    transition: opacity 0.3s ease;
  }

  .supporter-strip-fade-enter-from,
  .supporter-strip-fade-leave-to {
    opacity: 0;
  }
}
</style>
