<template>
  <Teleport to="body">
    <div class="funding-overlay" @click.self="close">
      <div
        ref="dialogRef"
        class="funding-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="funding-modal-title"
        tabindex="-1"
      >
        <div class="modal-header">
          <div class="header-titles">
            <h2 id="funding-modal-title">Instance funding</h2>
            <p class="header-subtitle">{{ instanceDomain }}</p>
          </div>
          <button type="button" class="close-btn" aria-label="Close" @click="close">
            <Icon name="x" :size="20" />
          </button>
        </div>

        <div class="modal-body">
          <div v-if="loading" class="loading-state">
            <LoadingSpinner />
          </div>

          <template v-else-if="config">
            <section v-if="config.goal_amount" class="progress-card" aria-label="Funding progress">
              <div class="progress-figures">
                <span class="progress-raised">{{ formatCurrency(raisedAmount, config.goal_currency) }}</span>
                <span class="progress-goal">
                  raised of {{ formatCurrency(config.goal_amount, config.goal_currency) }} {{ periodLabel }}
                </span>
              </div>
              <div
                class="progress-bar-track"
                role="progressbar"
                :aria-valuenow="progressPercent"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div class="progress-bar-fill" :style="{ width: progressPercent + '%' }"></div>
              </div>
              <div class="progress-stats">
                <span><strong>{{ progressPercent }}%</strong> funded</span>
                <span v-if="supporterCount > 0">
                  <strong>{{ supporterCount }}</strong> {{ supporterCount === 1 ? 'supporter' : 'supporters' }}
                </span>
              </div>
            </section>

            <p v-if="config.goal_description" class="funding-description">{{ config.goal_description }}</p>

            <section v-if="config.funding_links && config.funding_links.length > 0" class="funding-links">
              <h3>Donate</h3>
              <div class="links-list">
                <a
                  v-for="(link, i) in config.funding_links"
                  :key="i"
                  :href="safeHref(donationLinkHref(link, donor))"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="funding-link"
                  :class="[`funding-link--${linkPlatformKey(link.platform)}`, { 'funding-link--primary': i === 0 }]"
                >
                  <span class="link-icon-wrap">
                    <PlatformIcon
                      class="link-icon"
                      :platform="link.platform"
                      :size="20"
                      :use-brand-color="i !== 0"
                    />
                  </span>
                  <span class="link-text">
                    <span class="link-platform">
                      {{ i === 0 ? primaryLinkText(link.platform) : platformLabel(link.platform) }}
                    </span>
                    <span v-if="link.label && link.label !== link.platform" class="link-label">{{ link.label }}</span>
                  </span>
                  <Icon name="external-link" :size="14" class="link-external" />
                </a>
              </div>

              <p v-if="config.funding_links.some(isStripeLink)" class="donor-auto-credit">
                <Icon name="check" :size="14" />
                <span>Stripe donations are credited to your account automatically.</span>
              </p>

              <details v-if="needsHandleInMessage(config.funding_links)" class="donor-instructions">
                <summary>
                  <Icon name="info" :size="14" class="donor-instructions-icon" />
                  <span class="donor-summary-label">Get your supporter badge automatically</span>
                  <Icon name="chevron-down" :size="14" class="donor-instructions-chevron" />
                </summary>
                <div class="donor-instructions-body">
                  <p class="donor-instructions-text">
                    Include your handle anywhere in the donation message. The tier follows your
                    total donations this cycle.
                  </p>
                  <div class="donor-handle-row">
                    <code class="donor-handle">@{{ currentUserHandle || 'username' }}@{{ instanceDomain }}</code>
                    <button
                      v-if="currentUserHandle"
                      class="donor-copy-btn"
                      type="button"
                      @click="copyCurrentHandle"
                    >
                      <Icon :name="handleCopied ? 'check' : 'copy'" :size="12" />
                      {{ handleCopied ? 'Copied' : 'Copy' }}
                    </button>
                  </div>
                  <p class="donor-instructions-hint">
                    Donations without a handle are queued for the admins to attribute by hand.
                  </p>
                </div>
              </details>
            </section>

            <section v-if="tiers.length > 0" class="tiers-section">
              <h3>Supporter tiers</h3>
              <ul class="tier-list">
                <li
                  v-for="tier in tiers"
                  :key="tier.id"
                  class="tier-card"
                  :class="{ 'tier-card--current': myBadge?.tier_name === tier.name }"
                >
                  <span
                    class="tier-badge"
                    :style="tier.badge_color ? {
                      backgroundColor: tier.badge_color + '20',
                      borderColor: tier.badge_color,
                      color: tier.badge_color
                    } : {}"
                  ><SupporterBadgeIcon :icon="tier.badge_icon" /></span>
                  <span class="tier-details">
                    <span class="tier-heading">
                      <span class="tier-name">{{ tier.name }}</span>
                      <span class="tier-min">from {{ formatCurrency(tier.min_amount, config.goal_currency) }}</span>
                    </span>
                    <span v-if="tier.perks" class="tier-perks">{{ tier.perks }}</span>
                  </span>
                </li>
              </ul>
            </section>

            <section v-if="myBadge" class="my-supporter-status">
              <h3>Your support</h3>
              <div class="my-badge-row">
                <span class="tier-badge" :style="badgeStyle">
                  <SupporterBadgeIcon :icon="myBadge.badge_icon" />
                </span>
                <div class="my-badge-info">
                  <span class="my-badge-tier">{{ myBadge.tier_name }} supporter</span>
                  <span class="my-badge-active">Active</span>
                </div>
              </div>
            </section>

            <section v-if="myDonations.length > 0" class="my-donations">
              <h3>Your donations</h3>
              <div class="donations-list">
                <div v-for="donation in myDonations" :key="donation.id" class="donation-row">
                  <span class="donation-amount">{{ donation.currency }} {{ donation.amount }}</span>
                  <span class="donation-date">{{ formatDate(donation.donated_at) }}</span>
                  <span v-if="donation.note" class="donation-note">{{ donation.note }}</span>
                </div>
              </div>
            </section>

            <p v-if="config.thank_you_message && (myBadge || myDonations.length > 0)" class="thank-you-message">
              {{ config.thank_you_message }}
            </p>
          </template>

          <EmptyState v-else icon="heart" :title="$t('empty.funding.title')" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { safeHref } from '@/utils/sanitize';
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  fundingService,
  donationLinkHref,
  isStripeLink,
  needsHandleInMessage,
  type FundingConfigWithProgress,
  type SupporterTier,
  type SupporterBadge,
  type DonationRecord,
} from '@/services/FundingService'
import SupporterBadgeIcon from '@/components/common/SupporterBadgeIcon.vue'
import PlatformIcon from '@/components/common/PlatformIcon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { supabase } from '@/supabase'
import { useProfileStore } from '@/stores/useProfile'
import { useAuthStore } from '@/stores/auth'
import { getInstanceDomain } from '@/services/instanceConfig'

