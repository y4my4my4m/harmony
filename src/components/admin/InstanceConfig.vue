<template>
<!-- Configuration -->
<div class="admin-module config-module">
  <div class="module-header">
    <Icon name="settings" :size="20" />
    <h2>Configuration</h2>
  </div>
  <div class="config-tabs">
    <button
      v-for="tab in [
        { key: 'general', label: 'General', icon: 'settings' },
        { key: 'federation', label: 'Federation', icon: 'globe' },
        { key: 'branding', label: 'Branding', icon: 'image' },
        { key: 'oauth', label: 'Authentication', icon: 'shield' },
        { key: 'webrtc', label: 'Voice & video', icon: 'mic' },
      ]"
      :key="tab.key"
      :class="['config-tab-btn', { active: configTab === tab.key }]"
      @click="configTab = tab.key as any"
    >
      <Icon :name="tab.icon" :size="16" />
      {{ tab.label }}
    </button>
  </div>
  <div class="config-sections">
    <!-- General / Chat Settings -->
    <div v-if="configTab === 'general'" class="config-section">
      <h3>Chat settings</h3>
      <div class="setting-group">
        <label>Max server size</label>
        <input v-model.number="config.chat.maxServerSize" type="number" class="cyber-input" />
      </div>
      <div class="setting-group">
        <label>Max message length</label>
        <input v-model.number="config.chat.maxMessageLength" type="number" class="cyber-input" />
      </div>
      <div class="setting-group">
        <label>Max media attachments per post/message</label>
        <input v-model.number="config.chat.maxMediaAttachmentsPerPost" type="number" class="cyber-input" min="1" />
        <span class="setting-hint">Maximum images/videos/files per post or chat message. Default: 20.</span>
      </div>
      <div class="setting-row">
        <label class="toggle-label">
          <input type="checkbox" v-model="config.chat.allowFileUploads" />
          <span class="toggle-slider"></span>
          <span class="toggle-text">Allow file uploads</span>
        </label>
        <label class="toggle-label">
          <input type="checkbox" v-model="config.chat.enableVoiceChannels" />
          <span class="toggle-slider"></span>
          <span class="toggle-text">Enable voice channels</span>
        </label>
      </div>

      <NewcomerAlertsDefault />

      <h3 style="margin-top: 24px;">Bridge attachments</h3>
      <p class="setting-hint" style="margin-bottom: 12px;">
        Instance-wide policy for bridged images/files from external platforms (Discord, etc.). Bot owners cannot override this.
      </p>
      <div class="setting-group">
        <label>Attachment handling</label>
        <select v-model="config.chat.bridgeAttachmentMode" class="cyber-input">
          <option value="link">Link only (external CDN URLs — may expire)</option>
          <option value="refresh">Refresh on demand (re-sign expired URLs when viewed; no extra disk)</option>
          <option value="mirror">Mirror to storage (permanent; uses disk — grows with traffic)</option>
        </select>
        <span class="setting-hint" v-if="config.chat.bridgeAttachmentMode === 'mirror'">
          Warning: every bridged attachment is copied into <code>message_media</code>. Busy bridged channels can consume significant storage.
        </span>
        <span class="setting-hint" v-else-if="config.chat.bridgeAttachmentMode === 'refresh'">
          Requires a connected bridge + bot-gateway. Expired attachment URLs are re-signed on demand when a user views them (no disk use, no “edited” badge).
        </span>
      </div>

      <BridgeAdminSection />

      <h3 style="margin-top: 24px;">Media picker (Klipy)</h3>
      <p class="setting-hint" style="margin-bottom: 16px;">
        GIF/media search is proxied through the federation backend. API keys live in the backend
        environment (<code>KLIPY_API_KEY_ADS</code> / <code>KLIPY_API_KEY_NOADS</code>), not here.
      </p>

      <div class="klipy-settings">
        <div class="klipy-group-label">Ads &amp; attribution</div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">GIF ads</span>
            <span class="klipy-setting-desc">
              <strong>Note:</strong> This setting only affects the mobile GIF picker. Desktop users will always not see ads.
              This is a limitation of KLIPY as an ad distributor at the moment
              <br>
              Non-supporters see Klipy ads in the mobile GIF picker; ad-free supporters never do. Klipy only
              fills ads on mobile browsers (including installed PWAs) — desktop never receives ads per their API.
              When off, nobody sees ads. Also requires an ad-enabled Klipy key and ads enabled in the Klipy
              Partner Dashboard.
              Per-tier ad-free lives under Funding &amp; Supporters.
            </span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifAdsEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">KLIPY watermark on sent media</span>
            <span class="klipy-setting-desc">
              Adds a small KLIPY badge to shared GIFs/stickers. The “Search KLIPY” picker label is always
              shown (required attribution); this watermark is optional but recommended.
            </span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifKlipyWatermarkEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-group-label">Optional collections</div>
        <p class="klipy-group-hint">
          GIFs and Stickers are always available. Enabling these adds picker tabs and slash commands; when
          off they are hidden everywhere.
        </p>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">Clips <code>/clip</code></span>
            <span class="klipy-setting-desc">Short looping videos (with optional audio).</span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifClipsEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">Memes <code>/meme</code></span>
            <span class="klipy-setting-desc">Klipy's meme collection.</span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifMemesEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">AI Emoji browse <code>/aiemoji</code></span>
            <span class="klipy-setting-desc">
              Browse Klipy's AI emoji. Picking one inserts it into the composer as an emoji (it is not
              hosted here — it behaves like a remote emoji and counts toward frequently-used).
            </span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifAiEmojisEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-group-label">AI emoji generation</div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">Allow AI emoji generation</span>
            <span class="klipy-setting-desc">
              Members generate their own custom emoji from a text prompt; these are hosted on this instance
              and appear in the emoji picker's “AI Generated” category. Klipy caps generation at 20/day per
              instance (shared) plus a per-user daily limit.
            </span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifAiEmojiGenerationEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <h3 style="margin-top: 24px;">Trending & discovery</h3>
      <div class="setting-group">
        <label>Trending posts</label>
        <div class="setting-control-row">
          <button type="button" class="primary-btn-sm refresh-trending-btn" @click="refreshTrendingPosts" :disabled="loadingStates.trendingRefresh">
            <Icon v-if="loadingStates.trendingRefresh" name="loader" :size="16" class="spin" />
            <Icon v-else name="refresh-cw" :size="16" />
            {{ loadingStates.trendingRefresh ? 'Refreshing…' : 'Refresh trending now' }}
          </button>
          <span class="setting-hint">Manually recalculate trending posts. Normally runs every 15 minutes.</span>
        </div>
      </div>

      <button @click="saveConfig" class="save-btn" :disabled="!configChanged" style="margin-top: 16px;">
        <Icon name="save" :size="16" />
        Save changes
      </button>
    </div>

    <!-- Federation Settings -->
    <div v-if="configTab === 'federation'" class="config-section">
      <h3>Federation settings</h3>
      <div class="setting-group">
        <label>Max post length</label>
        <input v-model.number="config.federation.maxPostLength" type="number" class="cyber-input" />
      </div>
      <div class="setting-group">
        <label>Delivery retry attempts</label>
        <input v-model.number="config.federation.retryAttempts" type="number" class="cyber-input" />
      </div>
      <div class="setting-group">
        <label>{{ $t('admin.instance.maxPostReactions') }}</label>
        <input
          v-model.number="config.federation.maxPostReactionsPerUser"
          type="number"
          class="cyber-input"
          min="1"
          max="100"
          data-testid="max-post-reactions-input"
        />
        <span class="setting-hint">{{ $t('admin.instance.maxPostReactionsHint') }}</span>
      </div>
      <div class="setting-group">
        <label>Max custom emojis per server</label>
        <input v-model.number="config.federation.maxCustomEmojisPerServer" type="number" class="cyber-input" min="0" />
        <span class="setting-hint">Maximum custom emojis allowed per server. 0 = unlimited.</span>
      </div>
      <div class="setting-group">
        <label>Custom emoji image quality</label>
        <input
          v-model.number="config.federation.customEmojiTransformQuality"
          type="number"
          class="cyber-input"
          min="1"
          max="100"
        />
        <span class="setting-hint">
          JPEG/WebP quality (20-100) for resized custom emoji images from storage. Default 80. Lower values reduce bandwidth at the cost of artifacts.
        </span>
      </div>
      <div class="setting-group">
        <label class="toggle-label">
          <input type="checkbox" v-model="config.federation.allowCustomEmojisInDisplayNames" />
          <span class="toggle-slider"></span>
          <span class="toggle-text">Allow custom emojis in display names</span>
        </label>
        <span class="setting-hint">
          When off, emojis won't display in names and users can't add them.
        </span>
      </div>
      <div class="setting-row">
        <label class="toggle-label">
          <input type="checkbox" v-model="config.federation.enableOutbound" />
          <span class="toggle-slider"></span>
          <span class="toggle-text">Enable outbound federation</span>
        </label>
        <label class="toggle-label">
          <input type="checkbox" v-model="config.federation.enableInbound" />
          <span class="toggle-slider"></span>
          <span class="toggle-text">Enable inbound federation</span>
        </label>
      </div>

      <button @click="saveConfig" class="save-btn" :disabled="!configChanged" style="margin-top: 16px;">
        <Icon name="save" :size="16" />
        Save changes
      </button>
    </div>

    <!-- Instance Branding -->
    <div v-if="configTab === 'branding'" class="config-section">
      <h3>Instance branding</h3>
      <div class="setting-group">
        <label>Instance name</label>
        <input 
          v-model="instanceConfig.name" 
          type="text" 
          class="cyber-input"
          placeholder="Harmony Instance"
          @input="instanceBrandingChanged = true"
        />
        <span class="setting-hint">
          This name appears on the login/register page. Changes will be visible to all users.
        </span>
      </div>
      <div class="setting-group">
        <label>Instance description</label>
        <textarea
          v-model="instanceConfig.description"
          class="cyber-input"
          rows="3"
          placeholder="A federated social platform"
          @input="instanceBrandingChanged = true"
        ></textarea>
        <span class="setting-hint">
          This description appears as the subtitle on the login/register page.
        </span>
      </div>
      <div class="setting-group">
        <label>Instance rules</label>
        <textarea
          v-model="instanceRulesText"
          class="cyber-input"
          rows="5"
          placeholder="One rule per line, e.g.&#10;Be respectful&#10;No spam"
          @input="instanceBrandingChanged = true"
        ></textarea>
        <span class="setting-hint">
          Shown once to users joining a server here, and to federated users joining via an invite link.
        </span>
      </div>

      <div class="config-subsection">
        <h4>Appearance</h4>
        <div class="setting-group">
          <label>Instance icon</label>
          <div class="instance-appearance-row">
            <div
              class="instance-icon-preview"
              @click="($refs.instanceIconInput as HTMLInputElement)?.click()"
            >
              <img
                v-if="instanceIconPreviewUrl"
                :src="instanceIconPreviewUrl"
                alt="Instance icon"
                class="instance-icon-img"
              />
              <Icon v-else name="image" :size="24" />
            </div>
            <div class="instance-appearance-controls">
              <button type="button" class="save-btn" @click="($refs.instanceIconInput as HTMLInputElement)?.click()">
                Upload icon
              </button>
              <button
                v-if="instanceConfig.iconUrl || instanceIconFile"
                type="button"
                class="save-btn"
                style="background: var(--error);"
                @click="instanceIconFile = null; instanceConfig.iconUrl = ''; instanceBrandingChanged = true"
              >
                Remove
              </button>
            </div>
          </div>
          <input
            ref="instanceIconInput"
            type="file"
            accept="image/*"
            style="display: none;"
            @change="handleInstanceIconChange"
          />
          <span class="setting-hint">
            Your instance's logo. Shown to other federated instances and in the instances directory.
          </span>
        </div>

        <div class="setting-group">
          <label>Instance banner</label>
          <div
            class="instance-banner-preview"
            :style="instanceBannerPreviewUrl ? { backgroundImage: `url(${instanceBannerPreviewUrl})` } : {}"
            @click="($refs.instanceBannerInput as HTMLInputElement)?.click()"
          >
            <div v-if="!instanceBannerPreviewUrl" class="instance-banner-placeholder">
              <Icon name="image" :size="20" />
              <span>Click to upload banner</span>
            </div>
            <div v-else class="instance-banner-overlay">
              <span>Change banner</span>
            </div>
          </div>
          <div v-if="instanceConfig.bannerUrl || instanceBannerFile" style="margin-top: 8px;">
            <button
              type="button"
              class="save-btn"
              style="background: var(--error);"
              @click="instanceBannerFile = null; instanceConfig.bannerUrl = ''; instanceBrandingChanged = true"
            >
              Remove banner
            </button>
          </div>
          <input
            ref="instanceBannerInput"
            type="file"
            accept="image/*"
            style="display: none;"
            @change="handleInstanceBannerChange"
          />
          <span class="setting-hint">
            A hero image for your instance. Shown in the instances directory and exposed via NodeInfo.
          </span>
        </div>

        <div class="setting-group">
          <label>Theme color</label>
          <div style="display: flex; align-items: center; gap: 12px;">
            <ColorPicker
              :color="instanceConfig.themeColor || '#0EA5E9'"
              @update:color="instanceConfig.themeColor = $event; instanceBrandingChanged = true"
              @change="instanceConfig.themeColor = $event; instanceBrandingChanged = true"
            />
          </div>
          <span class="setting-hint">
            Your instance's accent color. Exposed via NodeInfo for other instances to use.
          </span>
        </div>

        <div class="setting-group">
          <label>Default theme for new users</label>
          <span class="setting-hint" style="margin-bottom: 8px;">
            Import a theme JSON file (exported from Appearance settings) to set as the default for new and non-signed-in users.
          </span>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <button type="button" class="save-btn" @click="($refs.defaultThemeInput as HTMLInputElement)?.click()">
              Import theme JSON
            </button>
            <button 
              v-if="instanceConfig.defaultThemeJson"
              type="button" 
              class="delete-btn"
              @click="clearDefaultTheme"
            >
              Clear default theme
            </button>
            <span v-if="instanceConfig.defaultThemeJson" class="setting-hint" style="margin: 0;">
              Default theme is set
            </span>
          </div>
          <input
            ref="defaultThemeInput"
            type="file"
            accept=".json"
            style="display: none;"
            @change="handleDefaultThemeImport"
          />
        </div>
      </div>

      <div class="config-subsection">
        <h4>Legal & contact</h4>
        <div class="setting-group">
          <label>Terms of Service URL</label>
          <input
            v-model="instanceConfig.termsUrl"
            type="url"
            class="cyber-input"
            placeholder="https://example.com/terms"
            @input="instanceBrandingChanged = true"
          />
          <span class="setting-hint">
            Link to your Terms of Service. Shown on the registration page. Leave empty to hide.
          </span>
        </div>
        <div class="setting-group">
          <label>Privacy Policy URL</label>
          <input
            v-model="instanceConfig.privacyUrl"
            type="url"
            class="cyber-input"
            placeholder="https://example.com/privacy"
            @input="instanceBrandingChanged = true"
          />
          <span class="setting-hint">
            Link to your Privacy Policy. Shown on the registration page. Leave empty to hide.
          </span>
        </div>
        <div class="setting-group">
          <label>Maintainer name</label>
          <input
            v-model="instanceConfig.maintainerName"
            type="text"
            class="cyber-input"
            placeholder="Admin"
            @input="instanceBrandingChanged = true"
          />
          <span class="setting-hint">
            Public contact name for this instance's administrator.
          </span>
        </div>
        <div class="setting-group">
          <label>Maintainer email</label>
          <input
            v-model="instanceConfig.maintainerEmail"
            type="email"
            class="cyber-input"
            placeholder="admin@example.com"
            @input="instanceBrandingChanged = true"
          />
          <span class="setting-hint">
            Public contact email. Exposed via NodeInfo for federation transparency.
          </span>
        </div>
      </div>

      <button 
        @click="saveInstanceBranding" 
        class="save-btn" 
        :disabled="!instanceBrandingChanged || savingBranding"
        style="margin-top: 16px;"
      >
        <Icon name="save" :size="16" />
        {{ savingBranding ? 'Saving…' : 'Save branding' }}
      </button>
    </div>

    <!-- OAuth Providers -->
    <div v-if="configTab === 'oauth'" class="config-section">
      <h3>OAuth providers</h3>
      <p class="setting-hint" style="margin-bottom: 16px;">
        Enable or disable OAuth login providers. When disabled, the provider will not appear on the login/register page.
      </p>
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <label class="toggle-label" style="justify-content: space-between; width: 100%;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-weight: 500;">Google</span>
            <span style="font-size: 12px; color: var(--text-secondary);">Allow users to sign in with Google</span>
          </div>
          <input 
            type="checkbox" 
            v-model="oauthProviders.google"
            @change="oauthProvidersChanged = true"
          />
          <span class="toggle-slider"></span>
        </label>
        <label class="toggle-label" style="justify-content: space-between; width: 100%;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-weight: 500;">Twitch</span>
            <span style="font-size: 12px; color: var(--text-secondary);">Allow users to sign in with Twitch</span>
          </div>
          <input 
            type="checkbox" 
            v-model="oauthProviders.twitch"
            @change="oauthProvidersChanged = true"
          />
          <span class="toggle-slider"></span>
        </label>
        <label class="toggle-label" style="justify-content: space-between; width: 100%;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-weight: 500;">GitHub</span>
            <span style="font-size: 12px; color: var(--text-secondary);">Allow users to sign in with GitHub</span>
          </div>
          <input 
            type="checkbox" 
            v-model="oauthProviders.github"
            @change="oauthProvidersChanged = true"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <button 
        @click="saveOAuthProviders" 
        class="save-btn" 
        :disabled="!oauthProvidersChanged || savingOAuthProviders"
        style="margin-top: 16px;"
      >
        <Icon name="save" :size="16" />
        {{ savingOAuthProviders ? 'Saving…' : 'Save OAuth settings' }}
      </button>
    </div>

    <!-- WebRTC / Voice Settings -->
    <div v-if="configTab === 'webrtc'" class="config-section">
      <h3>WebRTC / voice settings</h3>
      <div class="setting-group">
        <label>WebRTC mode</label>
        <select v-model="config.webrtc.mode" class="cyber-input">
          <option value="hybrid">Hybrid (SFU when configured, else P2P)</option>
          <option value="sfu">SFU only (LiveKit)</option>
          <option value="p2p">P2P only (peer-to-peer)</option>
        </select>
        <span class="setting-hint">
          Hybrid uses the LiveKit server when one is configured and P2P otherwise. Every participant of a call uses the same transport.
        </span>
      </div>
      <div class="setting-group">
        <label>LiveKit server URL</label>
        <input 
          v-model="config.webrtc.livekitUrl" 
          type="text" 
          class="cyber-input"
          placeholder="wss://livekit.yourdomain.com"
        />
        <span class="setting-hint">
          WebSocket URL for the LiveKit server (configured in backend .env)
        </span>
      </div>
      <div class="setting-group">
        <label>Max stage listeners</label>
        <input 
          v-model.number="config.webrtc.maxStageListeners" 
          type="number" 
          class="cyber-input"
        />
        <span class="setting-hint">
          Maximum audience size for stage events (speaker mode)
        </span>
      </div>
      <div class="setting-row">
        <label class="toggle-label">
          <input type="checkbox" v-model="config.webrtc.allowFederatedVoice" />
          <span class="toggle-slider"></span>
          Allow federated voice calls
          <span class="setting-hint-inline">
            Enable voice/video calls with users from other instances
          </span>
        </label>
      </div>

      <button @click="saveConfig" class="save-btn" :disabled="!configChanged" style="margin-top: 16px;">
        <Icon name="save" :size="16" />
        Save changes
      </button>
    </div>
  </div>
