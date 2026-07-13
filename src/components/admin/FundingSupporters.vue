<template>
<!-- Funding Management -->
<div class="admin-module funding-module">
  <div class="module-header">
    <Icon name="heart" :size="20" />
    <h2>Funding & Supporters</h2>
    <button @click="saveFundingConfig" class="save-btn" :disabled="!fundingChanged">
      <Icon name="save" :size="16" />
      Save Changes
    </button>
  </div>
  <div class="funding-content">
    <!-- Funding Config -->
    <div class="funding-section">
      <h3>Funding Goal</h3>
      <div class="setting-row">
        <label class="toggle-label">
          <input type="checkbox" v-model="fundingEnabled" />
          <span class="toggle-slider"></span>
          Enable funding
        </label>
      </div>
      <div v-if="fundingEnabled" class="funding-fields">
        <div class="setting-row">
          <label class="toggle-label">
            <input type="checkbox" v-model="fundingShowInBar" />
            <span class="toggle-slider"></span>
            Show in context bar
          </label>
        </div>
        <div class="setting-row">
          <label class="toggle-label">
            <input type="checkbox" v-model="fundingShowProgress" />
            <span class="toggle-slider"></span>
            Show progress bar
          </label>
        </div>
        <div class="funding-form-row">
          <div class="funding-field">
            <label>Goal amount</label>
            <input type="number" v-model.number="fundingGoalAmount" class="cyber-input" min="0" step="1" />
          </div>
          <div class="funding-field">
            <label>Currency</label>
            <select v-model="fundingCurrency" class="cyber-select">
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="JPY">JPY</option>
            </select>
          </div>
          <div class="funding-field">
            <label>Period</label>
            <select v-model="fundingPeriod" class="cyber-select">
              <option value="monthly">Monthly (resets each month)</option>
              <option value="all">All time</option>
            </select>
            <span class="setting-hint" style="display: block; margin-top: 4px;">
              Total is computed from donation history; period controls which donations count.
            </span>
          </div>
        </div>
        <div class="funding-field" style="margin-top: 8px;">
          <label>Description</label>
          <input type="text" v-model="fundingDescription" class="cyber-input" placeholder="What the funding is for..." />
        </div>
        <div class="funding-field" style="margin-top: 8px;">
          <label>Thank you message</label>
          <input type="text" v-model="fundingThankYou" class="cyber-input" placeholder="Message shown to supporters" />
        </div>

        <!-- Funding Links -->
        <div class="funding-links-section" style="margin-top: 16px;">
          <label style="font-size: 12px; color: var(--text-secondary); font-weight: 600; display: block; margin-bottom: 8px;">Donation Links</label>
          <div v-if="fundingLinks.length > 0" class="funding-links-list">
            <div v-for="(link, i) in fundingLinks" :key="i" class="funding-link-row">
              <select v-model="link.platform" class="cyber-select" style="width: 160px;">
                <option v-for="opt in FUNDING_PLATFORMS" :key="opt" :value="opt">{{ platformLabel(opt) }}</option>
              </select>
              <input v-model="link.url" class="cyber-input" placeholder="https://..." style="flex: 1;" />
              <input v-model="link.label" class="cyber-input" placeholder="Label (optional)" style="width: 140px;" />
              <button class="mod-btn delete-btn" @click="fundingLinks.splice(i, 1)" title="Remove link">
                <Icon name="delete" :size="14" />
              </button>
            </div>
          </div>
          <div class="funding-link-row" style="margin-top: 6px;">
            <select v-model="newLinkPlatform" class="cyber-select" style="width: 160px;">
              <option value="" disabled>Platform...</option>
              <option v-for="opt in FUNDING_PLATFORMS" :key="opt" :value="opt">{{ platformLabel(opt) }}</option>
            </select>
            <input v-model="newLinkUrl" class="cyber-input" placeholder="https://..." style="flex: 1;" />
            <input v-model="newLinkLabel" class="cyber-input" placeholder="Label (optional)" style="width: 140px;" />
            <button class="action-btn" @click="addFundingLink" :disabled="!newLinkPlatform || !newLinkUrl" style="white-space: nowrap;">
              <Icon name="plus" :size="14" /> Add
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Ko-fi Webhook (automation) -->
    <div class="funding-section">
      <h3>Ko-fi Webhook <span class="section-badge">Automation</span></h3>
      <p class="section-description" style="margin-bottom: 12px;">
        Auto-record donations from Ko-fi. Requires a Ko-fi Gold subscription.
        Paste your verification token from
        <a href="https://ko-fi.com/manage/webhooks" target="_blank" rel="noopener noreferrer">Ko-fi Settings → API</a>
        and set the Webhook URL to:
      </p>
      <div class="webhook-url-display">
        <code>{{ kofiWebhookUrl }}</code>
        <button class="mod-btn" @click="copyKofiWebhookUrl" title="Copy URL">
          <Icon name="copy" :size="14" />
        </button>
      </div>
      <div class="funding-form-row" style="margin-top: 12px;">
        <div class="funding-field" style="flex: 1;">
          <label>Verification Token</label>
          <input
            v-model="kofiWebhookToken"
            :type="showKofiToken ? 'text' : 'password'"
            class="cyber-input"
            placeholder="Paste from Ko-fi Settings → API"
            autocomplete="off"
          />
        </div>
        <div class="funding-field" style="align-self: flex-end;">
          <button class="mod-btn" type="button" @click="showKofiToken = !showKofiToken" :title="showKofiToken ? 'Hide' : 'Show'">
            <Icon :name="showKofiToken ? 'eye-off' : 'eye'" :size="14" />
          </button>
        </div>
      </div>
      <label class="funding-field" style="margin-top: 8px; display: flex; align-items: center; gap: 8px;">
        <input type="checkbox" v-model="kofiAutoAssignTier" />
        <span>Auto-assign supporter tier based on donation amount</span>
      </label>
      <p class="section-hint">
        Donors include their handle (<code>@username@{{ instanceDomain }}</code>) anywhere in their Ko-fi
        message - the webhook auto-attributes it and recomputes their tier based on cumulative cycle
        donations. Donations without a matched handle land in the <strong>Pending Donations</strong>
        queue below, and you (and instance moderators) get a notification.
      </p>
    </div>

    <!-- Pending Donations -->
    <div class="funding-section" v-if="pendingDonations.length > 0 || pendingDonationCount > 0">
      <h3>
        Pending Donations
        <span v-if="pendingDonationCount > 0" class="pending-count-badge">{{ pendingDonationCount }}</span>
      </h3>
      <p class="section-description" style="margin-bottom: 12px;">
        Webhook donations that couldn't be auto-matched to a user. Search for the recipient or dismiss.
      </p>
      <div v-if="pendingDonations.length > 0" class="pending-donations-list">
        <div v-for="pending in pendingDonations" :key="pending.id" class="pending-donation-item">
          <div class="pending-donation-header">
            <span class="pending-amount">{{ pending.currency }} {{ pending.amount.toFixed(2) }}</span>
            <span class="pending-platform">{{ pending.platform }}</span>
            <span class="pending-date">{{ formatDate(pending.received_at) }}</span>
          </div>
          <div class="pending-donation-meta">
            <span v-if="pending.donor_name"><strong>From:</strong> {{ pending.donor_name }}</span>
            <span v-if="pending.donor_email" class="pending-email">{{ pending.donor_email }}</span>
          </div>
          <div v-if="pending.donor_message" class="pending-message">
            &ldquo;{{ pending.donor_message }}&rdquo;
          </div>
          <div class="pending-resolve-row">
            <input
              v-model="pendingResolveSearch[pending.id]"
              class="cyber-input"
              placeholder="Search user by username..."
              @input="onPendingResolveSearch(pending.id)"
              style="flex: 1;"
            />
            <button class="report-action-btn resolve" :disabled="!pendingResolveUserId[pending.id]" @click="resolvePending(pending)">
              <Icon name="check" :size="14" /> Attribute
            </button>
            <button class="report-action-btn dismiss" @click="dismissPending(pending.id)">
              <Icon name="x" :size="14" /> Dismiss
            </button>
          </div>
          <div v-if="pendingResolveSuggestions[pending.id]?.length" class="pending-suggestions">
            <div
              v-for="user in pendingResolveSuggestions[pending.id]"
              :key="user.id"
              class="pending-suggestion"
              :class="{ active: pendingResolveUserId[pending.id] === user.id }"
              @click="pendingResolveUserId[pending.id] = user.id; pendingResolveSearch[pending.id] = user.handle"
            >
              <Avatar :src="user.avatar_url" :alt="user.username" size="xs" />
              <span>{{ user.handle }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Supporter Tiers -->
    <div class="funding-section">
      <h3>Supporter Tiers</h3>
      <div class="tiers-list" v-if="supporterTiers.length > 0">
        <div v-for="tier in supporterTiers" :key="tier.id" class="tier-item">
          <template v-if="editingTierId === tier.id">
            <div class="tier-icon-picker" style="position: relative;">
              <input v-model="editTierIcon" class="cyber-input" style="width: 60px;" />
              <button
                ref="editTierEmojiButtonRef"
                type="button"
                class="mod-btn emoji-picker-btn"
                @click.stop="showEditTierEmojiPicker = !showEditTierEmojiPicker"
                title="Pick emoji"
              >
                <SupporterBadgeIcon v-if="editTierIcon" :icon="editTierIcon" />
                <span v-else>😀</span>
              </button>
              <EmojiPopup
                v-if="showEditTierEmojiPicker"
                @click.stop
                @sendEmoji="handleEditTierEmoji"
                :closeEmojiList="() => showEditTierEmojiPicker = false"
                :emojiIconClicked="true"
                :position="'below'"
                :triggerElement="((editTierEmojiButtonRef as any) as HTMLElement | null) || undefined"
                @resetEmojiIconClicked="() => {}"
              />
            </div>
            <input v-model="editTierName" class="cyber-input" style="flex: 1;" />
            <input v-model.number="editTierMinAmount" type="number" class="cyber-input" style="width: 90px;" min="0" />
            <input v-model="editTierColor" type="color" class="color-input" />
            <label class="tier-ads-toggle" title="Supporters on this tier see no GIF ads">
              <input type="checkbox" v-model="editTierRemovesAds" />
              <span>Ad-free GIFs</span>
            </label>
            <button class="mod-btn" @click="saveEditTier(tier.id)" title="Save"><Icon name="check" :size="14" /></button>
            <button class="mod-btn" @click="editingTierId = null; showEditTierEmojiPicker = false" title="Cancel"><Icon name="x" :size="14" /></button>
          </template>
          <template v-else>
            <span class="tier-icon" :style="tier.badge_color ? { color: tier.badge_color } : {}">
              <SupporterBadgeIcon :icon="tier.badge_icon" />
            </span>
            <div class="tier-info">
              <span class="tier-name">{{ tier.name }}</span>
              <span class="tier-amount">Min: {{ tier.min_amount }}</span>
              <span v-if="tier.removes_ads" class="tier-adfree-badge" title="Supporters on this tier see no GIF ads">Ad-free GIFs</span>
              <span v-if="tier.perks" class="tier-perks">{{ tier.perks }}</span>
            </div>
            <div class="tier-actions">
              <button class="mod-btn" @click="startEditTier(tier)" title="Edit tier"><Icon name="edit" :size="14" /></button>
              <button class="mod-btn delete-btn" @click="deleteTier(tier.id)" title="Delete tier"><Icon name="delete" :size="14" /></button>
            </div>
          </template>
        </div>
      </div>
      <div v-else class="empty-hint">No tiers configured</div>
      <div class="add-tier-form">
        <input v-model="newTierName" class="cyber-input" placeholder="Tier name" />
        <input v-model.number="newTierMinAmount" type="number" class="cyber-input" placeholder="Min amount" min="0" style="width: 120px;" />
        <div class="tier-icon-picker" style="position: relative;">
          <input v-model="newTierIcon" class="cyber-input" placeholder="Icon" style="width: 60px;" />
          <button
            ref="newTierEmojiButtonRef"
            type="button"
            class="mod-btn emoji-picker-btn"
            @click.stop="showNewTierEmojiPicker = !showNewTierEmojiPicker"
            title="Pick emoji"
          >
            <SupporterBadgeIcon v-if="newTierIcon" :icon="newTierIcon" />
            <span v-else>😀</span>
          </button>
          <EmojiPopup
            v-if="showNewTierEmojiPicker"
            @click.stop
            @sendEmoji="handleNewTierEmoji"
            :closeEmojiList="() => showNewTierEmojiPicker = false"
            :emojiIconClicked="true"
            :position="'above'"
            :triggerElement="((newTierEmojiButtonRef as any) as HTMLElement | null) || undefined"
            @resetEmojiIconClicked="() => {}"
          />
        </div>
        <input v-model="newTierColor" type="color" class="color-input" title="Badge color" />
        <label class="tier-ads-toggle" title="Supporters on this tier see no GIF ads">
          <input type="checkbox" v-model="newTierRemovesAds" />
          <span>Ad-free GIFs</span>
        </label>
        <button class="action-btn" @click="addTier" :disabled="!newTierName || !newTierMinAmount">
          <Icon name="plus" :size="16" /> Add
        </button>
      </div>
    </div>

    <!-- Supporters -->
    <div class="funding-section">
      <h3>Active Supporters</h3>
      <div class="supporters-list" v-if="supporters.length > 0">
        <div v-for="supporter in supporters" :key="supporter.id" class="supporter-item">
          <Avatar :src="supporter.user?.avatar_url" :alt="supporter.user?.username" size="sm" />
          <div class="supporter-info">
            <span class="supporter-name">
              <DisplayName v-if="supporter.user_id" :user-id="supporter.user_id" :fallback="supporter.user?.display_name || supporter.user?.username" />
              <template v-else>{{ supporter.user?.display_name || supporter.user?.username }}</template>
            </span>
            <span class="supporter-meta">
              {{ supporter.tier?.name || 'No tier' }}
              <template v-if="supporter.amount"> &middot; {{ supporter.amount }}</template>
              <template v-if="supporter.platform"> &middot; {{ supporter.platform }}</template>
            </span>
          </div>
          <div class="supporter-actions">
            <button class="mod-btn" @click="startEditSupporter(supporter)" title="Edit supporter"><Icon name="edit" :size="14" /></button>
            <button class="mod-btn" @click="openRecordDonation(supporter)" title="Record donation">
              <Icon name="dollar-sign" :size="14" />
            </button>
            <button class="mod-btn delete-btn" @click="removeSupporter(supporter.user_id)" title="Remove supporter"><Icon name="delete" :size="14" /></button>
          </div>
        </div>
      </div>
      <div v-else class="empty-hint">No active supporters</div>

      <!-- Add Supporter -->
      <div class="add-supporter-form">
        <div class="supporter-search-wrapper" style="position: relative; flex: 1; min-width: 100px;">
          <input
            ref="supporterSearchInputRef"
            v-model="addSupporterSearch"
            class="cyber-input"
            placeholder="Username to add as supporter..."
            @input="onSupporterSearchInput"
            @keydown="onSupporterSearchKeydown"
            @focus="supporterSearchFocused = true"
            @blur="onSupporterSearchBlur"
            autocomplete="off"
          />
          <div
            v-if="supporterSearchFocused && supporterSuggestions.length > 0"
            class="supporter-suggestions"
          >
            <div
              v-for="(s, idx) in supporterSuggestions"
              :key="s.id"
              class="supporter-suggestion-item"
              :class="{ selected: idx === supporterSelectedIdx }"
              @mousedown.prevent="selectSupporterSuggestion(s)"
            >
              <Avatar :src="s.avatar_url" :alt="s.username" size="xs" />
              <div class="supporter-suggestion-text">
                <DisplayName :userId="s.id" :fallback="s.display_name || s.username" :truncate="true" class="supporter-suggestion-name" />
                <span class="supporter-suggestion-handle">{{ s.handle }}</span>
              </div>
            </div>
          </div>
        </div>
        <select v-model="addSupporterTierId" class="cyber-select" style="width: 140px;">
          <option value="">No tier</option>
          <option v-for="t in supporterTiers" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>
        <input v-model.number="addSupporterAmount" type="number" class="cyber-input" placeholder="Amount" min="0" style="width: 100px;" />
        <input v-model="addSupporterPlatform" class="cyber-input" placeholder="Platform" style="width: 110px;" />
        <button class="action-btn" @click="addNewSupporter" :disabled="!addSupporterSearch">
          <Icon name="plus" :size="16" /> Add
        </button>
      </div>
    </div>

    <!-- Edit Supporter Modal (inline) -->
    <div v-if="editingSupporterData" class="funding-section edit-supporter-panel">
      <h3>Edit Supporter: <DisplayName v-if="editingSupporterData.user_id" :user-id="editingSupporterData.user_id" :fallback="editingSupporterData.user?.display_name || editingSupporterData.user?.username" /><template v-else>{{ editingSupporterData.user?.display_name || editingSupporterData.user?.username }}</template></h3>
      <div class="funding-form-row">
        <div class="funding-field">
          <label>Tier</label>
          <select v-model="editSupporterTierId" class="cyber-select">
            <option value="">No tier</option>
            <option v-for="t in supporterTiers" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </div>
        <div class="funding-field">
          <label>Amount</label>
          <input v-model.number="editSupporterAmount" type="number" class="cyber-input" min="0" />
        </div>
        <div class="funding-field">
          <label>Platform</label>
          <input v-model="editSupporterPlatform" class="cyber-input" />
        </div>
      </div>
      <div class="report-action-buttons" style="margin-top: 8px;">
        <button class="report-action-btn resolve" @click="saveEditSupporter">Save</button>
        <button class="report-action-btn dismiss" @click="editingSupporterData = null">Cancel</button>
      </div>
    </div>

    <!-- Record Donation Modal (inline) -->
    <div v-if="recordDonationSupporter" class="funding-section edit-supporter-panel">
      <h3>Record Donation for <DisplayName v-if="recordDonationSupporter.user_id" :user-id="recordDonationSupporter.user_id" :fallback="recordDonationSupporter.user?.display_name || recordDonationSupporter.user?.username" /><template v-else>{{ recordDonationSupporter.user?.display_name || recordDonationSupporter.user?.username }}</template></h3>
      <div class="funding-form-row">
        <div class="funding-field">
          <label>Amount</label>
          <input v-model.number="recordDonationAmount" type="number" class="cyber-input" min="0" step="0.01" />
        </div>
        <div class="funding-field">
          <label>Currency</label>
          <select v-model="recordDonationCurrency" class="cyber-select">
            <option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="JPY">JPY</option>
          </select>
        </div>
        <div class="funding-field">
          <label>Platform</label>
          <input v-model="recordDonationPlatform" class="cyber-input" placeholder="e.g. Patreon, Ko-fi" />
        </div>
      </div>
      <div class="funding-field" style="margin-top: 8px;">
        <label>Note</label>
        <input v-model="recordDonationNote" class="cyber-input" placeholder="Optional note..." />
      </div>
      <div class="report-action-buttons" style="margin-top: 8px;">
        <button class="report-action-btn resolve" @click="saveRecordDonation" :disabled="!recordDonationAmount">Record</button>
        <button class="report-action-btn dismiss" @click="recordDonationSupporter = null">Cancel</button>
      </div>
    </div>

    <!-- Donation History -->
    <div class="funding-section">
      <h3>Donation History</h3>
      <div v-if="donationStats.donationCount > 0" class="donation-stats-row">
        <div class="donation-stat">
          <span class="donation-stat-value">{{ donationStats.totalDonated.toFixed(2) }}</span>
          <span class="donation-stat-label">Total donated</span>
        </div>
        <div class="donation-stat">
          <span class="donation-stat-value">{{ donationStats.donationCount }}</span>
          <span class="donation-stat-label">Donations</span>
        </div>
        <div class="donation-stat">
          <span class="donation-stat-value">{{ donationStats.uniqueDonors }}</span>
          <span class="donation-stat-label">Unique donors</span>
        </div>
      </div>
      <div v-if="donationHistory.length > 0" class="donations-list">
        <div v-for="donation in donationHistory" :key="donation.id" class="donation-item">
          <Avatar v-if="donation.user" :src="donation.user.avatar_url" :alt="donation.user.username" size="xs" />
          <span class="donation-user" v-if="donation.user">
            <DisplayName v-if="donation.user_id" :user-id="donation.user_id" :fallback="donation.user.display_name || donation.user.username" />
            <template v-else>{{ donation.user.display_name || donation.user.username }}</template>
          </span>
          <span class="donation-amount">{{ donation.currency }} {{ donation.amount }}</span>
          <span class="donation-date">{{ formatDate(donation.donated_at) }}</span>
          <span v-if="donation.platform" class="donation-platform">{{ donation.platform }}</span>
          <span v-if="donation.note" class="donation-note">{{ donation.note }}</span>
          <div class="donation-actions">
            <button class="mod-btn" @click="startEditDonation(donation)" title="Edit"><Icon name="edit" :size="12" /></button>
            <button class="mod-btn delete-btn" @click="deleteDonation(donation.id)" title="Delete"><Icon name="delete" :size="12" /></button>
          </div>
        </div>
      </div>
      <div v-else class="empty-hint">No donations recorded</div>

      <!-- Edit Donation (inline) -->
      <div v-if="editingDonation" class="edit-donation-panel">
        <div class="funding-form-row">
          <div class="funding-field">
            <label>Amount</label>
            <input v-model.number="editDonationAmount" type="number" class="cyber-input" min="0" step="0.01" />
          </div>
          <div class="funding-field">
            <label>Currency</label>
            <select v-model="editDonationCurrency" class="cyber-select">
              <option value="USD">USD</option><option value="EUR">EUR</option><option value="GBP">GBP</option><option value="JPY">JPY</option>
            </select>
          </div>
          <div class="funding-field">
            <label>Platform</label>
            <input v-model="editDonationPlatform" class="cyber-input" />
          </div>
          <div class="funding-field">
            <label>Note</label>
            <input v-model="editDonationNote" class="cyber-input" />
          </div>
        </div>
        <div class="report-action-buttons" style="margin-top: 8px;">
          <button class="report-action-btn resolve" @click="saveEditDonation">Save</button>
          <button class="report-action-btn dismiss" @click="editingDonation = null">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import EmojiPopup from '@/components/EmojiPopup.vue'
import SupporterBadgeIcon from '@/components/common/SupporterBadgeIcon.vue'
import { fundingService, FUNDING_PLATFORMS, type FundingPlatformKey, type SupporterTier, type Supporter, type DonationRecord, type PendingDonation } from '@/services/FundingService'
import { activityPubService } from '@/services/activityPubService'
import { adminService } from '@/services/AdminService'
import { supabase } from '@/supabase'
import { getEmojiShortcodeForInsert } from '@/services/emojiShortcodeResolver'
import type { Emoji } from '@/types'
import { formatDate } from './adminFormat'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

const toast = useToast()
const { confirm } = useConfirmDialog()

const fundingChanged = ref(false)
const fundingEnabled = ref(false)
const fundingShowInBar = ref(false)
const fundingShowProgress = ref(true)
const fundingGoalAmount = ref<number>(0)
const fundingCurrency = ref('USD')
const fundingCurrentAmount = ref<number>(0)
const fundingPeriod = ref<'all' | 'monthly'>('monthly')
const fundingDescription = ref('')
const fundingThankYou = ref('')
const fundingLinks = ref<{ platform: string; url: string; label: string }[]>([])
const newLinkPlatform = ref('')
const newLinkUrl = ref('')
const newLinkLabel = ref('')

const kofiWebhookToken = ref('')
const kofiAutoAssignTier = ref(true)
const showKofiToken = ref(false)
const kofiWebhookUrl = computed(() => {
  // Federation backend exposes /webhooks/kofi. Prefer explicit federation URL,
  // fall back to current origin.
  const base = (import.meta.env.VITE_FEDERATION_URL as string | undefined)
    || (typeof window !== 'undefined' ? window.location.origin : '')
  return `${base.replace(/\/$/, '')}/webhooks/kofi`
})
const instanceDomain = computed(() =>
  (import.meta.env.VITE_DOMAIN as string | undefined) || 'your-domain'
)

const pendingDonations = ref<PendingDonation[]>([])
const pendingDonationCount = ref(0)
const pendingResolveSearch = ref<Record<string, string>>({})
const pendingResolveUserId = ref<Record<string, string | null>>({})
const pendingResolveSuggestions = ref<Record<string, Array<{ id: string; username: string; handle: string; avatar_url?: string }>>>({})
const pendingResolveTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const supporterTiers = ref<SupporterTier[]>([])
const supporters = ref<Supporter[]>([])
const donationHistory = ref<DonationRecord[]>([])
const donationStats = ref<{ totalDonated: number; donationCount: number; uniqueDonors: number }>({ totalDonated: 0, donationCount: 0, uniqueDonors: 0 })
const newTierName = ref('')
const newTierMinAmount = ref<number>(0)
const newTierIcon = ref('⭐')
const newTierColor = ref('#0EA5E9')
const newTierRemovesAds = ref(false)

const editingTierId = ref<string | null>(null)
const editTierName = ref('')
const editTierMinAmount = ref<number>(0)
const editTierIcon = ref('')
const editTierColor = ref('#0EA5E9')
const editTierRemovesAds = ref(false)

const showNewTierEmojiPicker = ref(false)
const showEditTierEmojiPicker = ref(false)
const newTierEmojiButtonRef = ref<HTMLElement | null>(null)
const editTierEmojiButtonRef = ref<HTMLElement | null>(null)

const addSupporterSearch = ref('')
const addSupporterSelectedUserId = ref<string | null>(null)
const addSupporterTierId = ref('')
const addSupporterAmount = ref<number>(0)
const addSupporterPlatform = ref('')
const supporterSearchInputRef = ref<HTMLInputElement | null>(null)
const supporterSearchFocused = ref(false)
const supporterSelectedIdx = ref(0)
const supporterSuggestions = ref<Array<{ id: string; username: string; display_name: string; avatar_url?: string; handle: string; is_local: boolean }>>([])
let supporterSearchTimeout: ReturnType<typeof setTimeout> | null = null
const editingSupporterData = ref<Supporter | null>(null)
const editSupporterTierId = ref('')
const editSupporterAmount = ref<number>(0)
const editSupporterPlatform = ref('')

const recordDonationSupporter = ref<Supporter | null>(null)
const recordDonationAmount = ref<number>(0)
const recordDonationCurrency = ref('USD')
const recordDonationPlatform = ref('')
const recordDonationNote = ref('')

const editingDonation = ref<DonationRecord | null>(null)
const editDonationAmount = ref<number>(0)
const editDonationCurrency = ref('USD')
const editDonationPlatform = ref('')
const editDonationNote = ref('')

watch(
  [fundingEnabled, fundingShowInBar, fundingShowProgress, fundingGoalAmount, fundingCurrency, fundingCurrentAmount, fundingPeriod, fundingDescription, fundingThankYou, fundingLinks, kofiWebhookToken, kofiAutoAssignTier],
  () => { fundingChanged.value = true },
  { deep: true }
)

const loadFundingData = async () => {
  const config = await fundingService.getFundingConfig()
  if (config) {
    fundingEnabled.value = config.enabled
    fundingShowInBar.value = config.show_in_context_bar
    fundingShowProgress.value = config.show_progress_bar
    fundingGoalAmount.value = config.goal_amount || 0
    fundingCurrency.value = config.goal_currency
    fundingCurrentAmount.value = config.current_amount
    fundingPeriod.value = config.funding_period === 'all' ? 'all' : 'monthly'
    fundingDescription.value = config.goal_description || ''
    fundingThankYou.value = config.thank_you_message || ''
    fundingLinks.value = config.funding_links || []
    kofiWebhookToken.value = config.kofi_webhook_token || ''
    kofiAutoAssignTier.value = config.kofi_auto_assign_tier !== false
  }
  supporterTiers.value = await fundingService.getTiers()
  supporters.value = await fundingService.getSupporters()
  donationHistory.value = await fundingService.getDonationHistory()
  donationStats.value = await fundingService.getDonationStats()
  pendingDonations.value = await fundingService.getPendingDonations()
  pendingDonationCount.value = pendingDonations.value.filter(p => !p.resolved_at).length
  // Reset after populating to avoid false dirty state from watchers
  fundingChanged.value = false
}

const PLATFORM_LABELS: Record<FundingPlatformKey, string> = {
  'ko-fi': 'Ko-fi',
  'patreon': 'Patreon',
  'github-sponsors': 'GitHub Sponsors',
  'liberapay': 'Liberapay',
  'open-collective': 'Open Collective',
  'paypal': 'PayPal',
  'buymeacoffee': 'Buy Me a Coffee',
  'custom': 'Custom',
}
const platformLabel = (key: string): string => PLATFORM_LABELS[key as FundingPlatformKey] || key

const copyKofiWebhookUrl = async () => {
  try {
    await navigator.clipboard.writeText(kofiWebhookUrl.value)
    toast.success('Webhook URL copied')
  } catch {
    toast.error('Failed to copy')
  }
}

// Pending donations: search for the right user to attribute to.
const onPendingResolveSearch = (pendingId: string) => {
  if (pendingResolveTimers[pendingId]) clearTimeout(pendingResolveTimers[pendingId])
  pendingResolveTimers[pendingId] = setTimeout(async () => {
    const query = (pendingResolveSearch.value[pendingId] || '').trim().replace(/^@+/, '')
    if (query.length < 2) {
      pendingResolveSuggestions.value[pendingId] = []
      return
    }
    try {
      const users = await activityPubService.searchUsers(query, 5)
      pendingResolveSuggestions.value[pendingId] = users.map((u: any) => ({
        id: u.id,
        username: u.username,
        handle: u.handle || (u.is_local ? `@${u.username}` : `@${u.username}@${u.domain}`),
        avatar_url: u.avatar_url,
      }))
    } catch (e) {
      debug.error('Pending donation user search failed:', e)
    }
  }, 250)
}

const resolvePending = async (pending: PendingDonation) => {
  const userId = pendingResolveUserId.value[pending.id]
  if (!userId) return
  // Tier is resolved server-side from the user's cumulative cycle total
  // (recompute_supporter_tier). No need to compute it here.
  const ok = await fundingService.resolvePendingDonation(pending.id, userId)
  if (ok) {
    toast.success('Donation attributed')
    await adminService.logAdminAction({ action: 'pending_donation_resolve', targetType: 'pending_donation', targetId: pending.id, details: { userId } })
    pendingDonations.value = pendingDonations.value.filter(p => p.id !== pending.id)
    pendingDonationCount.value = pendingDonations.value.filter(p => !p.resolved_at).length
    donationHistory.value = await fundingService.getDonationHistory()
    supporters.value = await fundingService.getSupporters()
  } else {
    toast.error('Failed to attribute donation')
  }
}

const dismissPending = async (pendingId: string) => {
  if (!(await confirm({ title: 'Dismiss donation', message: 'Dismiss this donation? It will not be attributed to any user.', confirmButtonText: 'Dismiss', dangerAction: true }))) return
  const ok = await fundingService.dismissPendingDonation(pendingId)
  if (ok) {
    toast.success('Donation dismissed')
    await adminService.logAdminAction({ action: 'pending_donation_dismiss', targetType: 'pending_donation', targetId: pendingId })
    pendingDonations.value = pendingDonations.value.filter(p => p.id !== pendingId)
    pendingDonationCount.value = pendingDonations.value.filter(p => !p.resolved_at).length
  } else {
    toast.error('Failed to dismiss')
  }
}

const addFundingLink = () => {
  if (!newLinkPlatform.value || !newLinkUrl.value) return
  fundingLinks.value.push({
    platform: newLinkPlatform.value,
    url: newLinkUrl.value,
    label: newLinkLabel.value || newLinkPlatform.value,
  })
  newLinkPlatform.value = ''
  newLinkUrl.value = ''
  newLinkLabel.value = ''
}

const saveFundingConfig = async () => {
  const success = await fundingService.updateFundingConfig({
    enabled: fundingEnabled.value,
    show_in_context_bar: fundingShowInBar.value,
    show_progress_bar: fundingShowProgress.value,
    goal_amount: fundingGoalAmount.value || null,
    goal_currency: fundingCurrency.value,
    current_amount: fundingCurrentAmount.value,
    funding_period: fundingPeriod.value,
    goal_description: fundingDescription.value || null,
    thank_you_message: fundingThankYou.value || null,
    funding_links: fundingLinks.value,
    kofi_webhook_token: kofiWebhookToken.value.trim() || null,
    kofi_auto_assign_tier: kofiAutoAssignTier.value,
  } as any)
  if (success) {
    fundingChanged.value = false
    toast.success('Funding settings saved')
  } else {
    toast.error('Failed to save funding settings')
  }
}

const addTier = async () => {
  if (!newTierName.value || !newTierMinAmount.value) return
  const tier = await fundingService.createTier({
    name: newTierName.value,
    min_amount: newTierMinAmount.value,
    badge_icon: newTierIcon.value || null,
    badge_color: newTierColor.value || null,
    perks: null,
    display_order: supporterTiers.value.length,
    removes_ads: newTierRemovesAds.value,
  })
  if (tier) {
    await adminService.logAdminAction({ action: 'tier_create', targetType: 'tier', targetId: tier.id, details: { name: tier.name } })
    supporterTiers.value.push(tier)
    newTierName.value = ''
    newTierMinAmount.value = 0
    newTierIcon.value = '⭐'
    newTierRemovesAds.value = false
    toast.success('Tier created')
  }
}

const startEditTier = (tier: SupporterTier) => {
  editingTierId.value = tier.id
  editTierName.value = tier.name
  editTierMinAmount.value = tier.min_amount
  editTierIcon.value = tier.badge_icon || '⭐'
  editTierColor.value = tier.badge_color || '#0EA5E9'
  editTierRemovesAds.value = tier.removes_ads ?? false
}

const saveEditTier = async (tierId: string) => {
  const success = await fundingService.updateTier(tierId, {
    name: editTierName.value,
    min_amount: editTierMinAmount.value,
    badge_icon: editTierIcon.value,
    badge_color: editTierColor.value,
    removes_ads: editTierRemovesAds.value,
  })
  if (success) {
    await adminService.logAdminAction({ action: 'tier_update', targetType: 'tier', targetId: tierId, details: { name: editTierName.value } })
    editingTierId.value = null
    supporterTiers.value = await fundingService.getTiers()
    toast.success('Tier updated')
  }
}

const handleNewTierEmoji = (emoji: Emoji & { display_name?: string }) => {
  newTierIcon.value = getEmojiShortcodeForInsert(emoji)
  showNewTierEmojiPicker.value = false
}

const handleEditTierEmoji = (emoji: Emoji & { display_name?: string }) => {
  editTierIcon.value = getEmojiShortcodeForInsert(emoji)
  showEditTierEmojiPicker.value = false
}

const deleteTier = async (tierId: string) => {
  if (!(await confirm({ title: 'Delete tier', message: 'Delete this tier? Supporters on this tier will keep their status but lose the tier badge.', confirmButtonText: 'Delete', dangerAction: true }))) return
  const success = await fundingService.deleteTier(tierId)
  if (success) {
    await adminService.logAdminAction({ action: 'tier_delete', targetType: 'tier', targetId: tierId })
    supporterTiers.value = supporterTiers.value.filter(t => t.id !== tierId)
    toast.success('Tier deleted')
  }
}

const onSupporterSearchInput = () => {
  addSupporterSelectedUserId.value = null
  supporterSelectedIdx.value = 0
  if (supporterSearchTimeout) clearTimeout(supporterSearchTimeout)
  const q = addSupporterSearch.value.trim()
  if (q.length < 2) {
    supporterSuggestions.value = []
    return
  }
  supporterSearchTimeout = setTimeout(async () => {
    try {
      const byKey = new Map<string, typeof supporterSuggestions.value[0]>()
      const currentDomain = (import.meta.env.VITE_DOMAIN as string || '').toLowerCase()
      const currentHost = currentDomain.split(':')[0]

      // Domain is "ours" (localhost, 127.0.0.1, or matches instance)
      const isOurDomain = (d: string | null | undefined) => {
        if (!d) return true
        const host = d.split(':')[0].toLowerCase()
        return host === 'localhost' || host === '127.0.0.1' || host === currentHost
      }

      // Canonical key: our-instance users = username only, remote = username@domain
      const canonicalKey = (username: string, domain?: string | null, isLocal?: boolean) => {
        const un = username.toLowerCase()
        if (isLocal || isOurDomain(domain)) return un
        return `${un}@${(domain || '').toLowerCase()}`
      }

      // Normalize handle to always have leading @
      const normalizeHandle = (handle: string) => {
        const h = (handle || '').trim()
        return h.startsWith('@') ? h : `@${h}`
      }

      const byId = new Set<string>()

      // Local profiles first (preferred - has proper display_name/emoji resolution)
      const { data: locals } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, domain')
        .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
        .limit(8)
      if (locals) {
        for (const u of locals) {
          const isLocal = isOurDomain(u.domain)
          const handle = isLocal ? `@${u.username}` : `@${u.username}@${u.domain}`
          const key = canonicalKey(u.username, u.domain, isLocal)
          byKey.set(key, {
            id: u.id,
            username: u.username,
            display_name: u.display_name || u.username,
            avatar_url: u.avatar_url,
            handle,
            is_local: isLocal,
          })
          byId.add(u.id)
        }
      }

      // Federated users (skip if we already have them - local + RPC both hit profiles)
      try {
        const federated = await activityPubService.searchUsers(q, 6)
        const localUsernames = new Set(Array.from(byKey.values()).filter(r => r.is_local).map(r => r.username.toLowerCase()))
        for (const f of federated) {
          const fid = f.id ?? (f as { user_id?: string }).user_id
          if (fid && byId.has(fid)) continue
          const isLocal = typeof f.is_local === 'boolean' ? f.is_local : isOurDomain(f.domain)
          const key = canonicalKey(f.username, f.domain, isLocal)
          if (byKey.has(key)) continue
          if (localUsernames.has(f.username.toLowerCase())) continue
          const rawHandle = f.handle || (isLocal ? `@${f.username}` : `@${f.username}@${f.domain || ''}`)
          byKey.set(key, {
            id: fid ?? f.id,
            username: f.username,
            display_name: f.display_name || f.username,
            avatar_url: f.avatar_url,
            handle: normalizeHandle(rawHandle),
            is_local: isLocal,
          })
          if (fid) byId.add(fid)
        }
      } catch { /* federated search may not be available */ }

      supporterSuggestions.value = Array.from(byKey.values()).slice(0, 8)
    } catch (e) {
      debug.error('Supporter search error:', e)
    }
  }, 250)
}

const selectSupporterSuggestion = (s: typeof supporterSuggestions.value[0]) => {
  addSupporterSearch.value = s.handle
  addSupporterSelectedUserId.value = s.id
  supporterSuggestions.value = []
  supporterSearchFocused.value = false
}

const onSupporterSearchKeydown = (e: KeyboardEvent) => {
  const list = supporterSuggestions.value
  if (!list.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    supporterSelectedIdx.value = (supporterSelectedIdx.value + 1) % list.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    supporterSelectedIdx.value = (supporterSelectedIdx.value - 1 + list.length) % list.length
  } else if (e.key === 'Enter' && list.length > 0) {
    e.preventDefault()
    selectSupporterSuggestion(list[supporterSelectedIdx.value])
  } else if (e.key === 'Escape') {
    supporterSuggestions.value = []
  }
}

const onSupporterSearchBlur = () => {
  setTimeout(() => { supporterSearchFocused.value = false }, 150)
}

const addNewSupporter = async () => {
  if (!addSupporterSearch.value) return

  let userId: string | undefined = addSupporterSelectedUserId.value ?? undefined
  if (!userId) {
    // Fallback: try to find by username
    const { data: users } = await supabase.from('profiles').select('id').ilike('username', addSupporterSearch.value.replace(/^@/, '')).limit(1)
    if (!users?.length) {
      toast.error('User not found')
      return
    }
    userId = users[0].id
  }

  const success = await fundingService.addSupporter(userId!, addSupporterTierId.value || undefined, addSupporterAmount.value || undefined, addSupporterPlatform.value || undefined)
  if (success) {
    await adminService.logAdminAction({ action: 'supporter_add', targetType: 'supporter', targetId: userId!, details: { username: addSupporterSearch.value } })
    supporters.value = await fundingService.getSupporters()
    addSupporterSearch.value = ''
    addSupporterSelectedUserId.value = null
    addSupporterTierId.value = ''
    addSupporterAmount.value = 0
    addSupporterPlatform.value = ''
    toast.success('Supporter added')
  }
}

const startEditSupporter = (supporter: Supporter) => {
  editingSupporterData.value = supporter
  editSupporterTierId.value = supporter.tier_id || ''
  editSupporterAmount.value = supporter.amount || 0
  editSupporterPlatform.value = supporter.platform || ''
}

const saveEditSupporter = async () => {
  if (!editingSupporterData.value) return
  const userId = editingSupporterData.value.user_id
  const success = await fundingService.updateSupporter(userId, {
    tier_id: editSupporterTierId.value || null,
    amount: editSupporterAmount.value || null,
    platform: editSupporterPlatform.value || null,
  })
  if (success) {
    await adminService.logAdminAction({ action: 'supporter_update', targetType: 'supporter', targetId: userId })
    editingSupporterData.value = null
    supporters.value = await fundingService.getSupporters()
    toast.success('Supporter updated')
  }
}

const removeSupporter = async (userId: string) => {
  if (!(await confirm({ title: 'Remove supporter', message: 'Remove this supporter?', confirmButtonText: 'Remove', dangerAction: true }))) return
  const success = await fundingService.removeSupporter(userId)
  if (success) {
    await adminService.logAdminAction({ action: 'supporter_remove', targetType: 'supporter', targetId: userId })
    supporters.value = supporters.value.filter(s => s.user_id !== userId)
    toast.success('Supporter removed')
  }
}

const openRecordDonation = (supporter: Supporter) => {
  recordDonationSupporter.value = supporter
  recordDonationAmount.value = 0
  recordDonationCurrency.value = fundingCurrency.value
  recordDonationPlatform.value = supporter.platform || ''
  recordDonationNote.value = ''
}

const saveRecordDonation = async () => {
  if (!recordDonationSupporter.value || !recordDonationAmount.value) return
  const s = recordDonationSupporter.value
  const success = await fundingService.addDonation(s.id, s.user_id, recordDonationAmount.value, recordDonationCurrency.value, recordDonationPlatform.value || undefined, recordDonationNote.value || undefined)
  if (success) {
    await adminService.logAdminAction({ action: 'donation_record', targetType: 'donation', targetId: s.user_id, details: { amount: recordDonationAmount.value, currency: recordDonationCurrency.value } })
    recordDonationSupporter.value = null
    donationHistory.value = await fundingService.getDonationHistory()
    donationStats.value = await fundingService.getDonationStats()
    toast.success('Donation recorded')
  }
}

const startEditDonation = (donation: DonationRecord) => {
  editingDonation.value = donation
  editDonationAmount.value = donation.amount
  editDonationCurrency.value = donation.currency
  editDonationPlatform.value = donation.platform || ''
  editDonationNote.value = donation.note || ''
}

const saveEditDonation = async () => {
  if (!editingDonation.value) return
  const success = await fundingService.updateDonation(editingDonation.value.id, {
    amount: editDonationAmount.value,
    currency: editDonationCurrency.value,
    platform: editDonationPlatform.value || null,
    note: editDonationNote.value || null,
  })
  if (success) {
    await adminService.logAdminAction({ action: 'donation_update', targetType: 'donation', targetId: editingDonation.value.id })
    editingDonation.value = null
    donationHistory.value = await fundingService.getDonationHistory()
    donationStats.value = await fundingService.getDonationStats()
    toast.success('Donation updated')
  }
}

const deleteDonation = async (donationId: string) => {
  if (!(await confirm({ title: 'Delete donation', message: 'Delete this donation record?', confirmButtonText: 'Delete', dangerAction: true }))) return
  const success = await fundingService.deleteDonation(donationId)
  if (success) {
    await adminService.logAdminAction({ action: 'donation_delete', targetType: 'donation', targetId: donationId })
    donationHistory.value = donationHistory.value.filter(d => d.id !== donationId)
    donationStats.value = await fundingService.getDonationStats()
    toast.success('Donation deleted')
  }
}


onMounted(() => {
  void loadFundingData()
})
</script>

<style scoped>






.setting-control-row .setting-hint {
  margin-bottom: 0;
}







.setting-row {
  display: flex;
  gap: 24px;
  align-items: center;
}







.toggle-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
}