const profileStore = useProfileStore()
const authStore = useAuthStore()

const donor = computed(() => ({
  profileId: profileStore.profile?.id ?? null,
  email: authStore.session?.user?.email ?? null,
}))

// Display name → key normalization: "Ko-fi" → "ko-fi", "GitHub Sponsors" → "github-sponsors"
const normalizeKey = (platform: string): string =>
  (platform ?? '').toLowerCase().replace(/\s+/g, '-')

const PLATFORM_LABELS: Record<string, string> = {
  'ko-fi': 'Ko-fi',
  'patreon': 'Patreon',
  'github-sponsors': 'GitHub Sponsors',
  'liberapay': 'Liberapay',
  'open-collective': 'Open Collective',
  'paypal': 'PayPal',
  'buymeacoffee': 'Buy Me a Coffee',
  'stripe': 'Stripe',
  'custom': 'Donate',
}

const linkPlatformKey = (platform: string): string => normalizeKey(platform)
const platformLabel = (platform: string): string =>
  PLATFORM_LABELS[normalizeKey(platform)] ?? platform
const primaryLinkText = (platform: string): string =>
  normalizeKey(platform) === 'stripe' ? 'Donate with Stripe' : `Support on ${platformLabel(platform)}`

const instanceDomain = computed(() => getInstanceDomain())