</div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import Icon from '@/components/common/Icon.vue'
import ColorPicker from '@/components/common/ColorPicker.vue'
import NewcomerAlertsDefault from '@/components/admin/NewcomerAlertsDefault.vue'
import BridgeAdminSection from '@/components/settings/discord-bridge/BridgeAdminSection.vue'
import { adminService } from '@/services/AdminService'
import { trendingService } from '@/services/TrendingService'
import { supabase } from '@/supabase'
import { humanizeUploadError, imageSourceError } from '@/utils/uploadValidation'
import { uploadImageObject } from '@/utils/fileUpload'
import { runtimeConfig } from '@/services/runtimeConfig'

const authStore = useAuthStore()
const toast = useToast()

const loadingStates = ref({ trendingRefresh: false })

const refreshTrendingPosts = async () => {
  loadingStates.value.trendingRefresh = true
  try {
    await trendingService.updateTrendingScores()
    toast.success('Trending posts refreshed')
  } catch (error) {
    debug.error('Failed to refresh trending:', error)
    toast.error('Failed to refresh trending posts')
  } finally {
    loadingStates.value.trendingRefresh = false
  }
}

const configChanged = ref(false)
const instanceBrandingChanged = ref(false)
const savingBranding = ref(false)
const configTab = ref<'general' | 'federation' | 'branding' | 'oauth' | 'webrtc'>('general')
// Instance configuration
const instanceConfig = ref({
  name: 'Harmony Instance',
  domain: runtimeConfig.domain as string,
  description: 'A federated social platform',
  termsUrl: '',
  privacyUrl: '',
  openRegistration: true,
  approvalRequired: false,
  iconUrl: '',
  bannerUrl: '',
  themeColor: '#0EA5E9',
  maintainerName: '',
  maintainerEmail: '',
  defaultThemeJson: '' as string,
})
const instanceIconFile = ref<File | null>(null)
const instanceBannerFile = ref<File | null>(null)
// One rule per line in the editor; persisted as a jsonb string array
const instanceRulesText = ref('')

