<template>
<!-- Configuration -->
<div class="admin-module config-module">
  <div class="module-header">
    <Icon name="settings" :size="20" />
    <h2>{{ t('admin.instance.title') }}</h2>
  </div>
  <div class="config-tabs">
    <button
      v-for="tab in [
        { key: 'general', label: t('admin.instance.tabGeneral'), icon: 'settings' },
        { key: 'federation', label: t('admin.instance.tabFederation'), icon: 'globe' },
        { key: 'branding', label: t('admin.instance.tabBranding'), icon: 'image' },
        { key: 'oauth', label: t('admin.instance.tabAuth'), icon: 'shield' },
        { key: 'webrtc', label: t('settings.voice.title'), icon: 'mic' },
        { key: 'uploads', label: t('uploadLimits.title'), icon: 'upload' },
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
    <p v-if="configLoadFailed" class="setting-hint federation-closed-warning" style="margin-bottom: 16px;" role="status" data-testid="config-load-failed">
      {{ t('admin.instance.configLoadFailed') }}
    </p>

    <!-- General / Chat Settings -->
    <fieldset v-if="configTab === 'general'" class="config-section" :disabled="!configLoaded">
      <h3>{{ t('admin.instance.chatSettings') }}</h3>
      <div class="setting-group">
        <label>{{ t('admin.instance.maxServerSize') }}</label>
        <input v-model.number="config.chat.maxServerSize" type="number" class="cyber-input" />
      </div>
      <div v-if="limitsSupported" class="setting-group">
        <label>{{ t('admin.instance.maxServersPerUser') }}</label>
        <input v-model.number="config.chat.maxServersPerUser" type="number" min="0" class="cyber-input" data-testid="config-max-servers-per-user" />
        <span class="setting-hint">{{ t('admin.instance.maxServersPerUserHint') }}</span>
      </div>
      <div v-if="limitsSupported" class="setting-group">
        <label>{{ t('admin.instance.maxBotsPerUser') }}</label>
        <input v-model.number="config.chat.maxBotsPerUser" type="number" min="0" class="cyber-input" data-testid="config-max-bots-per-user" />
        <span class="setting-hint">{{ t('admin.instance.maxBotsPerUserHint') }}</span>
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.maxMessageLength') }}</label>
        <input v-model.number="config.chat.maxMessageLength" type="number" class="cyber-input" />
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.maxMediaAttachments') }}</label>
        <input v-model.number="config.chat.maxMediaAttachmentsPerPost" type="number" class="cyber-input" min="1" />
        <span class="setting-hint">{{ t('admin.instance.maxMediaAttachmentsHint') }}</span>
      </div>
      <div class="setting-row">
        <label class="toggle-label">
          <input type="checkbox" v-model="config.chat.allowFileUploads" />
          <span class="toggle-slider"></span>
          <span class="toggle-text">{{ t('admin.instance.allowFileUploads') }}</span>
        </label>
        <label class="toggle-label">
          <input type="checkbox" v-model="config.chat.enableVoiceChannels" />
          <span class="toggle-slider"></span>
          <span class="toggle-text">{{ t('admin.instance.enableVoiceChannels') }}</span>
        </label>
      </div>

      <NewcomerAlertsDefault />

      <h3 style="margin-top: 24px;">{{ t('admin.instance.bridgeAttachmentsTitle') }}</h3>
      <p class="setting-hint" style="margin-bottom: 12px;">
        {{ t('admin.instance.bridgeAttachmentsHint') }}
      </p>
      <div class="setting-group">
        <label>{{ t('admin.instance.attachmentHandling') }}</label>
        <select v-model="config.chat.bridgeAttachmentMode" class="cyber-input">
          <option value="link">{{ t('admin.instance.attachmentModeLink') }}</option>
          <option value="refresh">{{ t('admin.instance.attachmentModeRefresh') }}</option>
          <option value="mirror">{{ t('admin.instance.attachmentModeMirror') }}</option>
        </select>
        <i18n-t v-if="config.chat.bridgeAttachmentMode === 'mirror'" keypath="admin.instance.attachmentMirrorWarning" scope="global" tag="span" class="setting-hint">
          <template #table><code>message_media</code></template>
        </i18n-t>
        <span v-if="config.chat.bridgeAttachmentMode === 'mirror' && mirrorStatusText" class="setting-hint" data-testid="mirror-status" role="status">
          {{ mirrorStatusText }}
        </span>
        <span class="setting-hint" v-else-if="config.chat.bridgeAttachmentMode === 'refresh'">
          {{ t('admin.instance.attachmentRefreshHint') }}
        </span>
      </div>

      <BridgeAdminSection />

      <MatrixAdminSection />

      <h3 style="margin-top: 24px;">{{ t('admin.instance.klipyTitle') }}</h3>
      <i18n-t keypath="admin.instance.klipyHint" scope="global" tag="p" class="setting-hint" style="margin-bottom: 16px;">
        <template #ads><code>KLIPY_API_KEY_ADS</code></template>
        <template #noads><code>KLIPY_API_KEY_NOADS</code></template>
      </i18n-t>

      <div class="klipy-settings">
        <div class="klipy-group-label">{{ t('admin.instance.klipyAdsGroup') }}</div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">{{ t('admin.instance.gifAdsTitle') }}</span>
            <span class="klipy-setting-desc">
              <i18n-t keypath="admin.instance.gifAdsNote" scope="global" tag="span">
                <template #note><strong>{{ t('admin.instance.gifAdsNoteLabel') }}</strong></template>
              </i18n-t>
              <br>
              {{ t('admin.instance.gifAdsDesc') }}
            </span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifAdsEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">{{ t('admin.instance.klipyWatermarkTitle') }}</span>
            <span class="klipy-setting-desc">{{ t('admin.instance.klipyWatermarkDesc') }}</span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifKlipyWatermarkEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-group-label">{{ t('admin.instance.optionalCollections') }}</div>
        <p class="klipy-group-hint">{{ t('admin.instance.optionalCollectionsHint') }}</p>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">{{ t('admin.instance.clipsTitle') }} <code>/clip</code></span>
            <span class="klipy-setting-desc">{{ t('admin.instance.clipsDesc') }}</span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifClipsEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">{{ t('admin.instance.memesTitle') }} <code>/meme</code></span>
            <span class="klipy-setting-desc">{{ t('admin.instance.memesDesc') }}</span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifMemesEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">{{ t('admin.instance.aiEmojiBrowseTitle') }} <code>/aiemoji</code></span>
            <span class="klipy-setting-desc">{{ t('admin.instance.aiEmojiBrowseDesc') }}</span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifAiEmojisEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="klipy-group-label">{{ t('admin.instance.aiEmojiGenGroup') }}</div>

        <div class="klipy-setting">
          <div class="klipy-setting-text">
            <span class="klipy-setting-title">{{ t('admin.instance.aiEmojiGenTitle') }}</span>
            <span class="klipy-setting-desc">{{ t('admin.instance.aiEmojiGenDesc') }}</span>
          </div>
          <label class="toggle-label klipy-toggle">
            <input type="checkbox" v-model="config.chat.gifAiEmojiGenerationEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <h3 style="margin-top: 24px;">{{ t('admin.instance.trendingTitle') }}</h3>
      <div class="setting-group">
        <label>{{ t('admin.instance.trendingPosts') }}</label>
        <div class="setting-control-row">
          <button type="button" class="primary-btn-sm refresh-trending-btn" @click="refreshTrendingPosts" :disabled="loadingStates.trendingRefresh">
            <Icon v-if="loadingStates.trendingRefresh" name="loader" :size="16" class="spin" />
            <Icon v-else name="refresh-cw" :size="16" />
            {{ loadingStates.trendingRefresh ? t('admin.instance.refreshing') : t('admin.instance.refreshTrending') }}
          </button>
          <span class="setting-hint">{{ t('admin.instance.refreshTrendingHint') }}</span>
        </div>
      </div>

      <button @click="saveConfig" class="save-btn" :disabled="!configChanged" style="margin-top: 16px;">
        <Icon name="save" :size="16" />
        {{ t('server.saveChanges') }}
      </button>
    </fieldset>

    <!-- Federation Settings -->
    <fieldset v-if="configTab === 'federation'" class="config-section" :disabled="!configLoaded">
      <h3>{{ t('admin.instance.federationSettings') }}</h3>
      <div class="setting-group">
        <label>{{ t('admin.instance.maxPostLength') }}</label>
        <input v-model.number="config.federation.maxPostLength" type="number" class="cyber-input" />
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.retryAttempts') }}</label>
        <input v-model.number="config.federation.retryAttempts" type="number" class="cyber-input" />
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.maxPostReactions') }}</label>
        <input
          v-model.number="config.federation.maxPostReactionsPerUser"
          type="number"
          class="cyber-input"
          min="1"
          max="100"
          data-testid="max-post-reactions-input"
        />
        <span class="setting-hint">{{ t('admin.instance.maxPostReactionsHint') }}</span>
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.maxCustomEmojis') }}</label>
        <input v-model.number="config.federation.maxCustomEmojisPerServer" type="number" class="cyber-input" min="0" />
        <span class="setting-hint">{{ t('admin.instance.maxCustomEmojisHint') }}</span>
      </div>
      <div class="setting-group">
        <label for="max-personal-emojis">{{ t('admin.instance.maxPersonalEmojis') }}</label>
        <input
          id="max-personal-emojis"
          v-model.number="config.federation.maxPersonalEmojisPerUser"
          type="number"
          class="cyber-input"
          min="0"
          max="1000"
          aria-describedby="max-personal-emojis-hint"
          data-testid="max-personal-emojis-input"
        />
        <span id="max-personal-emojis-hint" class="setting-hint">{{ t('admin.instance.maxPersonalEmojisHint') }}</span>
      </div>
      <div class="setting-group">
        <label for="max-stickers-per-server">{{ t('admin.instance.maxStickersPerServer') }}</label>
        <input
          id="max-stickers-per-server"
          v-model.number="config.federation.maxStickersPerServer"
          type="number"
          class="cyber-input"
          min="0"
          max="100"
          aria-describedby="max-stickers-per-server-hint"
          data-testid="max-stickers-per-server-input"
        />
        <span id="max-stickers-per-server-hint" class="setting-hint">{{ t('admin.instance.maxStickersPerServerHint') }}</span>
      </div>
      <div class="setting-group">
        <label for="max-instance-stickers">{{ t('admin.instance.maxInstanceStickers') }}</label>
        <input
          id="max-instance-stickers"
          v-model.number="config.federation.maxInstanceStickers"
          type="number"
          class="cyber-input"
          min="0"
          max="500"
          aria-describedby="max-instance-stickers-hint"
          data-testid="max-instance-stickers-input"
        />
        <span id="max-instance-stickers-hint" class="setting-hint">{{ t('admin.instance.maxInstanceStickersHint') }}</span>
      </div>
      <div class="setting-group">
        <label for="max-personal-stickers">{{ t('admin.instance.maxPersonalStickers') }}</label>
        <input
          id="max-personal-stickers"
          v-model.number="config.federation.maxPersonalStickersPerUser"
          type="number"
          class="cyber-input"
          min="0"
          max="100"
          aria-describedby="max-personal-stickers-hint"
          data-testid="max-personal-stickers-input"
        />
        <span id="max-personal-stickers-hint" class="setting-hint">{{ t('admin.instance.maxPersonalStickersHint') }}</span>
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.emojiQuality') }}</label>
        <input
          v-model.number="config.federation.customEmojiTransformQuality"
          type="number"
          class="cyber-input"
          min="1"
          max="100"
        />
        <span class="setting-hint">{{ t('admin.instance.emojiQualityHint') }}</span>
      </div>
      <div class="setting-group">
        <label for="federate-image-max-px">{{ t('admin.instance.federateImageMaxPx') }}</label>
        <input
          id="federate-image-max-px"
          v-model.number="config.federation.federateImageMaxPx"
          type="number"
          class="cyber-input"
          min="0"
          :max="FEDERATE_IMAGE_RENDER_MAX"
          step="1"
          aria-describedby="federate-image-max-px-hint"
          data-testid="federate-image-max-px-input"
        />
        <span id="federate-image-max-px-hint" class="setting-hint">{{ t('admin.instance.federateImageMaxPxHint') }}</span>
      </div>
      <div class="setting-group">
        <label class="toggle-label">
          <input type="checkbox" v-model="config.federation.allowCustomEmojisInDisplayNames" />
          <span class="toggle-slider"></span>
          <span class="toggle-text">{{ t('admin.instance.allowEmojiNames') }}</span>
        </label>
        <span class="setting-hint">{{ t('admin.instance.allowEmojiNamesHint') }}</span>
      </div>
      <div class="setting-group">
        <label class="toggle-label">
          <input
            type="checkbox"
            v-model="config.federation.publicProfilePages"
            aria-describedby="public-profile-pages-hint"
            data-testid="public-profile-pages-toggle"
          />
          <span class="toggle-slider"></span>
          <span class="toggle-text">{{ t('admin.instance.publicProfilePages') }}</span>
        </label>
        <span id="public-profile-pages-hint" class="setting-hint">{{ t('admin.instance.publicProfilePagesHint') }}</span>
      </div>
      <div class="setting-group">
        <label class="toggle-label">
          <input
            type="checkbox"
            v-model="config.federation.enableOutbound"
            :disabled="!switchesLoaded"
            aria-describedby="federation-outbound-hint"
            data-testid="federation-outbound-toggle"
          />
          <span class="toggle-slider"></span>
          <span class="toggle-text">{{ t('admin.instance.federationOutbound') }}</span>
        </label>
        <span id="federation-outbound-hint" class="setting-hint">{{ t('admin.instance.federationOutboundHint') }}</span>
      </div>
      <div class="setting-group">
        <label class="toggle-label">
          <input
            type="checkbox"
            v-model="config.federation.enableInbound"
            :disabled="!switchesLoaded"
            aria-describedby="federation-inbound-hint"
            data-testid="federation-inbound-toggle"
          />
          <span class="toggle-slider"></span>
          <span class="toggle-text">{{ t('admin.instance.federationInbound') }}</span>
        </label>
        <span id="federation-inbound-hint" class="setting-hint">{{ t('admin.instance.federationInboundHint') }}</span>
      </div>
      <p
        v-if="!config.federation.enableInbound && !config.federation.enableOutbound"
        class="setting-hint federation-closed-warning"
        role="note"
        data-testid="federation-closed-warning"
      >{{ t('admin.instance.federationClosedWarning') }}</p>

      <button @click="saveConfig" class="save-btn" :disabled="!configChanged" style="margin-top: 16px;">
        <Icon name="save" :size="16" />
        {{ t('server.saveChanges') }}
      </button>
    </fieldset>

    <!-- Instance Branding -->
    <fieldset v-if="configTab === 'branding'" class="config-section" :disabled="!configLoaded">
      <h3>{{ t('admin.instance.brandingTitle') }}</h3>
      <div class="setting-group">
        <label>{{ t('admin.instance.instanceName') }}</label>
        <input 
          v-model="instanceConfig.name" 
          type="text" 
          class="cyber-input"
          :placeholder="t('admin.instance.namePlaceholder')"
          @input="instanceBrandingChanged = true"
        />
        <span class="setting-hint">
          {{ t('admin.instance.nameHint') }}
        </span>
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.instanceDescription') }}</label>
        <textarea
          v-model="instanceConfig.description"
          class="cyber-input"
          rows="3"
          :placeholder="t('admin.instance.descriptionPlaceholder')"
          @input="instanceBrandingChanged = true"
        ></textarea>
        <span class="setting-hint">
          {{ t('admin.instance.descriptionHint') }}
        </span>
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.instanceRules') }}</label>
        <textarea
          v-model="instanceRulesText"
          class="cyber-input"
          rows="5"
          :placeholder="t('admin.instance.rulesPlaceholder')"
          @input="instanceBrandingChanged = true"
        ></textarea>
        <span class="setting-hint">
          {{ t('admin.instance.rulesHint') }}
        </span>
      </div>

      <div class="config-subsection">
        <h4>{{ t('settings.appearance.title') }}</h4>
        <div class="setting-group">
          <label>{{ t('admin.instance.instanceIcon') }}</label>
          <div class="instance-appearance-row">
            <div
              class="instance-icon-preview"
              @click="($refs.instanceIconInput as HTMLInputElement)?.click()"
            >
              <img
                v-if="instanceIconPreviewUrl"
                :src="instanceIconPreviewUrl"
                :alt="t('admin.instance.instanceIcon')"
                class="instance-icon-img"
              />
              <Icon v-else name="image" :size="24" />
            </div>
            <div class="instance-appearance-controls">
              <button type="button" class="save-btn" @click="($refs.instanceIconInput as HTMLInputElement)?.click()">
                {{ t('admin.instance.uploadIcon') }}
              </button>
              <button
                v-if="instanceConfig.iconUrl || instanceIconFile"
                type="button"
                class="save-btn"
                style="background: var(--error);"
                @click="instanceIconFile = null; instanceConfig.iconUrl = ''; instanceBrandingChanged = true"
              >
                {{ t('common.remove') }}
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
            {{ t('admin.instance.iconHint') }}
          </span>
        </div>

        <div class="setting-group">
          <label>{{ t('admin.instance.instanceBanner') }}</label>
          <div
            class="instance-banner-preview"
            :style="instanceBannerPreviewUrl ? { backgroundImage: `url(${instanceBannerPreviewUrl})` } : {}"
            @click="($refs.instanceBannerInput as HTMLInputElement)?.click()"
          >
            <div v-if="!instanceBannerPreviewUrl" class="instance-banner-placeholder">
              <Icon name="image" :size="20" />
              <span>{{ t('admin.instance.uploadBanner') }}</span>
            </div>
            <div v-else class="instance-banner-overlay">
              <span>{{ t('admin.instance.changeBanner') }}</span>
            </div>
          </div>
          <div v-if="instanceConfig.bannerUrl || instanceBannerFile" style="margin-top: 8px;">
            <button
              type="button"
              class="save-btn"
              style="background: var(--error);"
              @click="instanceBannerFile = null; instanceConfig.bannerUrl = ''; instanceBrandingChanged = true"
            >
              {{ t('server.banner.remove') }}
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
            {{ t('admin.instance.bannerHint') }}
          </span>
        </div>

        <div class="setting-group">
          <span class="form-label-text" aria-hidden="true">{{ t('admin.instance.themeColor') }}</span>
          <!-- Its sliders are not form controls: a disabled fieldset leaves them live. -->
          <div style="display: flex; align-items: center; gap: 12px;" :inert="!configLoaded">
            <ColorPicker
              :label="t('admin.instance.themeColor')"
              :color="instanceConfig.themeColor || '#0EA5E9'"
              @update:color="instanceConfig.themeColor = $event; instanceBrandingChanged = true"
              @change="instanceConfig.themeColor = $event; instanceBrandingChanged = true"
            />
          </div>
          <span class="setting-hint">
            {{ t('admin.instance.themeColorHint') }}
          </span>
        </div>

        <div class="setting-group">
          <label>{{ t('admin.instance.defaultTheme') }}</label>
          <span class="setting-hint" style="margin-bottom: 8px;">
            {{ t('admin.instance.defaultThemeHint') }}
          </span>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <button type="button" class="save-btn" @click="($refs.defaultThemeInput as HTMLInputElement)?.click()">
              {{ t('admin.instance.importTheme') }}
            </button>
            <button 
              v-if="instanceConfig.defaultThemeJson"
              type="button" 
              class="delete-btn"
              @click="clearDefaultTheme"
            >
              {{ t('admin.instance.clearTheme') }}
            </button>
            <span v-if="instanceConfig.defaultThemeJson" class="setting-hint" style="margin: 0;">
              {{ t('admin.instance.themeSet') }}
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
        <h4>{{ t('admin.instance.legalTitle') }}</h4>
        <div class="setting-group">
          <label>{{ t('admin.instance.termsUrl') }}</label>
          <input
            v-model="instanceConfig.termsUrl"
            type="url"
            class="cyber-input"
            placeholder="https://example.com/terms"
            @input="instanceBrandingChanged = true"
          />
          <span class="setting-hint">
            {{ t('admin.instance.termsHint') }}
          </span>
        </div>
        <div class="setting-group">
          <label>{{ t('admin.instance.privacyUrl') }}</label>
          <input
            v-model="instanceConfig.privacyUrl"
            type="url"
            class="cyber-input"
            placeholder="https://example.com/privacy"
            @input="instanceBrandingChanged = true"
          />
          <span class="setting-hint">
            {{ t('admin.instance.privacyHint') }}
          </span>
        </div>
        <div class="setting-group">
          <label>{{ t('admin.instance.maintainerName') }}</label>
          <input
            v-model="instanceConfig.maintainerName"
            type="text"
            class="cyber-input"
            :placeholder="t('admin.instance.maintainerNamePlaceholder')"
            @input="instanceBrandingChanged = true"
          />
          <span class="setting-hint">
            {{ t('admin.instance.maintainerNameHint') }}
          </span>
        </div>
        <div class="setting-group">
          <label>{{ t('admin.instance.maintainerEmail') }}</label>
          <input
            v-model="instanceConfig.maintainerEmail"
            type="email"
            class="cyber-input"
            placeholder="admin@example.com"
            @input="instanceBrandingChanged = true"
          />
          <span class="setting-hint">
            {{ t('admin.instance.maintainerEmailHint') }}
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
        {{ savingBranding ? t('admin.instance.saving') : t('admin.instance.saveBranding') }}
      </button>
    </fieldset>

    <!-- OAuth Providers -->
    <fieldset v-if="configTab === 'oauth'" class="config-section" :disabled="!configLoaded">
      <OAuthProvidersAdmin />

      <section class="custom-oauth" data-testid="admin-custom-oauth" aria-labelledby="custom-oauth-title">
        <h4 id="custom-oauth-title">{{ t('admin.instance.customOAuthTitle') }}</h4>
        <p class="setting-hint">{{ t('admin.instance.customOAuthHint') }}</p>
        <ul v-if="customOAuthProviders.length" class="custom-oauth-list" data-testid="admin-custom-oauth-list">
          <li v-for="provider in customOAuthProviders" :key="provider.id" class="custom-oauth-item">
            <img v-if="provider.icon" :src="provider.icon" alt="" width="20" height="20" referrerpolicy="no-referrer" />
            <Icon v-else name="key" :size="20" />
            <span class="custom-oauth-name">{{ provider.name }}</span>
            <code class="custom-oauth-id">{{ provider.id }}</code>
          </li>
        </ul>
        <p v-else class="setting-hint" data-testid="admin-custom-oauth-empty">{{ t('admin.instance.customOAuthEmpty') }}</p>
        <p class="setting-hint">{{ t('admin.instance.customOAuthCallback') }}</p>
        <code class="custom-oauth-command" data-testid="admin-custom-oauth-callback">{{ customOAuthCallbackUrl }}</code>
        <p class="setting-hint">{{ t('admin.instance.customOAuthManage') }}</p>
        <pre class="custom-oauth-command"><code>harmony auth add-provider authentik --name Authentik \
  --issuer https://auth.example.com/application/o/harmony/ --client-id …
