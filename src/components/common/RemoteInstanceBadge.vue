<template>
  <div
    class="remote-instance-badge"
    :class="[`remote-instance-badge--${variant}`, { compact }]"
    :style="badgeStyle"
    :title="`From ${domain}`"
  >
    <span class="rib-icon" aria-hidden="true">
      <InstanceIcon :src="resolvedIconUrl" :size="iconSize" />
    </span>
    <span class="rib-label">{{ displayLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { activityPubService } from '@/services/activityPubService'
import InstanceIcon from './InstanceIcon.vue'

const SOFTWARE_COLORS: Record<string, string> = {
  mastodon: '#6364FF',
  misskey: '#86b300',
  pleroma: '#2589C6',
  akkoma: '#2589C6',
  gotosocial: '#007ACC',
  pixelfed: '#008080',
  lemmy: '#007EED',
  peertube: '#F1680B',
  funkwhale: '#229954',
  harmony: '#0EA5E9',
  flipboard: '#E12828',
}

function resolveInstanceColor(themeColor: string | null, software?: string | null): string {
  if (themeColor) {
    const trimmed = themeColor.trim()
    if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed
    if (/^[0-9a-fA-F]{3,8}$/.test(trimmed)) return `#${trimmed}`
  }
  const key = (software ?? '').toLowerCase().replace(/[^a-z]/g, '')
  for (const [platform, color] of Object.entries(SOFTWARE_COLORS)) {
    if (key.includes(platform)) return color
  }
  return '#64748b'
}

const props = withDefaults(
  defineProps<{
    domain: string
    software?: string
    variant?: 'corner' | 'inline' | 'strip'
    compact?: boolean
    preferName?: boolean
  }>(),
  {
    variant: 'corner',
    compact: false,
    preferName: false,
  },
)

const instance = ref<any | null>(null)

watch(
  () => props.domain,
  async (domain) => {
    instance.value = domain
      ? await activityPubService.getFederatedInstanceByDomain(domain)
      : null
  },
  { immediate: true },
)

const resolvedSoftware = computed(() => instance.value?.software || props.software)
const resolvedIconUrl = computed(() => {
  const url = instance.value?.metadata?.icon_url
  return typeof url === 'string' && url.length > 0 ? url : null
})
const instanceColor = computed(() => {
  const meta = instance.value?.metadata as Record<string, unknown> | undefined
  const themeColor = typeof meta?.theme_color === 'string' ? meta.theme_color : null
  return resolveInstanceColor(themeColor, resolvedSoftware.value)
})

const iconSize = computed(() => {
  if (props.variant === 'strip') return 14
  if (props.compact || props.variant === 'inline') return 12
  return 14
})

const displayLabel = computed(() => {
  const meta = instance.value?.metadata as Record<string, unknown> | undefined
  const instanceName =
    (typeof meta?.instance_name === 'string' && meta.instance_name) ||
    (typeof instance.value?.description === 'string' && instance.value.description) ||
    null
  if ((props.preferName || props.variant === 'inline') && instanceName) {
    return instanceName
  }
  return props.domain
})

const badgeStyle = computed(() => ({
  '--rib-color': instanceColor.value,
}))
</script>

<style scoped>
.remote-instance-badge {
  --rib-color: #64748b;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: color-mix(in srgb, var(--rib-color) 55%, var(--text-primary));
}

.rib-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
}

.rib-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remote-instance-badge--corner {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 1;
  max-width: min(55%, 160px);
  padding: 3px 7px;
  border-radius: 6px;
  font-size: 0.6875rem;
  font-weight: 500;
  border: 1px solid color-mix(in srgb, var(--rib-color) 35%, transparent);
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--rib-color) 18%, var(--background-secondary)) 0%,
    color-mix(in srgb, var(--rib-color) 8%, var(--background-primary)) 100%
  );
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

.remote-instance-badge--corner.compact {
  top: 6px;
  right: 6px;
  max-width: min(60%, 140px);
  padding: 2px 6px;
  font-size: 0.625rem;
  gap: 4px;
}

.remote-instance-badge--corner .rib-icon {
  width: 14px;
  height: 14px;
}

.remote-instance-badge--corner.compact .rib-icon {
  width: 12px;
  height: 12px;
}

.remote-instance-badge--inline {
  width: fit-content;
  max-width: 100%;
  margin: 6px auto 0;
  padding: 2px 8px 2px 5px;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 500;
  border: 1px solid color-mix(in srgb, var(--rib-color) 28%, transparent);
  background: color-mix(in srgb, var(--rib-color) 12%, var(--background-tertiary));
  gap: 4px;
}

.remote-instance-badge--inline .rib-icon {
  width: 12px;
  height: 12px;
}

.remote-instance-badge--strip {
  width: fit-content;
  max-width: 100%;
  padding: 2px 8px 2px 4px;
  border-radius: 4px;
  font-size: 0.6875rem;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--rib-color) 92%, black) 0%,
    color-mix(in srgb, var(--rib-color) 70%, transparent) 65%,
    transparent 100%
  );
}

.remote-instance-badge--strip .rib-icon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  overflow: hidden;
  background: color-mix(in srgb, var(--rib-color) 80%, black);
}
</style>