// OAuth provider configuration
const oauthProviders = ref({
  google: false,
  twitch: false,
  github: false
})
const oauthProvidersChanged = ref(false)
const savingOAuthProviders = ref(false)
// Configuration
const config = ref({
  chat: {
    maxServerSize: 1000,
    maxMessageLength: 2000,
    maxMediaAttachmentsPerPost: 20,
    allowFileUploads: true,
    enableVoiceChannels: true,
    gifAdsEnabled: true,
    gifKlipyWatermarkEnabled: true,
    gifClipsEnabled: false,
    gifMemesEnabled: false,
    gifAiEmojisEnabled: false,
    gifAiEmojiGenerationEnabled: false,
    bridgeAttachmentMode: 'link' as 'link' | 'refresh' | 'mirror',
  },
  federation: {
    maxPostLength: 500,
    retryAttempts: 3,
    maxCustomEmojisPerServer: 0,
    customEmojiTransformQuality: 80,
    allowCustomEmojisInDisplayNames: true,
    maxPostReactionsPerUser: 10,
    enableOutbound: true,
    enableInbound: true
  },
  webrtc: {
    mode: 'hybrid' as 'sfu' | 'p2p' | 'hybrid',
    livekitUrl: '',
    allowFederatedVoice: true,
    maxStageListeners: 100000
  }
})

