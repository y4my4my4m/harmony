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
                  <span class="link-icon" v-html="platformIcon(link.platform)"></span>
                  <span class="link-text">
                    <span class="link-platform">{{ platformLabel(link.platform) }}</span>
                    <span v-if="link.label && link.label !== link.platform" class="link-label">{{ link.label }}</span>
                  </span>
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
import { supabase } from '@/supabase'

// Canonical platform → display label + branded SVG icon. Falls back to a
// generic heart for unknown platforms.
const PLATFORM_META: Record<string, { label: string; icon: string }> = {
  'ko-fi': {
    label: 'Ko-fi',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20.5 3H4.5C3.67 3 3 3.67 3 4.5v8c0 4.42 3.58 8 8 8h2c4.42 0 8-3.58 8-8v-8c0-.83-.67-1.5-1.5-1.5zm-5.5 9.5c0 .55-.45 1-1 1H8c-.55 0-1-.45-1-1v-5c0-.55.45-1 1-1h6c.55 0 1 .45 1 1v5z"/></svg>',
  },
  'patreon': {
    label: 'Patreon',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M15.385 1.604c-3.957 0-7.176 3.219-7.176 7.176 0 3.945 3.219 7.156 7.176 7.156 3.945 0 7.156-3.211 7.156-7.156 0-3.957-3.211-7.176-7.156-7.176M1.459 22.396V1.604h3.51v20.792"/></svg>',
  },
  'github-sponsors': {
    label: 'GitHub Sponsors',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  },
  'liberapay': {
    label: 'Liberapay',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M5.07 21.66c-.43 0-.78-.04-1.05-.13-.26-.08-.46-.21-.6-.4-.13-.18-.22-.4-.27-.65-.04-.25-.06-.55-.06-.88V3.86h2.78v15.5c0 .35.07.6.21.74.14.14.32.21.55.21h.43V21.66H5.07zm9.7-7.36c0-.6-.09-1.1-.26-1.5-.18-.4-.42-.7-.73-.93-.31-.22-.68-.38-1.1-.46-.42-.08-.87-.12-1.36-.12H10.9v6.3h.48c.5 0 .96-.04 1.38-.12.42-.08.79-.23 1.1-.46.31-.23.55-.55.73-.96.18-.41.27-.93.27-1.55v-.2z"/></svg>',
  },
  'open-collective': {
    label: 'Open Collective',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M12 6a6 6 0 0 0 0 12" fill="none" stroke="currentColor" stroke-width="2.5"/></svg>',
  },
  'paypal': {
    label: 'PayPal',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 1.49A.78.78 0 0 1 5.715.835h6.66c2.16 0 3.853.469 4.825 1.39.972.921 1.197 2.235.835 3.881-.027.124-.058.246-.094.367-.36 1.221-.998 2.184-1.91 2.886-1.092.835-2.555 1.282-4.353 1.282H9.847a.806.806 0 0 0-.796.681l-.61 3.873-.43 2.726a.483.483 0 0 1-.478.41z"/></svg>',
  },
  'buymeacoffee': {
    label: 'Buy Me a Coffee',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20.216 6.415l-.132-.666c-.119-.598-.388-1.163-1.001-1.379-.197-.069-.42-.098-.57-.241-.152-.143-.196-.366-.231-.572-.065-.378-.125-.756-.192-1.133-.057-.325-.102-.69-.25-.987-.195-.4-.597-.634-.996-.788a5.723 5.723 0 0 0-.626-.194c-1-.263-2.05-.36-3.077-.416a25.834 25.834 0 0 0-3.7.062c-.915.083-1.88.184-2.75.5-.318.116-.646.256-.888.501-.297.302-.393.77-.177 1.146.154.267.415.456.692.58.36.162.737.284 1.123.366 1.075.238 2.189.331 3.287.37 1.218.05 2.437.01 3.65-.118.299-.033.598-.073.896-.119.352-.054.578-.513.474-.834-.124-.383-.457-.531-.834-.473-.466.074-.96.108-1.382.146-1.177.08-2.358.082-3.536.006a22.228 22.228 0 0 1-1.157-.107c-.086-.01-.18-.025-.258-.036.029-.077.122-.092.21-.106.34-.045.682-.077 1.024-.103a25.422 25.422 0 0 1 3.327-.046c.484.03.967.07 1.448.124l.124.015c.7.094 1.398.21 2.084.36.448.098.78.36 1.075.788.27.397.41.857.493 1.32.083.466.124.946.171 1.418.05.486.099.971.149 1.457.07.684.149 1.367.224 2.05.062.57.117 1.141.146 1.713.044.83.085 1.662.085 2.494 0 .832-.041 1.664-.085 2.495-.029.572-.084 1.144-.146 1.713-.075.683-.155 1.366-.224 2.05-.05.486-.099.971-.149 1.457-.047.472-.088.952-.171 1.418-.083.463-.223.923-.493 1.32-.295.428-.627.69-1.075.788z"/></svg>',
  },
  'custom': {
    label: 'Donate',
    icon: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  },
}

const GENERIC_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>'

const linkPlatformKey = (platform: string): string =>
  platform?.toLowerCase().replace(/\s+/g, '-') in PLATFORM_META
    ? platform.toLowerCase().replace(/\s+/g, '-')
    : 'custom'

const platformLabel = (platform: string): string => {
  const key = platform?.toLowerCase().replace(/\s+/g, '-')
  return PLATFORM_META[key]?.label ?? platform
}

const platformIcon = (platform: string): string => {
  const key = platform?.toLowerCase().replace(/\s+/g, '-')
  return PLATFORM_META[key]?.icon ?? GENERIC_ICON
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
  padding: 10px 14px;
  background: var(--background-secondary, #2b2d31);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  text-decoration: none;
  transition: border-color 0.15s, transform 0.15s;
}

.funding-link:hover {
  border-color: var(--harmony-primary, #0EA5E9);
  transform: translateY(-1px);
}

/* Brand colors per platform - matches each platform's identity. */
.funding-link--ko-fi { color: #ff5e5b; }
.funding-link--patreon { color: #ff424d; }
.funding-link--github-sponsors { color: #ea4aaa; }
.funding-link--liberapay { color: #f6c915; }
.funding-link--open-collective { color: #297eff; }
.funding-link--paypal { color: #0070ba; }
.funding-link--buymeacoffee { color: #ffdd00; }

.link-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}

.link-icon :deep(svg) {
  width: 18px;
  height: 18px;
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
