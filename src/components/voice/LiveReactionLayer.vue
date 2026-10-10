<template>
  <div v-if="items.length" class="live-reactions" :class="{ compact }" aria-hidden="true">
    <div
      v-for="r in items"
      :key="r.id"
      class="live-reaction"
      :class="{ reduced }"
      :data-sender-id="r.senderId"
      :style="{
        left: `${(r.x * 100).toFixed(1)}%`,
        '--lr-drift': `${(r.drift * 100).toFixed(1)}cqw`,
        '--lr-rise': r.rise.toFixed(3),
        '--lr-duration': `${LIVE_REACTION_LIFETIME_MS}ms`,
      }"
    >
      <img
        v-if="r.display.kind === 'image'"
        class="live-reaction-emoji"
        :src="r.display.src"
        :alt="r.display.label"
        draggable="false"
      />
      <span v-else class="live-reaction-emoji live-reaction-glyph">{{ r.display.text }}</span>
      <span v-if="!compact" class="live-reaction-sender">
        <img class="live-reaction-avatar" :src="getAvatarUrl(avatar(r.senderId).value, 32)" alt="" draggable="false" />
        <DisplayName class="live-reaction-name" :user-id="r.senderId" :truncate="true" />
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, type ComputedRef } from 'vue';
import DisplayName from '@/components/DisplayName.vue';
import { useUserData } from '@/composables/useUserData';
import { getAvatarUrl } from '@/utils/avatarUtils';
import {
  LIVE_REACTION_LIFETIME_MS,
  liveReactionKey,
  liveReactions,
  type LiveReactionSource,
} from '@/services/voice/liveReactions';

// Floating emoji over one tile: the stream or camera of `userId`.
const props = withDefaults(defineProps<{
  userId: string;
  source: LiveReactionSource;
  /** Small surfaces (dock thumbnails): emoji only, no sender chip. */
  compact?: boolean;
}>(), {
  compact: false,
});

const { getUserAvatarUrl } = useUserData();

const key = computed(() => liveReactionKey(props.userId, props.source));
const items = computed(() => liveReactions.active.value.filter(r => r.key === key.value));

function prefersReducedMotion(): boolean {
  if (document.documentElement.getAttribute('data-reduce-motion') === 'true') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Read whenever the set changes, so a toggled preference applies to the next reaction.
const reduced = computed(() => items.value.length > 0 && prefersReducedMotion());

const avatars = new Map<string, ComputedRef<string | null | undefined>>();
function avatar(userId: string) {
  let entry = avatars.get(userId);
  if (!entry) {
    entry = getUserAvatarUrl(userId);
    avatars.set(userId, entry);
  }
  return entry;
}
</script>

<style scoped>
.live-reactions {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  pointer-events: none;
  container: live-reactions / size;
}

/* Transform and opacity only: the flight stays on the compositor. */
.live-reaction {
  position: absolute;
  bottom: 6%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: clamp(20px, 11cqmin, 44px);
  opacity: 0;
  transform: translateX(-50%);
  animation: live-reaction-float var(--lr-duration) cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
  will-change: transform, opacity;
}

.compact .live-reaction {
  font-size: clamp(16px, 16cqmin, 28px);
}

.live-reaction-emoji {
  display: block;
  width: 1.15em;
  height: 1.15em;
  object-fit: contain;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45));
  user-select: none;
}

.live-reaction-glyph {
  width: auto;
  height: auto;
  font-size: 1em;
  line-height: 1.15;
}

.live-reaction-sender {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 120px;
  padding: 1px 6px 1px 1px;
  border-radius: var(--radius-full);
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}

.live-reaction-avatar {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: cover;
}

.live-reaction-name {
  min-width: 0;
}

/* Filmstrip-sized tiles: the emoji alone. */
@container live-reactions (max-height: 160px) {
  .live-reaction-sender { display: none; }
}

@keyframes live-reaction-float {
  0% { opacity: 0; transform: translateX(-50%) translateY(0) scale(0.5); }
  10% { opacity: 1; transform: translateX(-50%) translateY(-6cqh) scale(1.15); }
  20% { transform: translateX(-50%) translateY(-12cqh) scale(1); }
  75% { opacity: 1; }
  100% { opacity: 0; transform: translateX(calc(-50% + var(--lr-drift))) translateY(-72cqh) scale(0.9); }
}

/* Reduced motion: appears where it lands and fades; nothing travels.
   The global reduced-motion rule (themes.css, design-system.css) cuts every
   animation to 0.01 ms, which would hold the final, transparent keyframe. */
.live-reaction.reduced {
  bottom: calc(12% + var(--lr-rise) * 55%);
  animation-name: live-reaction-fade;
  animation-timing-function: linear;
  animation-duration: var(--lr-duration) !important;
}

@keyframes live-reaction-fade {
  0% { opacity: 0; }
  10% { opacity: 1; }
  80% { opacity: 1; }
  100% { opacity: 0; }
}
</style>