const currentUserHandle = computed(() => profileStore.profile?.username ?? '')

const handleCopied = ref(false)
let handleCopiedTimer: ReturnType<typeof setTimeout> | null = null

const copyCurrentHandle = async () => {
  if (!currentUserHandle.value) return
  try {
    await navigator.clipboard.writeText(`@${currentUserHandle.value}@${instanceDomain.value}`)
    handleCopied.value = true
    if (handleCopiedTimer) clearTimeout(handleCopiedTimer)
    handleCopiedTimer = setTimeout(() => { handleCopied.value = false }, 2000)
  } catch {
    /* clipboard unavailable */
  }
}

const emit = defineEmits<{ close: [] }>()
const close = () => emit('close')

const dialogRef = ref<HTMLElement | null>(null)
const loading = ref(true)
const config = ref<FundingConfigWithProgress | null>(null)
const tiers = ref<SupporterTier[]>([])
const myBadge = ref<SupporterBadge | null>(null)
const myDonations = ref<DonationRecord[]>([])
const supporterCount = ref(0)

const raisedAmount = computed(() => config.value?.displayed_amount ?? config.value?.current_amount ?? 0)

const progressPercent = computed(() => {
  if (!config.value?.goal_amount) return 0
  return Math.min(100, Math.round((raisedAmount.value / config.value.goal_amount) * 100))
})

const periodLabel = computed(() => (config.value?.funding_period === 'all' ? 'in total' : 'this month'))

const badgeStyle = computed(() => {
  if (!myBadge.value?.badge_color) return {}
  return {
    backgroundColor: `${myBadge.value.badge_color}20`,
    borderColor: myBadge.value.badge_color,
    color: myBadge.value.badge_color,
  }
})

const formatCurrency = (amount: number, currency: string) => {
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' }
  const symbol = symbols[currency] || currency + ' '
  const value = Number(amount) || 0
  return symbol + value.toFixed(value % 1 === 0 ? 0 : 2)
}

const formatDate = (dateStr: string) => {
  return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
  }
}

onMounted(async () => {
  document.addEventListener('keydown', onKeydown)
  await nextTick()
  dialogRef.value?.focus()

  try {
    const [fundingConfig, tierList, count] = await Promise.all([
      fundingService.getFundingWithProgress(),
      fundingService.getTiers(),
      fundingService.getActiveSupporterCount(),
    ])
    config.value = fundingConfig
    tiers.value = tierList
    supporterCount.value = count

    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const [badge, donations] = await Promise.all([
        fundingService.getSupporterBadge(user.id),
        fundingService.getDonationHistory(user.id),
      ])
      myBadge.value = badge
      myDonations.value = donations
    }
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (handleCopiedTimer) clearTimeout(handleCopiedTimer)
})
</script>

<style scoped>
.funding-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
}

.funding-modal {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 480px;
  max-height: min(85vh, 760px);
  overflow: hidden;
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  outline: none;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-6) var(--space-4);
  border-bottom: 1px solid var(--border-color);
}

.header-titles {
  min-width: 0;
}

.modal-header h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
}

.header-subtitle {
  margin: 2px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  margin: -6px -8px 0 0;
  background: none;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
}

.close-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.modal-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-5) var(--space-6) var(--space-6);
  overflow-y: auto;
}

.loading-state,
.modal-body h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