harmony auth providers
harmony auth remove-provider authentik</code></pre>
      </section>
    </fieldset>

    <!-- WebRTC / Voice Settings -->
    <div v-if="configTab === 'uploads'" class="config-section">
      <UploadLimitsAdmin />
    </div>

    <fieldset v-if="configTab === 'webrtc'" class="config-section" :disabled="!configLoaded">
      <h3>{{ t('admin.instance.webrtcTitle') }}</h3>
      <p v-if="webrtcUnread" class="setting-hint federation-closed-warning" role="status" data-testid="webrtc-unread">
        {{ t('admin.instance.webrtcLoadFailed') }}
      </p>
      <div class="setting-group">
        <label>{{ t('admin.instance.webrtcMode') }}</label>
        <select v-model="config.webrtc.mode" class="cyber-input" :disabled="webrtcUnread">
          <option value="hybrid">{{ t('admin.instance.modeHybrid') }}</option>
          <option value="sfu">{{ t('admin.instance.modeSfu') }}</option>
          <option value="p2p">{{ t('admin.instance.modeP2p') }}</option>
        </select>
        <span class="setting-hint">
          {{ t('admin.instance.modeHint') }}
        </span>
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.livekitUrl') }}</label>
        <input 
          v-model="config.webrtc.livekitUrl" :disabled="webrtcUnread" 
          type="text" 
          class="cyber-input"
          placeholder="wss://livekit.yourdomain.com"
        />
        <span class="setting-hint">
          {{ t('admin.instance.livekitUrlHint') }}
        </span>
      </div>
      <div class="setting-group">
        <label>{{ t('admin.instance.maxStageListeners') }}</label>
        <input 
          v-model.number="config.webrtc.maxStageListeners" :disabled="webrtcUnread" 
          type="number" 
          class="cyber-input"
        />
        <span class="setting-hint">
          {{ t('admin.instance.maxStageListenersHint') }}
        </span>
      </div>
      <div class="setting-group" data-testid="webrtc-federated-state">
        <span class="form-label-text">{{ t('admin.instance.federatedCallsLabel') }}</span>
        <p class="federated-calls-state" role="status">{{ federatedCallsText }}</p>
        <span class="setting-hint">{{ t('admin.instance.federatedCallsHint') }}</span>
      </div>

      <button @click="saveConfig" class="save-btn" :disabled="!configChanged" style="margin-top: 16px;">
        <Icon name="save" :size="16" />
        {{ t('server.saveChanges') }}
      </button>
    </fieldset>
    <VoiceIceSettings v-if="configTab === 'webrtc' && hasCapability('signal-relay')" />
  </div>