// Watch for config changes
watch(config, () => {
  configChanged.value = true
}, { deep: true })

const loadInstanceConfig = async () => {
  try {
    const cfg = await adminService.getInstanceConfig()
    if (cfg) {
      if (cfg.chat) {
        config.value.chat = { ...config.value.chat, ...cfg.chat }
      }
      if (cfg.federation) {
        config.value.federation = { ...config.value.federation, ...cfg.federation }
      }
      if (cfg.webrtc) {
        config.value.webrtc = { ...config.value.webrtc, ...cfg.webrtc }
      }
    }
    if (cfg?.instance) {
      instanceConfig.value = {
        name: cfg.instance.name || 'Harmony Instance',
        domain: cfg.instance.domain || runtimeConfig.domain as string,
        description: cfg.instance.description || 'A federated social platform',
        termsUrl: cfg.instance.termsUrl || '',
        privacyUrl: cfg.instance.privacyUrl || '',
        openRegistration: cfg.instance.registrationOpen ?? true,
        approvalRequired: cfg.instance.requiresApproval ?? false,
        iconUrl: cfg.instance.iconUrl || '',
        bannerUrl: cfg.instance.bannerUrl || '',
        themeColor: cfg.instance.themeColor || '#0EA5E9',
        maintainerName: cfg.instance.maintainerName || '',
        maintainerEmail: cfg.instance.maintainerEmail || '',
        defaultThemeJson: cfg.instance.defaultThemeJson || '',
      }
      instanceRulesText.value = (cfg.instance.rules || []).join('\n')

      if (cfg.instance.oauthProviders) {
        const providers = cfg.instance.oauthProviders
        if (Array.isArray(providers)) {
          // If it's an array like ["google", "github"]
          oauthProviders.value = {
            google: providers.includes('google'),
            twitch: providers.includes('twitch'),
            github: providers.includes('github')
          }
        } else if (typeof providers === 'object' && providers !== null) {
          // If it's an object like { google: true, twitch: false }
          oauthProviders.value = {
            google: providers.google === true || providers.google === 'true',
            twitch: providers.twitch === true || providers.twitch === 'true',
            github: providers.github === true || providers.github === 'true'
          }
        }
      } else {
        // If no config or empty, all providers are disabled
        oauthProviders.value = {
          google: false,
          twitch: false,
          github: false
        }
      }
      oauthProvidersChanged.value = false
    }
  } catch (error) {
    debug.error('Failed to load instance config:', error)
    // Keep defaults if loading fails
  }
}


