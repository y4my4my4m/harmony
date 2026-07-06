<template>
  <Teleport to="body">
    <div class="funding-overlay" @click.self="$emit('close')">
      <div class="funding-modal">
        <div class="modal-header">
          <h2>Instance Funding</h2>
          <button @click="$emit('close')" class="close-btn">
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div v-if="loading" class="loading-state">Loading...</div>

          <template v-else-if="config">
            <!-- Progress -->
            <div v-if="config.goal_amount" class="funding-progress-section">
              <div class="progress-header">
                <span class="progress-amount">
                  {{ formatCurrency(config.displayed_amount ?? config.current_amount, config.goal_currency) }}
                </span>
                <span class="progress-goal">
                  of {{ formatCurrency(config.goal_amount, config.goal_currency) }}
                </span>
              </div>
              <div class="progress-bar-track">
                <div class="progress-bar-fill" :style="{ width: progressPercent + '%' }"></div>
              </div>
              <div class="progress-percent">{{ progressPercent }}% funded</div>
            </div>

            <!-- Description -->
            <p v-if="config.goal_description" class="funding-description">{{ config.goal_description }}</p>

            <!-- Funding Links -->
            <div v-if="config.funding_links && config.funding_links.length > 0" class="funding-links">
              <h3>Support this instance</h3>

              <!-- Donor instruction callout.
                   Loud, opt-out by admin via thank_you_message later if needed.
                   Donors who skip this end up in the Pending Donations queue. -->
              <div class="donor-instructions">
                <Icon name="info" :size="16" class="donor-instructions-icon" />
                <div class="donor-instructions-body">
                  <p class="donor-instructions-title">Get your supporter badge automatically</p>
                  <p class="donor-instructions-text">
                    Include this handle <strong>anywhere</strong> in your donation message -
                    we'll match it automatically and assign the right tier based on your
                    cumulative donations this cycle:
                  </p>
                  <div class="donor-handle-row">
                    <code class="donor-handle-example">@{{ currentUserHandle || 'username' }}@{{ instanceDomain }}</code>
                    <button
                      v-if="currentUserHandle"
                      class="donor-copy-btn"
                      type="button"
                      @click="copyCurrentHandle"
                      :title="'Copy your handle'"
                    >
                      <Icon name="copy" :size="12" /> Copy mine
                    </button>
                  </div>

                  <details class="donor-examples">
                    <summary>Message examples</summary>
                    <ul class="donor-examples-list">
                      <li><code>@{{ currentUserHandle || 'alice' }}@{{ instanceDomain }}</code></li>
                      <li><code>thanks! @{{ currentUserHandle || 'alice' }}@{{ instanceDomain }}</code></li>
                      <li><code>@{{ currentUserHandle || 'alice' }}@{{ instanceDomain }} love the new features</code></li>
                      <li><code>cheers @{{ currentUserHandle || 'alice' }}@{{ instanceDomain }} keep it up</code></li>
                    </ul>
                  </details>

                  <p class="donor-instructions-hint">
                    Forget the handle? Your donation isn't lost - it'll be queued
                    for the admins to attribute manually.
                  </p>
                </div>
              </div>

              <div class="links-list">
                <a
                  v-for="(link, i) in config.funding_links"
                  :key="i"
                  :href="link.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="funding-link"
                  :class="`funding-link--${linkPlatformKey(link.platform)}`"
                >
                  <PlatformIcon
                    class="link-icon"
                    :platform="link.platform"
                    :size="22"
                    :use-brand-color="true"
                  />
                  <span class="link-text">
                    <span class="link-platform">{{ platformLabel(link.platform) }}</span>
                    <span v-if="link.label && link.label !== link.platform" class="link-label">{{ link.label }}</span>
                  </span>
                  <Icon name="external-link" :size="14" class="link-external" />
                </a>
              </div>
            </div>

            <!-- Supporter Tiers -->
            <div v-if="tiers.length > 0" class="tiers-section">
              <h3>Supporter Tiers</h3>
              <div class="tier-cards">
                <div v-for="tier in tiers" :key="tier.id" class="tier-card">
                  <div class="tier-badge-preview">
                    <span
                      class="badge-inline"
                      :style="tier.badge_color ? {
                        backgroundColor: tier.badge_color + '20',
                        borderColor: tier.badge_color,
                        color: tier.badge_color
                      } : {}"
                    ><SupporterBadgeIcon :icon="tier.badge_icon" /></span>
                  </div>
                  <div class="tier-details">
                    <span class="tier-name">{{ tier.name }}</span>
                    <span class="tier-min">From {{ formatCurrency(tier.min_amount, config.goal_currency) }}</span>
                  </div>
                  <span v-if="tier.perks" class="tier-perks">{{ tier.perks }}</span>
                </div>
              </div>
            </div>

            <!-- Current user supporter status -->
            <div v-if="myBadge" class="my-supporter-status">
              <h3>Your Support</h3>
              <div class="my-badge-row">
                <span class="my-badge-icon" :style="badgeStyle">
                  <SupporterBadgeIcon :icon="myBadge.badge_icon" />
                </span>
                <div class="my-badge-info">
                  <span class="my-badge-tier">{{ myBadge.tier_name }} Supporter</span>
                  <span class="my-badge-active">Active</span>
                </div>
              </div>
            </div>

            <!-- My donation history -->
            <div v-if="myDonations.length > 0" class="my-donations">
              <h3>Your Donations</h3>
              <div class="donations-list">
                <div v-for="donation in myDonations" :key="donation.id" class="donation-row">
                  <span class="donation-amount">{{ donation.currency }} {{ donation.amount }}</span>
                  <span class="donation-date">{{ formatDate(donation.donated_at) }}</span>
                  <span v-if="donation.note" class="donation-note">{{ donation.note }}</span>
                </div>
              </div>
            </div>

            <!-- Thank you -->
            <p v-if="config.thank_you_message && (myBadge || myDonations.length > 0)" class="thank-you-message">
              {{ config.thank_you_message }}
            </p>
          </template>

          <div v-else class="empty-state">
            <p>Funding information is not available.</p>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { fundingService, type FundingConfigWithProgress, type SupporterTier, type SupporterBadge, type DonationRecord } from '@/services/FundingService'