</div>
</template>

<script setup lang="ts">
import { hasCapability } from '@/services/instanceCapabilities'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import Icon from '@/components/common/Icon.vue'
import ColorPicker from '@/components/common/ColorPicker.vue'
import NewcomerAlertsDefault from '@/components/admin/NewcomerAlertsDefault.vue'
import UploadLimitsAdmin from '@/components/admin/UploadLimitsAdmin.vue'
import VoiceIceSettings from '@/components/admin/VoiceIceSettings.vue'
import OAuthProvidersAdmin from '@/components/admin/OAuthProvidersAdmin.vue'
import BridgeAdminSection from '@/components/settings/discord-bridge/BridgeAdminSection.vue'
import MatrixAdminSection from '@/components/settings/matrix-bridge/MatrixAdminSection.vue'
import { adminService } from '@/services/AdminService'
import { trendingService } from '@/services/TrendingService'
import { supabase } from '@/supabase'
import { humanizeUploadError, imageSourceError } from '@/utils/uploadValidation'
import { uploadImageObject } from '@/utils/fileUpload'
import { runtimeConfig } from '@/services/runtimeConfig'
import { fetchLiveKitConfig } from '@/services/livekitTokens'
import { DEFAULT_PERSONAL_EMOJIS_PER_USER, parsePersonalEmojiLimit } from '@/utils/personalEmojiLimit'
import { DEFAULT_STICKER_CAPS, parseStickerCap } from '@/utils/stickerLimits'
import { DEFAULT_FEDERATE_IMAGE_MAX_PX, FEDERATE_IMAGE_RENDER_MAX, parseFederateImageMaxPx } from '@/utils/federateImageMaxPx'
import type { CustomOAuthProvider } from '@/utils/customOAuthProviders'

