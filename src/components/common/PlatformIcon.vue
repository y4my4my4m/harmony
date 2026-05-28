<template>
  <svg
    v-if="iconData"
    role="img"
    :viewBox="iconData.viewBox"
    :width="size"
    :height="size"
    :aria-label="iconData.title"
    :style="useBrandColor ? { color: '#' + iconData.hex } : undefined"
    fill="currentColor"
  >
    <path :d="iconData.path" />
  </svg>
  <!-- Generic heart fallback for unknown / custom platforms -->
  <svg
    v-else
    role="img"
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    aria-label="Donate"
    fill="currentColor"
  >
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  siKofi,
  siPatreon,
  siGithubsponsors,
  siLiberapay,
  siOpencollective,
  siPaypal,
  siBuymeacoffee,
  siStripe,
  siCashapp,
  siVenmo,
  siBitcoin,
  siEthereum,
  siGithub,
  // Bridge platforms (used by BotAvatar.vue for branded bot icons)
  siDiscord,
  siSlack,
  siTelegram,
  siMatrix,
  siTwitch,
} from 'simple-icons'

/**
 * Per-icon imports from `simple-icons` (CC0) are tree-shakeable: only the
 * platforms used here ship in the bundle. Each entry is { title, slug, hex, path, ... }.
 * Add new platforms by importing the corresponding `si*` export above and
 * registering it in PLATFORM_ICONS below.
 */
const PLATFORM_ICONS: Record<string, typeof siKofi> = {
  'ko-fi': siKofi,
  'kofi': siKofi,
  'patreon': siPatreon,
  'github-sponsors': siGithubsponsors,
  'github': siGithub,
  'liberapay': siLiberapay,
  'open-collective': siOpencollective,
  'opencollective': siOpencollective,
  'paypal': siPaypal,
  'buymeacoffee': siBuymeacoffee,
  'buy-me-a-coffee': siBuymeacoffee,
  'stripe': siStripe,
  'cash-app': siCashapp,
  'cashapp': siCashapp,
  'venmo': siVenmo,
  'bitcoin': siBitcoin,
  'ethereum': siEthereum,
  // Bridges
  'discord': siDiscord,
  'slack': siSlack,
  'telegram': siTelegram,
  'matrix': siMatrix,
  'twitch': siTwitch,
}

const props = withDefaults(defineProps<{
  /** Platform key (e.g. "ko-fi", "patreon"). Case-insensitive. */
  platform?: string | null
  /** Pixel size — defaults to 1em-ish via inherited font size. */
  size?: number | string
  /** When true, uses the official brand color instead of currentColor. */
  useBrandColor?: boolean
}>(), {
  platform: null,
  size: 18,
  useBrandColor: false,
})

const iconData = computed(() => {
  const key = (props.platform ?? '').toLowerCase().replace(/\s+/g, '-')
  const icon = PLATFORM_ICONS[key]
  if (!icon) return null
  // simple-icons paths are designed for a 24x24 viewBox.
  return { ...icon, viewBox: '0 0 24 24' }
})
</script>

<style scoped>
svg {
  display: inline-block;
  vertical-align: middle;
  flex-shrink: 0;
}
</style>