/* Progress */
.progress-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.progress-figures {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.progress-raised {
  font-size: var(--font-size-3xl);
  font-weight: var(--font-weight-bold);
  line-height: 1;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.progress-goal {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.progress-bar-track {
  width: 100%;
  height: 8px;
  overflow: hidden;
  background: var(--background-modifier-active);
  border-radius: var(--radius-full);
}

.progress-bar-fill {
  height: 100%;
  min-width: 4px;
  background: var(--harmony-primary);
  border-radius: var(--radius-full);
  transition: width 0.4s ease;
}

.progress-stats {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.progress-stats strong {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.funding-description {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

/* Links */
.links-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.funding-link {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 48px;
  padding: var(--space-2) var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  text-decoration: none;
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
}

.funding-link:hover {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
}

.funding-link--primary {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.funding-link--primary:hover {
  background: var(--harmony-primary-hover);
  border-color: var(--harmony-primary-hover);
}

.link-icon-wrap {
  display: inline-flex;
  flex-shrink: 0;
}

.link-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.link-platform {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.link-label {
  overflow: hidden;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funding-link--primary .link-label {
  color: inherit;
  opacity: 0.85;
}

.link-external {
  flex-shrink: 0;
  opacity: 0.6;
}

.funding-link:hover .link-external {
  opacity: 1;
}

/* Badge matching */
.donor-auto-credit {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: 0.8125rem;
  color: var(--text-secondary);
}

.donor-auto-credit .icon-wrap {
  flex-shrink: 0;
  color: var(--color-success);
}

.donor-instructions {
  margin-top: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.donor-instructions summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  list-style: none;
  cursor: pointer;
}

.donor-instructions summary::-webkit-details-marker {
  display: none;
}

.donor-summary-label {
  flex: 1;
  min-width: 0;
}

.donor-instructions-icon {
  flex-shrink: 0;
  color: var(--harmony-primary);
}

.donor-instructions-chevron {
  flex-shrink: 0;
  color: var(--text-secondary);
  transition: transform var(--transition-fast);
}

.donor-instructions[open] .donor-instructions-chevron {
  transform: rotate(180deg);
}

.donor-instructions-body {
  padding: 0 var(--space-4) var(--space-4);
}

.donor-instructions-text,
.donor-instructions-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.donor-handle-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-3) 0;
}

.donor-handle {
  padding: var(--space-1) var(--space-2);
  background: var(--surface-inset);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-primary);
  user-select: all;
  word-break: break-all;
}

.donor-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 28px;
  padding: 0 var(--space-2);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  cursor: pointer;
}

.donor-copy-btn:hover {
  border-color: var(--harmony-primary);
  color: var(--harmony-primary);
}

/* Tiers */
.tier-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.tier-card {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--background-secondary);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
}

.tier-card--current {
  border-color: var(--harmony-primary);
}

.tier-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  min-width: 36px;
  height: 28px;
  padding: 0 var(--space-2);
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-hover);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  line-height: 1;
  color: var(--text-secondary);
}

.tier-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.tier-heading {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  column-gap: var(--space-2);
}

.tier-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.tier-min {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.tier-perks {
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

/* My status */
.my-badge-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--background-secondary);
  border-radius: var(--radius-md);
}

.my-badge-info {
  display: flex;
  flex-direction: column;
}

.my-badge-tier {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.my-badge-active {
  font-size: var(--font-size-xs);
  color: var(--success);
}

/* My donations */
.donations-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.donation-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--background-secondary);
  border-radius: var(--radius-base);
  font-size: 13px;
}

.donation-amount {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.donation-date {
  color: var(--text-secondary);
}

.donation-note {
  flex: 1;
  overflow: hidden;
  font-style: italic;
  color: var(--text-secondary);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thank-you-message {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  background: color-mix(in srgb, var(--success) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--success) 25%, transparent);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--success);
  text-align: center;
}

/* Bottom sheet on phones. */
@media (max-width: 600px) {
  .funding-overlay {
    align-items: flex-end;
    padding: 0;
  }

  .funding-modal {
    max-width: none;
    max-height: 92vh;
    border-bottom: none;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  }

  .modal-header {
    padding: var(--space-4) var(--space-4) var(--space-3);
  }

  .modal-body {
    padding: var(--space-4) var(--space-4) calc(var(--space-6) + env(safe-area-inset-bottom, 0px));
  }
}
</style>