const authStore = useAuthStore()
const toast = useToast()
const { t } = useI18n()
const { confirm } = useConfirmDialog()
// The switches as last loaded or saved: turning both off from here closes federation.
const savedFederation = ref({ inbound: true, outbound: true })
// The switches were read; unread, they are neither shown as editable nor saved.
const switchesLoaded = ref(false)

const loadingStates = ref({ trendingRefresh: false })

const refreshTrendingPosts = async () => {
  loadingStates.value.trendingRefresh = true
  try {
    await trendingService.updateTrendingScores()
    toast.success(t('admin.instance.trendingRefreshed'))
  } catch (error) {
    debug.error('Failed to refresh trending:', error)
    toast.error(t('admin.instance.trendingRefreshFailed'))
  } finally {
    loadingStates.value.trendingRefresh = false
  }
}

// instance_config keys and WebRTC settings as last loaded or saved. A save writes only the
// keys that differ, so a value changed elsewhere since the load is never reverted.
const savedConfigPayload = ref<Record<string, unknown> | null>(null)
const savedWebrtc = ref<Record<string, unknown> | null>(null)
const configLoadFailed = ref(false)
// Inputs are locked until the stored values are read: the load overwrites them, and defaults
// shown for unread values must not reach a save.
const configLoaded = ref(false)
const instanceBrandingChanged = ref(false)
const savingBranding = ref(false)
const configTab = ref<'general' | 'federation' | 'branding' | 'oauth' | 'webrtc' | 'uploads'>('general')
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

