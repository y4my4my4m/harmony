<!--
  FundingModal - the Support window. Two tabs on every instance: "This instance" (the admin's
  own funding: progress, payment links, an optional message, the donor's status, supporter
  messages, tiers) and "Harmony development" (services/developmentFund.ts: the project's Stripe
  Payment Links and its supporters page; no progress, no messages, no request). Wide two-column
  layout on desktop; a full-height sheet on phones. Opening it reads the funding summary once.
-->
<template>
  <BaseModal
    :show="true"
    :title="title"
    :subtitle="instanceDomain"
    icon="heart"
    overlay-class="support-modal-overlay"
    initial-focus="dialog"
    @close="close"
  >
    <div class="support" data-testid="support-modal">
      <div
        class="support-tabs"
        role="tablist"
        :aria-label="t('support.tabs.label')"
        @keydown="onTabKey"
      >
        <button
          v-for="name in TABS"
          :id="tabId(name)"
          :key="name"
          :ref="(el) => { tabEls[name] = el as HTMLElement | null }"
          type="button"
          role="tab"
          class="support-tab"
          :aria-selected="tab === name"
          :aria-controls="panelId(name)"
          :tabindex="tab === name ? 0 : -1"
          :data-testid="`support-tab-${name}`"
          @click="tab = name"
        >
          <Icon :name="name === 'instance' ? 'server' : 'heart'" :size="16" class="support-tab__icon" aria-hidden="true" />
          <span class="support-tab__label">{{ t(name === 'instance' ? 'support.tabs.instance' : 'support.tabs.project') }}</span>
        </button>
      </div>

      <!-- This instance -->
      <section
        v-show="tab === 'instance'"
        :id="panelId('instance')"
        role="tabpanel"
        :aria-labelledby="tabId('instance')"
        class="support-panel"
        data-testid="support-panel-instance"
      >
        <div v-if="!config" class="support-loading">
          <LoadingSpinner v-if="loading" />
          <EmptyState v-else icon="heart" :title="t('empty.funding.title')" />
        </div>
        <EmptyState
          v-else-if="!config.enabled"
          icon="heart"
          :title="t('support.instanceOff')"
          data-testid="support-instance-off"
        />
        <template v-else>
          <p v-if="thanked" class="support-thanks" role="status" data-testid="support-thanks">
            <Icon name="heart" :size="16" aria-hidden="true" />
            <span>{{ t('support.thanks') }}</span>
          </p>
          <div class="support-grid">
            <div class="support-col">
              <FundingProgress
                :raised="raised"
                :goal="config.goal_amount"
                :currency="config.goal_currency"
                :period="period"
                :period-end="config.period_end"
                :supporters="config.supporter_count ?? 0"
                :show-bar="config.show_progress_bar !== false"
              />
              <p v-if="config.goal_description" class="support-description">{{ config.goal_description }}</p>

              <section v-if="links.length" class="support-give" :aria-labelledby="giveHeadingId">
                <h3 :id="giveHeadingId" class="support-heading">{{ t('support.heading') }}</h3>
                <SupportMessageComposer
                  v-if="messagesOn"
                  ref="composer"
                  :pending="myPending"
                  @saved="onMessageSaved"
                />
                <SupportLinkList
                  :links="links"
                  :donor="donor"
                  testid="support-links-instance"
                  @open="onPaymentOpened"
                />
                <details v-if="needsHandleInMessage(links)" class="support-handle">
                  <summary>
                    <Icon name="info" :size="14" class="support-handle__icon" aria-hidden="true" />
                    <span class="support-handle__title">{{ handleTitle }}</span>
                    <Icon name="chevron-down" :size="14" class="support-handle__chevron" aria-hidden="true" />
                  </summary>
                  <div class="support-handle__body">
                    <p>{{ t('support.handleText') }}</p>
                    <div class="support-handle__row">
                      <code class="support-handle__code">@{{ handle || 'username' }}@{{ instanceDomain }}</code>
                      <button v-if="handle" type="button" class="support-handle__copy" @click="copyHandle">
                        <Icon :name="handleCopied ? 'check' : 'copy'" :size="12" aria-hidden="true" />
                        {{ handleCopied ? t('support.copied') : t('support.copy') }}
                      </button>
                    </div>
                    <p>{{ t('support.handleHint') }}</p>
                  </div>
                </details>
              </section>
            </div>

            <div class="support-col">
              <section v-if="me && (me.badge || me.donations.length)" class="support-yours" data-testid="support-yours">
                <h3 class="support-heading">{{ t('support.yours') }}</h3>
                <div v-if="me.badge" class="support-yours__badge">
                  <span class="support-tier-chip" :style="chipStyle(me.badge.badge_color)">
                    <SupporterBadgeIcon :icon="me.badge.badge_icon" />
                  </span>
                  <span class="support-yours__text">
                    <span class="support-yours__tier">{{ t('support.tierSupporter', { tier: me.badge.tier_name }) }}</span>
                    <span class="support-yours__until">{{ badgeUntil }}</span>
                  </span>
                </div>
                <p v-if="config.thank_you_message" class="support-yours__note">{{ config.thank_you_message }}</p>
                <details v-if="me.donations.length" class="support-yours__history">
                  <summary>{{ t('support.history') }} ({{ me.donations.length }})</summary>
                  <ul>
                    <li v-for="d in me.donations" :key="d.id">
                      <span class="support-yours__amount">{{ money(d.amount, d.currency) }}</span>
                      <span class="support-yours__date">{{ day(d.donated_at) }}</span>
                    </li>
                  </ul>
                </details>
              </section>

              <SupporterWall
                v-if="messagesOn"
                :messages="config.messages ?? []"
                :mine="me?.messages ?? []"
                :can-moderate="isAdmin"
                :heading="t('support.wall.title')"
                :empty-text="t('support.wall.empty')"
                testid="supporter-wall-instance"
                @hide="hideMessage"
                @remove="removeMessage"
              />

              <section v-if="tiers.length" class="support-tiers" :aria-labelledby="tiersHeadingId">
                <h3 :id="tiersHeadingId" class="support-heading">{{ t('support.tiers') }}</h3>
                <ul class="support-tiers__list">
                  <li
                    v-for="tier in tiers"
                    :key="tier.id"
                    class="support-tier"
                    :class="{ 'is-current': me?.badge?.tier_name === tier.name }"
                  >
                    <span class="support-tier-chip" :style="chipStyle(tier.badge_color)">
                      <SupporterBadgeIcon :icon="tier.badge_icon" />
                    </span>
                    <span class="support-tier__text">
                      <span class="support-tier__head">
                        <span class="support-tier__name">{{ tier.name }}</span>
                        <span class="support-tier__min">{{ t('support.from', { amount: money(tier.min_amount, config.goal_currency) }) }}</span>
                      </span>
                      <span v-if="tier.perks" class="support-tier__perks">{{ tier.perks }}</span>
                    </span>
                  </li>
                </ul>
              </section>
            </div>
          </div>
        </template>
      </section>

      <!-- Harmony development -->
      <section
        v-show="tab === 'project'"
        :id="panelId('project')"
        role="tabpanel"
        :aria-labelledby="tabId('project')"
        class="support-panel"
        data-testid="support-panel-project"
      >
        <div class="support-grid support-grid--single">
          <div class="support-col">
            <div class="support-project">
              <img :src="duoUrl" alt="" class="support-project__mascot" width="88" height="64" />
              <div class="support-project__text">
                <h3 class="support-project__title">{{ t('support.project.title') }}</h3>
                <p class="support-project__lead">{{ t('support.project.lead', { instance: instanceDomain }) }}</p>
              </div>
            </div>
            <section class="support-give" :aria-labelledby="projectGiveHeadingId">
              <h3 :id="projectGiveHeadingId" class="support-heading">{{ t('support.heading') }}</h3>
              <SupportLinkList :links="developmentLinks" testid="support-links-project" />
            </section>
            <p class="support-footnote" data-testid="support-project-footnote">
              <Icon name="lock" :size="12" aria-hidden="true" />
              <span>
                {{ t('support.project.footnote', { instance: instanceDomain }) }}
                <!-- BaseModal's container stops clicks before the document's outside-link listener. -->
                <a
                  :href="DEVELOPMENT_SUPPORTERS_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="support-footnote__link"
                  data-testid="support-project-supporters"
                  @click="activateStoppedLink"
                >{{ t('support.project.supporters') }}</a>
              </span>
            </p>
          </div>
        </div>
      </section>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import duoUrl from '@/assets/mascot/duo.webp'