import SupporterBadgeIcon from '@/components/common/SupporterBadgeIcon.vue'
import PlatformIcon from '@/components/common/PlatformIcon.vue'
import Icon from '@/components/common/Icon.vue'
import { supabase } from '@/supabase'
import { useProfileStore } from '@/stores/useProfile'
import { getInstanceDomain } from '@/services/instanceConfig'

const profileStore = useProfileStore()

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
  'custom': 'Donate',
}

const linkPlatformKey = (platform: string): string => normalizeKey(platform)
const platformLabel = (platform: string): string =>
  PLATFORM_LABELS[normalizeKey(platform)] ?? platform

const instanceDomain = computed(() => getInstanceDomain())

const currentUserHandle = computed(() => profileStore.profile?.username ?? '')

const copyCurrentHandle = async () => {
  if (!currentUserHandle.value) return
  try {
    await navigator.clipboard.writeText(`@${currentUserHandle.value}@${instanceDomain.value}`)
  } catch {
    /* ignore - clipboard may be unavailable */
  }
}

defineEmits<{ close: [] }>()

const loading = ref(true)
const config = ref<FundingConfigWithProgress | null>(null)
const tiers = ref<SupporterTier[]>([])
const myBadge = ref<SupporterBadge | null>(null)
const myDonations = ref<DonationRecord[]>([])

const progressPercent = computed(() => {
  if (!config.value?.goal_amount) return 0
  const amount = config.value.displayed_amount ?? config.value.current_amount
  return Math.min(100, Math.round((amount / config.value.goal_amount) * 100))
})

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
  return symbol + amount.toFixed(amount % 1 === 0 ? 0 : 2)
}