// Read-only: each provider's client secret lives in GoTrue on the host.
const customOAuthProviders = ref<CustomOAuthProvider[]>([])
// GoTrue's callback for custom providers: GOTRUE_CUSTOM_OAUTH_EXTERNAL_URL (API_EXTERNAL_URL/auth/v1)
// + /callback. The web app's Supabase URL is API_EXTERNAL_URL on a self-host install.
const customOAuthCallbackUrl = `${(runtimeConfig.supabaseUrl || '').replace(/\/+$/, '')}/auth/v1/callback`
// Configuration
const config = ref({
  chat: {
    maxServerSize: 1000,
    maxServersPerUser: 100,
    maxBotsPerUser: 25,
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
    maxCustomEmojisPerServer: 50,
    maxPersonalEmojisPerUser: DEFAULT_PERSONAL_EMOJIS_PER_USER,
    maxStickersPerServer: DEFAULT_STICKER_CAPS.server,
    maxInstanceStickers: DEFAULT_STICKER_CAPS.instance,
    maxPersonalStickersPerUser: DEFAULT_STICKER_CAPS.user,
    customEmojiTransformQuality: 80,
    allowCustomEmojisInDisplayNames: true,
    maxPostReactionsPerUser: 10,
    publicProfilePages: true,
    federateImageMaxPx: DEFAULT_FEDERATE_IMAGE_MAX_PX as number | string,
    enableOutbound: true,
    enableInbound: true
  },
  webrtc: {
    mode: 'hybrid' as 'sfu' | 'p2p' | 'hybrid',
    livekitUrl: '',
    maxStageListeners: 100000
  }
})