import BaseModal from '@/components/common/BaseModal.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import SupporterBadgeIcon from '@/components/common/SupporterBadgeIcon.vue'
import FundingProgress from '@/components/funding/FundingProgress.vue'
import SupportLinkList from '@/components/funding/SupportLinkList.vue'
import SupportMessageComposer from '@/components/funding/SupportMessageComposer.vue'
import SupporterWall from '@/components/funding/SupporterWall.vue'
import { formatDay, formatMoney, fundingPlatformLabel } from '@/components/funding/format'
import { useT } from '@/composables/useT'
import { DEVELOPMENT_LINKS, DEVELOPMENT_SUPPORTERS_URL } from '@/services/developmentFund'
import { hasCapability } from '@/services/instanceCapabilities'
import { getInstanceDomain } from '@/services/instanceConfig'
import { activateStoppedLink } from '@/services/outsideLinks'
import {
  fundingService,
  isStripeLink,
  needsHandleInMessage,
  type FundingLink,
  type MySupporterMessage,
} from '@/services/FundingService'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { useFundingStore, type SupportTab } from '@/stores/useFunding'
import { uid } from '@/utils/a11y/focus'

const TABS: SupportTab[] = ['instance', 'project']

const store = useFundingStore()
const profileStore = useProfileStore()
const authStore = useAuthStore()
const { t, locale } = useT()