const saveConfig = async () => {
  if (!authStore.session?.user?.id) {
    toast.error('You must be logged in to save configuration')
    return
  }

  try {
    const userId = authStore.session.user.id
    
    const fedSuccess = await adminService.updateFederationSettings({
      userId,
      inboundEnabled: config.value.federation.enableInbound,
      outboundEnabled: config.value.federation.enableOutbound,
      federationEnabled: config.value.federation.enableInbound || config.value.federation.enableOutbound
    })

    if (!fedSuccess) {
      toast.error('Failed to save federation settings')
      return
    }

    await adminService.setInstanceConfigs({
      max_server_size: config.value.chat.maxServerSize,
      max_message_length: config.value.chat.maxMessageLength,
      max_media_attachments_per_post: config.value.chat.maxMediaAttachmentsPerPost ?? 20,
      allow_file_uploads: config.value.chat.allowFileUploads,
      enable_voice_channels: config.value.chat.enableVoiceChannels,
      bridge_attachment_mode: config.value.chat.bridgeAttachmentMode,
      gif_ads_enabled: config.value.chat.gifAdsEnabled,
      gif_klipy_watermark_enabled: config.value.chat.gifKlipyWatermarkEnabled,
      gif_clips_enabled: config.value.chat.gifClipsEnabled,
      gif_memes_enabled: config.value.chat.gifMemesEnabled,
      gif_ai_emojis_enabled: config.value.chat.gifAiEmojisEnabled,
      gif_ai_emoji_generation_enabled: config.value.chat.gifAiEmojiGenerationEnabled,
      max_post_length: config.value.federation.maxPostLength,
      federation_retry_attempts: config.value.federation.retryAttempts,
      max_custom_emojis_per_server: config.value.federation.maxCustomEmojisPerServer ?? 0,
      custom_emoji_transform_quality: Math.min(
        100,
        Math.max(1, Math.round(Number(config.value.federation.customEmojiTransformQuality) || 100))
      ),
      allow_custom_emojis_in_display_names: config.value.federation.allowCustomEmojisInDisplayNames,
      max_post_reactions_per_user: Math.min(
        100,
        Math.max(1, Math.round(Number(config.value.federation.maxPostReactionsPerUser) || 10))
      ),
    }, userId)

    await adminService.updateWebRTCSettings({
      mode: config.value.webrtc.mode,
      livekitUrl: config.value.webrtc.livekitUrl,
      allowFederatedVoice: config.value.webrtc.allowFederatedVoice,
      maxStageListeners: config.value.webrtc.maxStageListeners
    })

    configChanged.value = false
    toast.success('Configuration saved')
    debug.log('Configuration saved:', config.value)
    
    const instanceSettings = useInstanceSettingsStore()
    await instanceSettings.fetchSettings(true)
  } catch (error: any) {
    debug.error('Failed to save configuration:', error)
    toast.error(error.message || 'Failed to save configuration')
  }
}