/* Override parent label styles so toggles stay horizontal and text doesn't truncate */
.setting-group .toggle-label,
.announcement-form .form-row.checks .toggle-label {
  display: flex;
  margin-bottom: 0;
}







.toggle-label .toggle-slider {
  flex-shrink: 0;
}







.toggle-label .toggle-text {
  flex-shrink: 0;
  white-space: nowrap;
}







.toggle-label input[type="checkbox"] {
  display: none;
}







.toggle-slider {
  position: relative;
  width: 44px;
  height: 24px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  transition: all 0.2s ease;
}







.toggle-slider:before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  background: var(--text-secondary);
  border-radius: 50%;
  transition: all 0.2s ease;
}







.toggle-label input[type="checkbox"]:checked + .toggle-slider {
  background: var(--accent-color);
  border-color: var(--accent-color);
}







.toggle-label input[type="checkbox"]:checked + .toggle-slider:before {
  left: 22px;
  background: white;
}







.mod-btn {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}







.mod-btn:hover {
  border-color: var(--accent-color);
  color: var(--text-primary);
}







.save-btn {
  padding: 8px 16px;
  background: var(--accent-color);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}







.save-btn:hover {
  background: #0099cc;
  transform: translateY(-1px);
}







.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

@media (max-width: 768px) {




  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
}