const instanceDomain = computed(() => getInstanceDomain())
const config = computed(() => store.config)
const me = computed(() => store.config?.me ?? null)
const loading = ref(!store.config)

const supportsMessages = hasCapability('supporter-messages')
const tab = ref<SupportTab>(store.modal === 'project' ? 'project' : 'instance')

const title = computed(() => t('support.titleShort'))

const close = () => store.closeModal()

const scope = uid('support')
const tabId = (name: SupportTab) => `${scope}-tab-${name}`
const panelId = (name: SupportTab) => `${scope}-panel-${name}`
const giveHeadingId = `${scope}-give`
const projectGiveHeadingId = `${scope}-project-give`
const tiersHeadingId = `${scope}-tiers`
const tabEls: Partial<Record<SupportTab, HTMLElement | null>> = {}

function onTabKey(event: KeyboardEvent) {
  const index = TABS.indexOf(tab.value)
  let next = index
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % TABS.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + TABS.length) % TABS.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = TABS.length - 1
  else return
  event.preventDefault()
  tab.value = TABS[next]
  void nextTick(() => tabEls[tab.value]?.focus())
}

const period = computed<'monthly' | 'all'>(() => (config.value?.funding_period === 'all' ? 'all' : 'monthly'))
const raised = computed(() => Number(config.value?.displayed_amount ?? config.value?.current_amount ?? 0))
const links = computed<FundingLink[]>(() => config.value?.funding_links ?? [])
const tiers = computed(() => config.value?.tiers ?? [])
const messagesOn = computed(() => supportsMessages && config.value?.supporter_messages_enabled === true)
const myPending = computed<MySupporterMessage | null>(() => me.value?.messages?.find((m) => !m.attached) ?? null)
const isAdmin = computed(() => profileStore.profile?.is_admin === true)
const thanked = computed(() => store.thankedAt > 0 && Date.now() - store.thankedAt < 10 * 60_000)

