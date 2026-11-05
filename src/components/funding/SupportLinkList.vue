<!--
  SupportLinkList - the payment links, Stripe first, the first one filled. With `donor`, a
  Stripe Payment Link carries the donor's profile id (client_reference_id) so the webhook
  credits them; without, links open as they are (the Harmony project's pages from a
  self-hosted instance, which cannot credit an account of another instance).
-->
<template>
  <ul class="support-links" :data-testid="testid">
    <li v-for="(link, i) in ordered" :key="`${i}-${link.url}`">
      <a
        :href="safeHref(href(link))"
        target="_blank"
        rel="noopener noreferrer"
        class="support-link"
        :class="{ 'support-link--primary': i === 0 }"
        :data-platform="platformKey(link.platform)"
        @click="emit('open', link)"
      >
        <span class="support-link__icon">
          <PlatformIcon :platform="link.platform" :size="20" :use-brand-color="i !== 0" />
        </span>
        <span class="support-link__text">
          <span class="support-link__title">{{ title(link, i === 0) }}</span>
          <span v-if="subtitle(link, i)" class="support-link__subtitle">{{ subtitle(link, i) }}</span>
        </span>
        <Icon name="external-link" :size="14" class="support-link__external" aria-hidden="true" />
      </a>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import PlatformIcon from '@/components/common/PlatformIcon.vue'
import { useT } from '@/composables/useT'
import { safeHref } from '@/utils/sanitize'
import { fundingPlatformKey, fundingPlatformLabel } from './format'
import {
  donationLinkHref,
  isStripeLink,
  orderDonationLinks,
  type FundingLink,
} from '@/services/FundingService'

const props = withDefaults(defineProps<{
  links: FundingLink[]
  /** The donor a Stripe link credits; none for links of another instance. */
  donor?: { profileId?: string | null; email?: string | null } | null
  testid?: string
}>(), {
  donor: null,
  testid: 'support-links',
})

const emit = defineEmits<{ open: [link: FundingLink] }>()

const { t } = useT()

const ordered = computed(() => orderDonationLinks(props.links))

const platformKey = fundingPlatformKey
const platformLabel = (platform: string): string =>
  platformKey(platform) === 'custom' ? t('support.heading') : fundingPlatformLabel(platform)

const href = (link: FundingLink) => (props.donor ? donationLinkHref(link, props.donor) : link.url)

// A Stripe link reads as its admin label ("One-time", "Monthly"); others name their platform.
const ownLabel = (link: FundingLink): string | null => {
  const label = link.label?.trim()
  if (!label) return null
  const key = platformKey(label)
  return key === platformKey(link.platform) || key === platformKey(platformLabel(link.platform)) ? null : label
}

const title = (link: FundingLink, primary: boolean): string => {
  if (isStripeLink(link)) return ownLabel(link) ?? t('support.oneTime')
  if (platformKey(link.platform) === 'custom') return ownLabel(link) ?? t('support.heading')
  return primary ? t('support.onPlatform', { platform: platformLabel(link.platform) }) : platformLabel(link.platform)
}

// The credit note is stated once, under the first Stripe link.
const subtitle = (link: FundingLink, index: number): string | null => {
  if (!isStripeLink(link)) return platformKey(link.platform) === 'custom' ? null : ownLabel(link)
  return index === 0 && props.donor ? t('support.credited') : null
}
</script>

<style scoped>
.support-links {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.support-link {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-2) var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  text-decoration: none;
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
}

.support-link:hover {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
}

.support-link:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.support-link--primary {
  background: var(--harmony-primary-fill);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.support-link--primary:hover {
  background: var(--harmony-primary-fill-hover);
  border-color: var(--harmony-primary-hover);
}

.support-link__icon {
  display: inline-flex;
  flex-shrink: 0;
}

.support-link__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.support-link__title {
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.support-link__subtitle {
  overflow: hidden;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.support-link--primary .support-link__subtitle {
  color: inherit;
}

.support-link__external {
  flex-shrink: 0;
  opacity: 0.6;
}

.support-link:hover .support-link__external {
  opacity: 1;
}
</style>