@media (max-width: 480px) {



  /* Wide rows (instance lists, user rows) scroll instead of overflowing. */
  .users-list,
  .servers-list,
  .reports-list,
  .supporters-list,
  .discovery-content {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
}







.report-action-btn.danger {
  background: rgba(237, 66, 69, 0.2);
  color: #ed4245;
}







.report-action-btn.danger:hover {
  background: rgba(237, 66, 69, 0.4);
}







.report-action-buttons {
  display: flex;
  gap: 8px;
}







.report-action-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}







.report-action-btn:hover {
  opacity: 0.85;
}







.report-action-btn.investigating {
  background: rgba(14, 165, 233, 0.3);
  color: #38BDF8;
}







.report-action-btn.resolve {
  background: rgba(87, 242, 135, 0.3);
  color: #57f287;
}







.report-action-btn.dismiss {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-secondary);
}







.report-action-btn.warning {
  background: rgba(250, 166, 26, 0.2);
  color: #faa61a;
}







.report-action-btn.warning:hover {
  background: rgba(250, 166, 26, 0.4);
}







.mod-btn.warning-btn {
  background: rgba(250, 166, 26, 0.15);
  color: #faa61a;
}







.mod-btn.warning-btn:hover {
  background: rgba(250, 166, 26, 0.3);
}