const donor = computed(() => ({
  profileId: me.value?.profile_id ?? profileStore.profile?.id ?? null,
  email: authStore.session?.user?.email ?? null,
}))

// Opened as they are: no profile id or email, which mean nothing outside this instance.
const developmentLinks = computed<FundingLink[]>(() => DEVELOPMENT_LINKS.map((link) => ({
  platform: link.platform,
  url: link.url,
  label: link.period === 'monthly' ? t('support.project.monthly') : t('support.oneTime'),
})))

const money = (amount: number, currency: string) => formatMoney(amount, currency, locale.value)
const day = (iso: string) => formatDay(iso, locale.value)

const badgeUntil = computed(() => {
  const expires = me.value?.badge?.expires_at
  return expires ? t('support.until', { date: day(expires) }) : t('support.active')
})

const chipStyle = (color: string | null | undefined) => (color
  ? { backgroundColor: `${color}20`, borderColor: color, color }
  : {})

// Ko-fi and other links without a passthrough field attribute by the handle in the message.
const handle = computed(() => profileStore.profile?.username ?? '')
const handleTitle = computed(() => {
  if (!links.value.some(isStripeLink)) return t('support.badgeAuto')
  const others = [...new Set(links.value.filter((l) => !isStripeLink(l)).map((l) => fundingPlatformLabel(l.platform)))]
  return t('support.handleTitle', { platforms: others.join(' / ') })
})
const handleCopied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function copyHandle() {
  try {
    await navigator.clipboard.writeText(`@${handle.value}@${instanceDomain.value}`)
    handleCopied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { handleCopied.value = false }, 2000)
  } catch {
    /* clipboard unavailable */
  }
}

const composer = ref<InstanceType<typeof SupportMessageComposer> | null>(null)

function onPaymentOpened() {
  composer.value?.saveIfChanged()
  store.notePaymentOpened()
}

function onMessageSaved(message: MySupporterMessage) {
  const summary = store.config
  if (!summary?.me) return
  summary.me.messages = [message, ...summary.me.messages.filter((m) => m.attached)]
}

async function removeMessage(id: string) {
  if (!(await fundingService.deleteSupporterMessage(id))) return
  const summary = store.config
  if (!summary) return
  if (summary.me) summary.me.messages = summary.me.messages.filter((m) => m.id !== id)
  summary.messages = summary.messages.filter((m) => m.id !== id)
}

async function hideMessage(id: string) {
  if (!(await fundingService.adminReviewSupporterMessage(id, 'hidden'))) return
  const summary = store.config
  if (summary) summary.messages = summary.messages.filter((m) => m.id !== id)
}

onMounted(() => {
  void store.refresh().finally(() => { loading.value = false })
})

onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<style>
/* BaseModal's container, wider than its 540px default, held at the top so switching tabs moves
   only its bottom edge; a full-height sheet on phones. The content drops shared.css's 600px cap
   of the legacy .modal-content card. Two classes on the overlay outrank BaseModal's scoped rules. */
.modal-overlay.support-modal-overlay {
  align-items: flex-start;
  padding-top: max(20px, calc(5 * var(--app-vh)));
}

.modal-overlay.support-modal-overlay > .modal-container {
  max-width: 880px;
  max-height: min(calc(90 * var(--app-vh)), 860px);
}

.modal-overlay.support-modal-overlay > .modal-container > .modal-content {
  max-width: none;
}

@media (max-width: 600px) {
  .modal-overlay.support-modal-overlay {
    align-items: stretch;
    padding: 0;
  }

  .modal-overlay.support-modal-overlay > .modal-container {
    max-width: none;
    height: calc(100 * var(--app-vh));
    max-height: none;
    border-width: 0;
    border-radius: 0;
  }

  .modal-overlay.support-modal-overlay > .modal-container > .modal-content {
    padding: var(--space-4) var(--space-4) calc(var(--space-6) + env(safe-area-inset-bottom, 0px));
  }
}
</style>