// Refs, not computeds: the superseded file's object URL must be revoked.
const instanceIconPreviewUrl = ref<string | null>(null)
const instanceBannerPreviewUrl = ref<string | null>(null)

let instanceIconObjectUrl: string | null = null
let instanceBannerObjectUrl: string | null = null

watch([instanceIconFile, () => instanceConfig.value.iconUrl], () => {
  if (instanceIconObjectUrl) {
    URL.revokeObjectURL(instanceIconObjectUrl)
    instanceIconObjectUrl = null
  }

  if (instanceIconFile.value) {
    instanceIconObjectUrl = URL.createObjectURL(instanceIconFile.value)
    instanceIconPreviewUrl.value = instanceIconObjectUrl
  } else if (instanceConfig.value.iconUrl) {
    if (instanceConfig.value.iconUrl.startsWith('http')) {
      instanceIconPreviewUrl.value = instanceConfig.value.iconUrl
    } else {
      const { data } = supabase.storage.from('server_icons').getPublicUrl(instanceConfig.value.iconUrl)
      instanceIconPreviewUrl.value = data.publicUrl
    }
  } else {
    instanceIconPreviewUrl.value = null
  }
}, { immediate: true })

watch([instanceBannerFile, () => instanceConfig.value.bannerUrl], () => {
  if (instanceBannerObjectUrl) {
    URL.revokeObjectURL(instanceBannerObjectUrl)
    instanceBannerObjectUrl = null
  }

  if (instanceBannerFile.value) {
    instanceBannerObjectUrl = URL.createObjectURL(instanceBannerFile.value)
    instanceBannerPreviewUrl.value = instanceBannerObjectUrl
  } else if (instanceConfig.value.bannerUrl) {
    if (instanceConfig.value.bannerUrl.startsWith('http')) {
      instanceBannerPreviewUrl.value = instanceConfig.value.bannerUrl
    } else {
      const { data } = supabase.storage.from('server_banners').getPublicUrl(instanceConfig.value.bannerUrl)
      instanceBannerPreviewUrl.value = data.publicUrl
    }
  } else {
    instanceBannerPreviewUrl.value = null
  }
}, { immediate: true })