/* Funding Management */
.funding-content {
  padding: 0 20px 20px;
}







.funding-section {
  margin-bottom: 24px;
  padding-top :24px;
}







.funding-section h3 {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  gap: 8px;
}







.section-badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(14, 165, 233, 0.15);
  color: var(--harmony-primary);
  text-transform: none;
  letter-spacing: 0;
  font-weight: 600;
}







.section-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 8px;
  line-height: 1.5;
}







.section-description a {
  color: var(--harmony-primary);
}







.section-hint {
  font-size: 12px;
  color: var(--text-tertiary, var(--text-secondary));
  margin: 8px 0 0;
  line-height: 1.5;
  font-style: italic;
}







.section-hint code {
  background: var(--background-secondary);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
  font-style: normal;
}







.webhook-url-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 12px;
}







.webhook-url-display code {
  flex: 1;
  color: var(--text-primary);
  word-break: break-all;
}







.pending-count-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--status-danger, #ed4245);
  color: #fff;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 700;
}







.pending-donations-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}







.pending-donation-item {
  padding: 12px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}







.pending-donation-header {
  display: flex;
  align-items: center;
  gap: 12px;
}







.pending-amount {
  font-size: 16px;
  font-weight: 700;
  color: var(--harmony-primary);
}







.pending-platform {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
  text-transform: capitalize;
}