<style scoped>
.support {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.support-tabs {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
}

.support-tab {
  display: inline-flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-width: 0;
  min-height: 40px;
  padding: 0 var(--space-4);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
  cursor: pointer;
}

.support-tab__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 440px) {
  .support-tab {
    padding: 0 var(--space-2);
  }

  .support-tab__icon {
    display: none;
  }
}

.support-tab:hover {
  color: var(--text-primary);
}

.support-tab:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.support-tab[aria-selected='true'] {
  background: var(--background-primary);
  border-color: var(--border-color);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 0.12));
}

.support-tab[aria-selected='true'] .support-tab__icon {
  color: var(--text-link);
}

.support-panel:focus-visible {
  outline: none;
}

.support-loading {
  display: flex;
  justify-content: center;
  padding: var(--space-8) 0;
}

.support-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-6);
}

@media (min-width: 840px) {
  .support-grid {
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
    align-items: start;
  }

  .support-grid--single {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* The Harmony development tab: one centred column. */
.support-grid--single {
  width: 100%;
  max-width: 560px;
  margin-inline: auto;
}

.support-col {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-width: 0;
}

.support-heading {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.support-lead,
.support-description {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.support-lead {
  color: var(--text-primary);
}

.support-thanks {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  background: color-mix(in srgb, var(--success) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--success) 35%, transparent);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-success);
}

.support-give {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.support-give .support-heading {
  margin-bottom: 0;
}

/* Handle attribution for links without a passthrough field. */
.support-handle {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.support-handle summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: var(--space-2) var(--space-4);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  list-style: none;
  cursor: pointer;
}

.support-handle summary::-webkit-details-marker {
  display: none;
}

.support-handle__icon {
  flex-shrink: 0;
  color: var(--text-link);
}

.support-handle__title {
  flex: 1;
  min-width: 0;
}

.support-handle__chevron {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.support-handle[open] .support-handle__chevron {
  transform: rotate(180deg);
}

.support-handle__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-4);
}

.support-handle__body p {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.support-handle__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.support-handle__code {
  padding: var(--space-1) var(--space-2);
  background: var(--surface-inset, var(--background-tertiary));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--text-primary);
  word-break: break-all;
  user-select: all;
}

.support-handle__copy {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 28px;
  padding: 0 var(--space-2);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  cursor: pointer;
}

.support-handle__copy:hover {
  border-color: var(--harmony-primary);
  color: var(--text-link);
}

/* Your support */
.support-yours {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.support-yours .support-heading {
  margin: 0;
}

.support-yours__badge {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.support-yours__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.support-yours__tier {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.support-yours__until {
  font-size: var(--font-size-xs);
  color: var(--text-success);
}

.support-yours__note {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.support-yours__history summary {
  font-size: var(--font-size-xs);
  color: var(--text-link);
  cursor: pointer;
}

.support-yours__history ul {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
}

.support-yours__history li {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.support-yours__amount {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

/* Tiers */
.support-tiers__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.support-tier {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
}

.support-tier.is-current {
  background: color-mix(in srgb, var(--harmony-primary) 8%, transparent);
  border-color: var(--harmony-primary);
}

.support-tier-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  min-width: 34px;
  height: 26px;
  padding: 0 var(--space-2);
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-hover);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  line-height: 1;
  color: var(--text-secondary);
}

.support-tier__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.support-tier__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: var(--space-2);
}

.support-tier__name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.support-tier__min {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.support-tier__perks {
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

/* Harmony development */
.support-project {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.support-project__mascot {
  flex-shrink: 0;
  width: 88px;
  height: 64px;
  object-fit: contain;
}

.support-project__text {
  min-width: 0;
}

.support-project__title {
  margin: 0 0 var(--space-1);
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
}

.support-project__lead {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.support-footnote {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.support-footnote :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
}

.support-footnote__link {
  color: var(--text-link);
  font-weight: var(--font-weight-medium);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.support-footnote__link:hover {
  text-decoration-thickness: 2px;
}

.support-footnote__link:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
</style>