onUnmounted(() => {
  if (instanceIconObjectUrl) {
    URL.revokeObjectURL(instanceIconObjectUrl)
    instanceIconObjectUrl = null
  }
  if (instanceBannerObjectUrl) {
    URL.revokeObjectURL(instanceBannerObjectUrl)
    instanceBannerObjectUrl = null
  }
})

const handleInstanceIconChange = (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const iconSourceError = file && imageSourceError(file)
  if (iconSourceError) {
    toast.error(iconSourceError)
    return
  }
  if (file) {
    instanceIconFile.value = file
    instanceBrandingChanged.value = true
  }
  if (input) input.value = ''
}

const handleInstanceBannerChange = (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const bannerSourceError = file && imageSourceError(file)
  if (bannerSourceError) {
    toast.error(bannerSourceError)
    return
  }
  if (file) {
    instanceBannerFile.value = file
    instanceBrandingChanged.value = true
  }
  if (input) input.value = ''
}

const saveInstanceBranding = async () => {
  if (!authStore.session?.user?.id) {
    toast.error('You must be logged in to save instance branding')
    return
  }

  savingBranding.value = true
  try {
    // Upload icon if a new file was selected
    if (instanceIconFile.value) {
      const icon = await uploadImageObject(instanceIconFile.value, 'server_icon', 'server_icons', 'instance', 'icon')
      if (!icon.success || !icon.url) {
        toast.error(icon.error || humanizeUploadError(null, 'server_icons'))
        savingBranding.value = false
        return
      }
      instanceConfig.value.iconUrl = icon.url
      instanceIconFile.value = null
    }

    // Upload banner if a new file was selected
    if (instanceBannerFile.value) {
      const banner = await uploadImageObject(instanceBannerFile.value, 'server_banner', 'server_banners', 'instance', 'banner')
      if (!banner.success || !banner.url) {
        toast.error(banner.error || humanizeUploadError(null, 'server_banners'))
        savingBranding.value = false
        return
      }
      instanceConfig.value.bannerUrl = banner.url
      instanceBannerFile.value = null
    }

    // Batch-save all branding config in a single RPC call
    await adminService.setInstanceConfigs({
      instance_name: instanceConfig.value.name,
      instance_description: instanceConfig.value.description,
      instance_rules: instanceRulesText.value
        .split('\n')
        .map((line) => line.trim().slice(0, 300))
        .filter((line) => line.length > 0)
        .slice(0, 25),
      terms_url: instanceConfig.value.termsUrl,
      privacy_url: instanceConfig.value.privacyUrl,
      instance_icon: instanceConfig.value.iconUrl,
      instance_banner: instanceConfig.value.bannerUrl,
      theme_color: instanceConfig.value.themeColor,
      maintainer_name: instanceConfig.value.maintainerName,
      maintainer_email: instanceConfig.value.maintainerEmail,
    }, authStore.session.user.id)

    instanceBrandingChanged.value = false
    toast.success('Instance branding saved')
    debug.log('Instance branding saved:', instanceConfig.value)
  } catch (error: any) {
    debug.error('Failed to save instance branding:', error)
    toast.error(error.message || 'Failed to save instance branding')
  } finally {
    savingBranding.value = false
  }
}

const handleDefaultThemeImport = async (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') {
      toast.error('Invalid theme JSON file')
      return
    }
    instanceConfig.value.defaultThemeJson = text
    instanceBrandingChanged.value = true

    if (authStore.session?.user?.id) {
      await adminService.setInstanceConfigs({
        default_theme_json: text,
      }, authStore.session.user.id)
      toast.success('Default theme imported and saved')
    }
  } catch {
    toast.error('Failed to parse theme JSON file')
  }
  const input = event.target as HTMLInputElement
  if (input) input.value = ''
}