.pending-date {
  font-size: 12px;
  color: var(--text-tertiary, var(--text-secondary));
  margin-left: auto;
}







.pending-donation-meta {
  display: flex;
  gap: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}







.pending-email {
  color: var(--text-tertiary, var(--text-secondary));
}







.pending-message {
  padding: 8px 12px;
  background: var(--background-tertiary);
  border-left: 3px solid var(--harmony-primary);
  border-radius: 4px;
  font-size: 13px;
  color: var(--text-secondary);
  font-style: italic;
}







.pending-resolve-row {
  display: flex;
  gap: 8px;
  align-items: center;
}







.pending-suggestions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 4px;
}







.pending-suggestion {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  transition: background 0.15s;
}







.pending-suggestion:hover,
.pending-suggestion.active {
  background: rgba(14, 165, 233, 0.15);
  color: var(--text-primary);
}







.funding-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}







.funding-form-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}







.funding-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 120px;
}







.funding-field label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 600;
}







.tiers-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}







.tier-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--background-tertiary);
  border-radius: 6px;
}







.tier-icon {
  font-size: 18px;
}







.tier-icon-picker {
  display: flex;
  align-items: center;
  gap: 4px;
}







.emoji-picker-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  font-size: 16px;
  padding: 2px 4px;
  cursor: pointer;
}