// As the federation backend reports it, from ALLOW_FEDERATED_VOICE in its environment.
const federatedCallsText = ref('')

const loadFederatedCalls = async () => {
  const voice = await fetchLiveKitConfig()
  if (!voice) federatedCallsText.value = t('admin.instance.federatedCallsUnread')
  else if (!voice.allowFederatedVoice) federatedCallsText.value = t('admin.instance.federatedCallsOff')
  else if (!voice.enabled) federatedCallsText.value = t('admin.instance.federatedCallsNoLivekit')
  else federatedCallsText.value = t('admin.instance.federatedCallsOn')
}

watch(configTab, (tab) => {
  if (tab === 'webrtc') void loadFederatedCalls()
})

// Progress of the queue that stores Discord files, shown while "Mirror to storage" is selected.
interface MirrorStatus { queued: number; too_large: number; too_large_bytes: number; failed: number; over_quota?: number; stored_bytes?: number }
const mirrorStatus = ref<MirrorStatus | null>(null)
const MIRROR_STATUS_POLL_MS = 30_000
let mirrorStatusTimer: ReturnType<typeof setInterval> | null = null

// Decimal units, as Discord and the upload ceiling are stated.
const formatSizeDecimal = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++ }
  const rounded = value < 10 && unit > 0 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
  return `${rounded} ${units[unit]}`
}