const clearDefaultTheme = async () => {
  instanceConfig.value.defaultThemeJson = ''
  instanceBrandingChanged.value = true
  if (authStore.session?.user?.id) {
    try {
      await adminService.setInstanceConfigs({
        default_theme_json: '',
      }, authStore.session.user.id)
      toast.success('Default theme cleared')
    } catch {
      toast.error('Failed to clear default theme')
    }
  }
}

const saveOAuthProviders = async () => {
  if (!authStore.session?.user?.id) {
    toast.error('You must be logged in to save OAuth provider settings')
    return
  }

  savingOAuthProviders.value = true
  try {
    const enabledProviders: string[] = []
    if (oauthProviders.value.google) enabledProviders.push('google')
    if (oauthProviders.value.twitch) enabledProviders.push('twitch')
    if (oauthProviders.value.github) enabledProviders.push('github')

    await adminService.setInstanceConfig(
      'oauth_providers',
      enabledProviders, // Pass as array, Supabase will convert to JSONB
      authStore.session.user.id,
      'Enabled OAuth providers'
    )

    oauthProvidersChanged.value = false
    toast.success('OAuth provider settings saved')
    debug.log('OAuth providers saved:', enabledProviders)
  } catch (error: any) {
    debug.error('Failed to save OAuth provider settings:', error)
    toast.error(error.message || 'Failed to save OAuth provider settings')
  } finally {
    savingOAuthProviders.value = false
  }
}


onMounted(() => {
  void loadInstanceConfig()
})
</script>

<style scoped>






.setting-group {
  margin-bottom: 16px;
}







.setting-group label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}







.setting-control-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}







.setting-control-row .setting-hint {
  margin-bottom: 0;
}







.refresh-trending-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}







.refresh-trending-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
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
  border-radius: var(--radius-full);
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
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
}







.toggle-label input[type="checkbox"]:checked + .toggle-slider:before {
  left: 22px;
  background: var(--text-on-primary);
}







/* Klipy media-picker settings: one self-documented row per toggle. */
.klipy-settings {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 8px 16px 16px;
  background: var(--background-secondary-alpha);
}







.klipy-group-label {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border-secondary);
}







.klipy-settings > .klipy-group-label:first-child {
  margin-top: 4px;
  padding-top: 0;
  border-top: none;
}







.klipy-group-hint {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
  margin: 0 0 4px;
}







.klipy-setting {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-secondary);
}







.klipy-setting:last-child {
  border-bottom: none;
}







.klipy-setting-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}







.klipy-setting-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}







.klipy-setting-title code {
  font-size: 11.5px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  color: var(--text-secondary);
}







.klipy-setting-desc {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-secondary);
}







.klipy-toggle {
  flex-shrink: 0;
  margin-top: 2px;
}







.delete-btn:hover {
  border-color: var(--error);
  color: var(--error);
}







/* Configuration Module */
.config-tabs {
  display: flex;
  gap: 4px;
  padding: 12px 24px 0;
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
}

.config-tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.config-tab-btn:hover {
  color: var(--text-primary);
  background: var(--background-tertiary);
  border-radius: var(--radius-base) var(--radius-base) 0 0;
}

.config-tab-btn.active {
  color: var(--harmony-primary);
  border-bottom-color: var(--harmony-primary);
}






.config-sections {
  padding: 24px;
}







.config-section {
  margin-bottom: 0;
}







.config-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-primary);
}







.config-subsection {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--border-color);
}







.config-subsection h4 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 14px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}







/* Instance appearance (icon/banner) */
.instance-appearance-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 8px;
}







.instance-icon-preview {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-lg);
  background: var(--background-tertiary);
  border: 2px dashed var(--border-color);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  flex-shrink: 0;
  transition: border-color 0.2s;
  color: var(--text-secondary);
}







.instance-icon-preview:hover {
  border-color: var(--harmony-primary);
}







.instance-icon-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}







.instance-appearance-controls {
  display: flex;
  gap: 8px;
}







.instance-banner-preview {
  width: 100%;
  height: 100px;
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
  background-size: cover;
  background-position: center;
  border: 2px dashed var(--border-color);
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: border-color 0.2s;
}







.instance-banner-preview:hover {
  border-color: var(--harmony-primary);
}







.instance-banner-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-secondary);
  font-size: 13px;
}







.instance-banner-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 14px;
  font-weight: 500;
  opacity: 0;
  transition: opacity 0.2s;
}







.instance-banner-preview:hover .instance-banner-overlay {
  opacity: 1;
}







.save-btn {
  padding: 8px 16px;
  background: var(--harmony-primary);
  border: none;
  border-radius: var(--radius-base);
  color: var(--text-on-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}







.save-btn:hover {
  background: var(--harmony-primary-hover);
}







.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 768px) {




  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
}
</style>

<style scoped src="./adminShared.css"></style>