.tier-info {
  flex: 1;
  min-width: 0;
}







.tier-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  display: block;
}







.tier-amount {
  font-size: 12px;
  color: var(--text-secondary);
}







.add-tier-form {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  flex-wrap: wrap;
}







.add-tier-form .cyber-input {
  flex: 1;
  min-width: 100px;
}







.color-input {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-tertiary);
  cursor: pointer;
  padding: 2px;
}







.supporters-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}







.supporter-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--background-tertiary);
  border-radius: 6px;
}







.supporter-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}







.supporter-info {
  flex: 1;
  min-width: 0;
}







.supporter-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  display: block;
}







.supporter-meta {
  font-size: 12px;
  color: var(--text-secondary);
}







.donation-stats-row {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
}







.donation-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 16px;
  background: var(--background-tertiary);
  border-radius: 8px;
  flex: 1;
}







.donation-stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--accent-color);
}







.donation-stat-label {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
}







.donations-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}







.donation-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--text-secondary);
}







.donation-amount {
  font-weight: 600;
  color: var(--text-primary);
}







.donation-note {
  font-style: italic;
  opacity: 0.7;
}







.funding-links-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}







.funding-link-row {
  display: flex;
  gap: 8px;
  align-items: center;
}







.funding-link-row .cyber-input {
  min-width: 0;
}