const formatDate = (dateStr: string) => {
  return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

onMounted(async () => {
  try {
    const [fundingConfig, tierList] = await Promise.all([
      fundingService.getFundingWithProgress(),
      fundingService.getTiers(),
    ])
    config.value = fundingConfig
    tiers.value = tierList

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
</script>

<style scoped>
.funding-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}

.funding-modal {
  background: var(--background-primary, #1e1f22);
  border: 1px solid var(--border-color, #2b2d31);
  border-radius: 12px;
  width: 90vw;
  max-width: 460px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}

.close-btn:hover {
  background: var(--background-hover);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.loading-state, .empty-state {
  text-align: center;
  color: var(--text-secondary);
  padding: 40px 0;
}

/* Progress */
.funding-progress-section {
  text-align: center;
}

.progress-header {
  margin-bottom: 10px;
}

.progress-amount {
  font-size: 28px;
  font-weight: 800;
  color: var(--text-primary);
}

.progress-goal {
  font-size: 16px;
  color: var(--text-secondary);
  margin-left: 4px;
}

.progress-bar-track {
  width: 100%;
  height: 10px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 5px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: var(--harmony-primary, #0EA5E9);
  border-radius: 5px;
  transition: width 0.4s ease;
}

.progress-percent {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

/* Description */
.funding-description {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
}

/* Links */
.funding-links h3,
.tiers-section h3,
.my-supporter-status h3,
.my-donations h3 {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.links-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.funding-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--background-secondary, #2b2d31);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  text-decoration: none;
  transition: border-color 0.15s, transform 0.15s, background 0.15s;
}

.funding-link:hover {
  border-color: var(--harmony-primary, #0EA5E9);
  background: var(--background-modifier-hover, var(--background-secondary));
  transform: translateY(-1px);
}

.link-icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

.link-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.link-platform {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.link-label {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-external {
  color: var(--text-tertiary, var(--text-secondary));
  opacity: 0.6;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.funding-link:hover .link-external {
  opacity: 1;
}

/* Donor instruction callout */
.donor-instructions {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: rgba(14, 165, 233, 0.08);
  border: 1px solid rgba(14, 165, 233, 0.25);
  border-radius: 8px;
}

.donor-instructions-icon {
  color: var(--harmony-primary, #0EA5E9);
  flex-shrink: 0;
  margin-top: 2px;
}

.donor-instructions-body {
  flex: 1;
  min-width: 0;
}

.donor-instructions-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.donor-instructions-text {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.donor-handle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 4px 0 8px;
}

.donor-handle-example {
  display: inline-block;
  padding: 6px 10px;
  background: var(--background-primary, #1e1f22);
  border: 1px dashed var(--harmony-primary, #0EA5E9);
  border-radius: 6px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--harmony-primary, #0EA5E9);
  user-select: all;
  word-break: break-all;
}

.donor-examples {
  margin: 4px 0 8px;
  font-size: 12px;
}

.donor-examples summary {
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px 0;
  user-select: none;
  transition: color 0.15s;
  font-weight: 500;
}

.donor-examples summary:hover {
  color: var(--text-primary);
}

.donor-examples-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.donor-examples-list li {
  padding: 6px 10px;
  background: var(--background-primary, #1e1f22);
  border: 1px solid var(--border-color);
  border-radius: 4px;
}

.donor-examples-list code {
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-all;
}

.donor-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.donor-copy-btn:hover {
  border-color: var(--harmony-primary, #0EA5E9);
  color: var(--harmony-primary, #0EA5E9);
}

.donor-instructions-hint {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-tertiary, var(--text-secondary));
  line-height: 1.4;
  font-style: italic;
}

/* Tiers */
.tier-cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tier-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--background-secondary, #2b2d31);
  border-radius: 8px;
}

.tier-badge-preview {
  flex-shrink: 0;
  width: 80px;
  display: flex;
  align-items: center;
  justify-content: start;
}

.badge-inline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 14px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  line-height: 1;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary);
}

.tier-details {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.tier-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.tier-min {
  font-size: 12px;
  color: var(--text-secondary);
}

.tier-perks {
  font-size: 11px;
  color: var(--text-secondary);
  font-style: italic;
  margin-left: auto;
  flex-shrink: 0;
}

/* My status */
.my-badge-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--background-secondary);
  border-radius: 8px;
}

.my-badge-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 120px;
  height: 36px;
  border-radius: 8px;
  font-size: 20px;
  border: 1px solid;
}

.my-badge-info {
  display: flex;
  flex-direction: column;
}

.my-badge-tier {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.my-badge-active {
  font-size: 12px;
  color: #57f287;
}

/* My donations */
.donations-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.donation-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--background-secondary);
  border-radius: 6px;
  font-size: 13px;
}

.donation-amount {
  font-weight: 600;
  color: var(--text-primary);
}

.donation-date {
  color: var(--text-secondary);
}

.donation-note {
  color: var(--text-secondary);
  font-style: italic;
  flex: 1;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Thank you */
.thank-you-message {
  margin: 0;
  padding: 14px;
  background: rgba(87, 242, 135, 0.08);
  border: 1px solid rgba(87, 242, 135, 0.2);
  border-radius: 8px;
  color: #57f287;
  font-size: 14px;
  text-align: center;
  line-height: 1.5;
}
</style>