const mirrorStatusText = computed(() => {
  const s = mirrorStatus.value
  if (!s) return ''
  const parts: string[] = [t('admin.instance.mirrorStatusProgress', { queued: s.queued, size: formatSizeDecimal(s.stored_bytes ?? 0) })]
  if (s.too_large > 0) {
    parts.push(t('admin.instance.mirrorStatusTooLarge', { count: s.too_large, size: formatSizeDecimal(s.too_large_bytes) }))
  }
  if (s.failed > 0) parts.push(t('admin.instance.mirrorStatusFailed', { count: s.failed }))
  // Absent on a database before 20261112800001.
  const overQuota = s.over_quota ?? 0
  if (overQuota > 0) parts.push(t('admin.instance.mirrorStatusOverQuota', { count: overQuota }))
  if (s.queued === 0 && s.too_large === 0 && s.failed === 0 && overQuota === 0) return t('admin.instance.mirrorStatusAllStored')
  return parts.join('. ')
})

const loadMirrorStatus = async () => {
  try {
    const { data, error } = await supabase.rpc('bridge_mirror_status')
    mirrorStatus.value = error || !data ? null : (data as MirrorStatus)
  } catch (error) {
    debug.error('Failed to load mirror status:', error)
    mirrorStatus.value = null
  }
}

const stopMirrorStatusPolling = () => {
  if (mirrorStatusTimer) clearInterval(mirrorStatusTimer)
  mirrorStatusTimer = null
}

watch(
  () => configTab.value === 'general' && config.value.chat.bridgeAttachmentMode === 'mirror',
  (showing) => {
    stopMirrorStatusPolling()
    if (!showing) { mirrorStatus.value = null; return }
    void loadMirrorStatus()
    mirrorStatusTimer = setInterval(() => void loadMirrorStatus(), MIRROR_STATUS_POLL_MS)
  },
  { immediate: true },
)
onUnmounted(stopMirrorStatusPolling)

const limitsSupported = hasCapability('instance-limits')

const configPayload = (): Record<string, unknown> => ({
  max_server_size: config.value.chat.maxServerSize,
  ...(limitsSupported ? {
    max_servers_per_user: config.value.chat.maxServersPerUser,
    max_bots_per_user: config.value.chat.maxBotsPerUser,
  } : {}),
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
  max_personal_emojis_per_user: parsePersonalEmojiLimit(config.value.federation.maxPersonalEmojisPerUser),
  max_stickers_per_server: parseStickerCap('server', config.value.federation.maxStickersPerServer),
  max_instance_stickers: parseStickerCap('instance', config.value.federation.maxInstanceStickers),
  max_personal_stickers_per_user: parseStickerCap('user', config.value.federation.maxPersonalStickersPerUser),
  custom_emoji_transform_quality: Math.min(
    100,
    Math.max(1, Math.round(Number(config.value.federation.customEmojiTransformQuality) || 100))
  ),
  allow_custom_emojis_in_display_names: config.value.federation.allowCustomEmojisInDisplayNames,
  public_profile_pages: config.value.federation.publicProfilePages,
  federate_image_max_px: parseFederateImageMaxPx(config.value.federation.federateImageMaxPx),
  max_post_reactions_per_user: Math.min(
    100,
    Math.max(1, Math.round(Number(config.value.federation.maxPostReactionsPerUser) || 10))
  ),
})

const webrtcPayload = (): Record<string, unknown> => ({
  mode: config.value.webrtc.mode,
  livekitUrl: config.value.webrtc.livekitUrl,
  maxStageListeners: config.value.webrtc.maxStageListeners,
})

const changedKeys = (current: Record<string, unknown>, saved: Record<string, unknown> | null) =>
  saved ? Object.keys(current).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(saved[key])) : []

const federationSwitchesChanged = () => switchesLoaded.value
  && (config.value.federation.enableInbound !== savedFederation.value.inbound
    || config.value.federation.enableOutbound !== savedFederation.value.outbound)

// The voice settings could not be read: they are shown as defaults and cannot be saved.
const webrtcUnread = computed(() => savedConfigPayload.value !== null && savedWebrtc.value === null)

// Save stays disabled until the stored values are read.
const configChanged = computed(() => savedConfigPayload.value !== null && (
  changedKeys(configPayload(), savedConfigPayload.value).length > 0
  || (savedWebrtc.value !== null && changedKeys(webrtcPayload(), savedWebrtc.value).length > 0)
  || federationSwitchesChanged()
))