.add-supporter-form {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  flex-wrap: wrap;
  margin-top: 12px;
}







.add-supporter-form .cyber-input {
  flex: 1;
  min-width: 100px;
}







.supporter-search-wrapper .cyber-input {
  width: 100%;
}







.supporter-suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quinary);
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  max-height: 220px;
  overflow-y: auto;
  margin-top: 4px;
}







.supporter-suggestion-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.1s ease;
}







.supporter-suggestion-item:hover,
.supporter-suggestion-item.selected {
  background: var(--harmony-primary);
}







.supporter-suggestion-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}







.supporter-suggestion-name {
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}







.supporter-suggestion-handle {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}







.supporter-suggestion-item.selected .supporter-suggestion-handle {
  color: rgba(255, 255, 255, 0.6);
}







.edit-supporter-panel {
  background: var(--background-tertiary);
  border: 1px solid var(--accent-color);
  border-radius: 8px;
  padding: 16px;
}







.edit-donation-panel {
  background: var(--background-tertiary);
  border: 1px solid var(--accent-color);
  border-radius: 8px;
  padding: 12px;
  margin-top: 8px;
}







.donation-user {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 13px;
}







.donation-actions {
  display: flex;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}







.tier-perks {
  font-size: 11px;
  color: var(--text-secondary);
  font-style: italic;
}







.tier-ads-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: pointer;
}







.tier-ads-toggle input {
  cursor: pointer;
}







.tier-adfree-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--harmony-primary, #0ea5e9);
  border: 1px solid var(--harmony-primary-alpha, rgba(14, 165, 233, 0.4));
  border-radius: 4px;
  padding: 1px 5px;
  width: fit-content;
}







.empty-hint {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 12px;
  text-align: center;
  background: var(--background-tertiary);
  border-radius: 6px;
  margin-bottom: 12px;
}
</style>

<style scoped src="./adminShared.css"></style>