const loadInstanceConfig = async () => {
  try {
    const cfg = await adminService.getInstanceConfig()
    configLoadFailed.value = !cfg
    if (!cfg) toast.error(t('admin.instance.configLoadFailed'))
    if (cfg) {
      if (cfg.chat) {
        config.value.chat = { ...config.value.chat, ...cfg.chat }
      }
      if (cfg.federation) {
        config.value.federation = { ...config.value.federation, ...cfg.federation }
        savedFederation.value = { inbound: cfg.federation.enableInbound, outbound: cfg.federation.enableOutbound }
        switchesLoaded.value = cfg.federation.federationSwitchesLoaded === true
      }
      if (cfg.webrtc) {
        config.value.webrtc = { ...config.value.webrtc, ...cfg.webrtc }
      }
      savedConfigPayload.value = configPayload()
      savedWebrtc.value = cfg.webrtcLoaded === false ? null : webrtcPayload()
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

      customOAuthProviders.value = cfg.instance.customOAuthProviders || []
    }
    configLoaded.value = !!cfg
  } catch (error) {
    debug.error('Failed to load instance config:', error)
    configLoadFailed.value = true
    toast.error(t('admin.instance.configLoadFailed'))
  }
}


const saveConfig = async () => {
  if (!authStore.session?.user?.id) {
    toast.error(t('admin.instance.mustLogInConfig'))
    return
  }

  try {
    const userId = authStore.session.user.id
    const { enableInbound, enableOutbound } = config.value.federation
    const closing = switchesLoaded.value && !enableInbound && !enableOutbound
      && (savedFederation.value.inbound || savedFederation.value.outbound)
    if (closing && !(await confirm({
      title: t('admin.instance.federationCloseConfirmTitle'),
      message: t('admin.instance.federationCloseConfirmMessage'),
      confirmButtonText: t('admin.instance.federationCloseConfirm'),
      dangerAction: true,
    }))) return
    
    // Only switches that were read and changed are written.
    if (federationSwitchesChanged()) {
      const fedSuccess = await adminService.updateFederationSettings({
        userId,
        inboundEnabled: enableInbound,
        outboundEnabled: enableOutbound,
        federationEnabled: enableInbound || enableOutbound
      })
      if (!fedSuccess) {
        toast.error(t('admin.instance.federationSaveFailed'))
        return
      }
      savedFederation.value = { inbound: enableInbound, outbound: enableOutbound }
    }

    if (!savedConfigPayload.value) return
    const payload = configPayload()
    const keys = changedKeys(payload, savedConfigPayload.value)
    if (keys.length > 0) {
      await adminService.setInstanceConfigs(Object.fromEntries(keys.map((key) => [key, payload[key]])), userId)
      savedConfigPayload.value = { ...savedConfigPayload.value, ...Object.fromEntries(keys.map((key) => [key, payload[key]])) }
    }

    const webrtc = webrtcPayload()
    if (savedWebrtc.value && changedKeys(webrtc, savedWebrtc.value).length > 0) {
      const webrtcSaved = await adminService.updateWebRTCSettings({
        mode: config.value.webrtc.mode,
        livekitUrl: config.value.webrtc.livekitUrl,
        maxStageListeners: config.value.webrtc.maxStageListeners
      })
      if (!webrtcSaved) {
        toast.error(t('admin.instance.voiceSaveFailed'))
        return
      }
      savedWebrtc.value = webrtc
    }

    toast.success(t('admin.instance.configSaved'))
    debug.log('Configuration saved:', config.value)
    
    const instanceSettings = useInstanceSettingsStore()
    await instanceSettings.fetchSettings(true)
  } catch (error: any) {
    debug.error('Failed to save configuration:', error)
    toast.error(error.message || t('admin.instance.configSaveFailed'))
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
    toast.error(t('admin.instance.mustLogInBranding'))
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
    toast.success(t('admin.instance.brandingSaved'))
    debug.log('Instance branding saved:', instanceConfig.value)
  } catch (error: any) {
    debug.error('Failed to save instance branding:', error)
    toast.error(error.message || t('admin.instance.brandingSaveFailed'))
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
      toast.error(t('admin.instance.invalidThemeJson'))
      return
    }
    instanceConfig.value.defaultThemeJson = text
    instanceBrandingChanged.value = true

    if (authStore.session?.user?.id) {
      await adminService.setInstanceConfigs({
        default_theme_json: text,
      }, authStore.session.user.id)
      toast.success(t('admin.instance.themeImported'))
    }
  } catch {
    toast.error(t('admin.instance.themeParseFailed'))
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
      toast.success(t('admin.instance.themeCleared'))
    } catch {
      toast.error(t('admin.instance.themeClearFailed'))
    }
  }
}

onMounted(() => {
  void loadInstanceConfig()
})
</script>

<style scoped>
.federated-calls-state {
  margin: 0 0 4px;
  font-size: 14px;
}







.setting-group {
  margin-bottom: 16px;
}







.setting-group label,
.setting-group .form-label-text {
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

.federation-closed-warning {
  color: var(--warning);
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
  color: var(--text-danger);
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
  color: var(--text-link);
  border-bottom-color: var(--harmony-primary);
}






.config-sections {
  padding: 24px;
}







/* Fieldset defaults: border, padding, min-content minimum width. */
.config-section {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.config-section:disabled {
  opacity: 0.6;
}







.config-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-primary);
}

.custom-oauth {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.custom-oauth h4 {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.custom-oauth-list {
  list-style: none;
  margin: 8px 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.custom-oauth-item {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-primary);
}

.custom-oauth-item img {
  object-fit: contain;
}

.custom-oauth-name {
  font-weight: 500;
}

.custom-oauth-id {
  font-size: 12px;
  color: var(--text-secondary);
}

.custom-oauth-command {
  display: block;
  margin: 4px 0 12px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
  background: var(--harmony-primary-fill);
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
  background: var(--harmony-primary-fill-hover);
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
