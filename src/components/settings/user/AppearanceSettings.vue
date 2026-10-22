<template>
  <div class="appearance-settings">
    <div class="settings-header">
      <h2 ref="titleRef" class="settings-title" tabindex="-1">{{ $t('settings.appearance.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.appearance.description') }}
      </p>
      <button type="button" class="live-editor-btn" aria-haspopup="dialog" data-testid="open-theme-editor" @click="openLiveEditor">
        <Icon name="pencil" :size="16" />
        {{ $t('settings.appearance.editLivePreview') }}
      </button>
    </div>

    <div class="settings-section">
      <h3 :id="`${a11yId}-theme`" class="section-title">{{ $t('settings.appearance.theme') }}</h3>

      <!-- Native radios: one Tab stop, arrow keys move and select. -->
      <div class="theme-options" role="radiogroup" :aria-labelledby="`${a11yId}-theme`" data-testid="theme-options">
        <label
          v-for="theme in themes"
          :key="theme.id"
          class="theme-option"
          :class="{ active: themeChoice === theme.id }"
          :data-testid="`theme-option-${theme.id}`"
        >
          <input
            type="radio"
            class="theme-radio sr-only"
            :name="`${a11yId}-theme-choice`"
            :value="theme.id"
            :checked="themeChoice === theme.id"
            :aria-labelledby="`${a11yId}-theme-${theme.id}-name`"
            :aria-describedby="`${a11yId}-theme-${theme.id}-desc`"
            @change="selectTheme(theme.id)"
          />
          <div class="theme-preview" :style="{ backgroundColor: theme.id === 'custom' ? customPreviewColors.bgMain : theme.preview }">
            <div class="theme-preview-content">
              <div class="preview-header" :style="{ backgroundColor: theme.id === 'custom' ? customPreviewColors.bgHeader : theme.headerColor }"></div>
              <div class="preview-sidebar" :style="{ backgroundColor: theme.id === 'custom' ? customPreviewColors.bgSidebar : theme.sidebarColor }"></div>
              <div class="preview-chat" :style="{ backgroundColor: theme.id === 'custom' ? customPreviewColors.bgMain : theme.chatColor }"></div>
              <div v-if="theme.id === 'custom'" class="preview-accent-dot" :style="{ backgroundColor: settings.customPrimaryColor }"></div>
            </div>
          </div>
          <div class="theme-info">
            <span :id="`${a11yId}-theme-${theme.id}-name`" class="theme-name">{{ $t(`settings.appearance.themes.${theme.id}`) }}</span>
            <span :id="`${a11yId}-theme-${theme.id}-desc`" class="theme-description">{{ $t(`settings.appearance.themes.${theme.id}Desc`) }}</span>
          </div>
        </label>

        <!-- Saved custom themes; the delete button sits outside the radio's label. -->
        <div
          v-for="(saved, si) in savedThemesList"
          :key="saved.id"
          class="saved-theme-wrap"
        >
          <label
            class="theme-option saved-theme-option"
            :class="{ active: themeChoice === `saved:${saved.id}` }"
          >
            <input
              type="radio"
              class="theme-radio sr-only"
              :name="`${a11yId}-theme-choice`"
              :value="`saved:${saved.id}`"
              :checked="themeChoice === `saved:${saved.id}`"
              :aria-labelledby="`${a11yId}-saved-${si}-name`"
              :aria-describedby="`${a11yId}-saved-${si}-desc`"
              @change="applySavedTheme(saved.id)"
            />
            <div class="theme-preview" :style="{ backgroundColor: getSavedThemePreview(saved).bgMain }">
              <div class="theme-preview-content">
                <div class="preview-header" :style="{ backgroundColor: getSavedThemePreview(saved).bgHeader }"></div>
                <div class="preview-sidebar" :style="{ backgroundColor: getSavedThemePreview(saved).bgSidebar }"></div>
                <div class="preview-chat" :style="{ backgroundColor: getSavedThemePreview(saved).bgMain }"></div>
                <div class="preview-accent-dot" :style="{ backgroundColor: saved.settings.customPrimaryColor || '#0EA5E9' }"></div>
              </div>
            </div>
            <div class="theme-info">
              <span :id="`${a11yId}-saved-${si}-name`" class="theme-name">{{ saved.name }}</span>
              <span :id="`${a11yId}-saved-${si}-desc`" class="theme-description">{{ $t('settings.appearance.savedTheme') }}</span>
            </div>
          </label>
          <button
            type="button"
            class="saved-theme-delete-btn"
            :data-saved-theme-delete="saved.id"
            :aria-label="$t('settings.appearance.deleteSavedTheme', { name: saved.name })"
            :title="$t('settings.appearance.deleteSavedTheme', { name: saved.name })"
            @click="confirmDeleteSavedTheme(saved)"
          >
            <Icon name="x" :size="14" />
          </button>
        </div>
      </div>

      <!-- Delete confirmation -->
      <div
        v-if="themeToDelete"
        class="delete-theme-confirm"
        role="group"
        :aria-labelledby="`${a11yId}-delete-question`"
      >
        <i18n-t :id="`${a11yId}-delete-question`" keypath="settings.appearance.deleteSavedThemeConfirm" tag="p" scope="global">
          <template #name><strong>{{ themeToDelete.name }}</strong></template>
        </i18n-t>
        <div class="delete-confirm-actions">
          <button ref="cancelDeleteBtn" type="button" class="cancel-delete-btn" @click="cancelDelete">{{ $t('common.cancel') }}</button>
          <button type="button" class="confirm-delete-btn" @click="confirmDelete">{{ $t('common.delete') }}</button>
        </div>
      </div>


      <!-- Custom Color Picker (only when Custom theme is selected) -->
      <div v-if="settings.theme === 'custom'" class="custom-color-section">
        <!-- Community Presets -->
        <div class="community-presets-section">
          <h4 class="section-subtitle">{{ $t('settings.appearance.communityPresets') }}</h4>
          <p class="section-help">{{ $t('settings.appearance.communityPresetsHelp') }}</p>
          <div :id="`${a11yId}-presets`" class="presets-grid">
            <button
              v-for="preset in visiblePresets"
              :key="preset.name"
              class="preset-card"
              @click="applyPresetTheme(preset)"
            >
              <div class="preset-swatch" :style="{ background: preset.settings.customPrimaryColor }"></div>
              <div class="preset-info">
                <span class="preset-name">{{ preset.name }}</span>
                <span class="preset-desc">{{ preset.description }}</span>
              </div>
            </button>
          </div>
          <button
            v-if="communityPresets.length > PRESETS_SHOWN"
            type="button"
            class="presets-more"
            :aria-expanded="showAllPresets ? 'true' : 'false'"
            :aria-controls="`${a11yId}-presets`"
            data-testid="presets-more"
            @click="showAllPresets = !showAllPresets"
          >
            {{ showAllPresets
              ? $t('settings.appearance.showFewerPresets')
              : $t('settings.appearance.showMorePresets', { count: communityPresets.length - PRESETS_SHOWN }) }}
            <Icon name="chevron-down" :size="14" class="presets-more-chevron" :class="{ open: showAllPresets }" />
          </button>
        </div>

        <h4 class="section-subtitle">{{ $t('settings.appearance.customTheme') }}</h4>
        <p class="section-help">{{ $t('settings.appearance.customThemeHelp') }}</p>
        
        <!-- Theme Mode Selector -->
        <div class="custom-theme-mode">
          <span :id="`${a11yId}-mode`" class="mode-label">{{ $t('settings.appearance.themeMode') }}</span>
          <div class="mode-options" role="group" :aria-labelledby="`${a11yId}-mode`">
            <button
              type="button"
              class="mode-btn"
              :class="{ active: settings.customThemeMode === 'dark' }"
              :aria-pressed="settings.customThemeMode === 'dark' ? 'true' : 'false'"
              @click="settings.customThemeMode = 'dark'; onCustomThemeModeChange()"
            >
              {{ $t('settings.appearance.themes.dark') }}
            </button>
            <button
              type="button"
              class="mode-btn"
              :class="{ active: settings.customThemeMode === 'light' }"
              :aria-pressed="settings.customThemeMode === 'light' ? 'true' : 'false'"
              @click="settings.customThemeMode = 'light'; onCustomThemeModeChange()"
            >
              {{ $t('settings.appearance.themes.light') }}
            </button>
          </div>
        </div>

        <ThemePaletteIdeas
          class="custom-palette-ideas"
          :mode="settings.customThemeMode || 'dark'"
          :seed="settings.customPrimaryColor || '#0EA5E9'"
          @apply="onPaletteIdea"
        />
        
        <div class="theme-collapse-list">
          <!-- Background -->
          <div class="theme-collapse">
            <button
              type="button"
              class="theme-collapse-header"
              :class="{ open: colorExpanded.background }"
              :aria-expanded="colorExpanded.background ? 'true' : 'false'"
              :aria-controls="`${a11yId}-background-body`"
              @click="colorExpanded.background = !colorExpanded.background"
            >
              <span class="theme-collapse-swatch" :style="{ backgroundColor: settings.customBackgroundColor }" />
              <span class="theme-collapse-label">
                <span class="theme-collapse-title">{{ $t('settings.appearance.colors.background') }}</span>
                <span class="theme-collapse-hint">{{ $t('settings.appearance.colors.backgroundHint') }}</span>
              </span>
              <span class="theme-collapse-hex">{{ settings.customBackgroundColor }}</span>
              <span class="theme-collapse-arrow" :class="{ open: colorExpanded.background }"><Icon name="chevron-down" :size="14" /></span>
            </button>
            <div v-show="colorExpanded.background" :id="`${a11yId}-background-body`" class="theme-collapse-body">
              <p class="picker-help">{{ $t('settings.appearance.colors.backgroundHelp') }}</p>
              <ColorPicker
                v-model:color="settings.customBackgroundColor"
                layout="wide"
                :label="$t('settings.appearance.colors.backgroundColor')"
                @update:color="onCustomBackgroundChange"
                @change="onCustomBackgroundChange"
              />
              <div class="theme-slider-block">
                <label :for="`${a11yId}-lightness`" class="picker-label">{{ $t('settings.appearance.lightness') }}</label>
                <div class="lightness-slider-container">
                  <span class="lightness-label" aria-hidden="true">{{ $t('settings.appearance.darker') }}</span>
                  <input
                    :id="`${a11yId}-lightness`"
                    v-model.number="settings.customBackgroundLightness"
                    type="range"
                    min="-50"
                    max="50"
                    step="1"
                    class="lightness-slider"
                    :aria-valuetext="toneValueText(settings.customBackgroundLightness, 'settings.appearance.darker', 'settings.appearance.lighter')"
                    @input="onLightnessChange"
                  />
                  <span class="lightness-label" aria-hidden="true">{{ $t('settings.appearance.lighter') }}</span>
                </div>
                <div class="lightness-value" aria-hidden="true">{{ (settings.customBackgroundLightness ?? 0) > 0 ? '+' : '' }}{{ settings.customBackgroundLightness }}</div>
              </div>
              <div class="theme-slider-block">
                <label :for="`${a11yId}-chroma`" class="picker-label">{{ $t('settings.appearance.saturation') }}</label>
                <div class="chroma-slider-container">
                  <span class="chroma-label" aria-hidden="true">{{ $t('settings.appearance.muted') }}</span>
                  <input
                    :id="`${a11yId}-chroma`"
                    v-model.number="settings.customBackgroundChroma"
                    type="range"
                    min="-30"
                    max="30"
                    step="1"
                    class="chroma-slider"
                    :aria-valuetext="toneValueText(settings.customBackgroundChroma, 'settings.appearance.muted', 'settings.appearance.vivid')"
                    @input="onChromaChange"
                  />
                  <span class="chroma-label" aria-hidden="true">{{ $t('settings.appearance.vivid') }}</span>
                </div>
                <div class="chroma-value" aria-hidden="true">{{ (settings.customBackgroundChroma ?? 0) > 0 ? '+' : '' }}{{ settings.customBackgroundChroma }}</div>
              </div>
            </div>
          </div>

          <!-- Primary -->
          <div class="theme-collapse">
            <button
              type="button"
              class="theme-collapse-header"
              :class="{ open: colorExpanded.primary }"
              :aria-expanded="colorExpanded.primary ? 'true' : 'false'"
              :aria-controls="`${a11yId}-primary-body`"
              @click="colorExpanded.primary = !colorExpanded.primary"
            >
              <span class="theme-collapse-swatch" :style="{ backgroundColor: settings.customPrimaryColor }" />
              <span class="theme-collapse-label">
                <span class="theme-collapse-title">{{ $t('settings.appearance.colors.primary') }}</span>
                <span class="theme-collapse-hint">{{ $t('settings.appearance.colors.primaryHint') }}</span>
              </span>
              <span class="theme-collapse-hex">{{ settings.customPrimaryColor }}</span>
              <span class="theme-collapse-arrow" :class="{ open: colorExpanded.primary }"><Icon name="chevron-down" :size="14" /></span>
            </button>
            <div v-show="colorExpanded.primary" :id="`${a11yId}-primary-body`" class="theme-collapse-body">
              <p class="picker-help">{{ $t('settings.appearance.colors.primaryHelp') }}</p>
              <ColorPicker
                v-model:color="settings.customPrimaryColor"
                layout="wide"
                :label="$t('settings.appearance.colors.primaryColor')"
              />
            </div>
          </div>

          <!-- Accent / Secondary -->
          <div class="theme-collapse">
            <button
              type="button"
              class="theme-collapse-header"
              :class="{ open: colorExpanded.accent }"
              :aria-expanded="colorExpanded.accent ? 'true' : 'false'"
              :aria-controls="`${a11yId}-accent-body`"
              @click="colorExpanded.accent = !colorExpanded.accent"
            >
              <span class="theme-collapse-swatch" :style="{ backgroundColor: settings.customAccentColor }" />
              <span class="theme-collapse-label">
                <span class="theme-collapse-title">{{ $t('settings.appearance.colors.accent') }}</span>
                <span class="theme-collapse-hint">{{ $t('settings.appearance.colors.accentHint') }}</span>
              </span>
              <span class="theme-collapse-hex">{{ settings.customAccentColor }}</span>
              <span class="theme-collapse-arrow" :class="{ open: colorExpanded.accent }"><Icon name="chevron-down" :size="14" /></span>
            </button>
            <div v-show="colorExpanded.accent" :id="`${a11yId}-accent-body`" class="theme-collapse-body">
              <p class="picker-help">{{ $t('settings.appearance.colors.accentHelp') }}</p>
              <ColorPicker
                v-model:color="settings.customAccentColor"
                layout="wide"
                :label="$t('settings.appearance.colors.accentColor')"
              />
            </div>
          </div>
        </div>

        <!-- Save current theme -->
        <div class="save-theme-row">
          <label :for="`${a11yId}-saved-name`" class="sr-only">{{ $t('settings.appearance.savedThemeName') }}</label>
          <input
            :id="`${a11yId}-saved-name`"
            v-model="savedThemeName"
            type="text"
            class="theme-name-input"
            :placeholder="$t('settings.appearance.savedThemeName')"
            @keyup.enter="saveCurrentTheme"
          />
          <button type="button" class="save-theme-btn" @click="saveCurrentTheme" :disabled="!savedThemeName?.trim()">
            {{ $t('settings.appearance.saveTheme') }}
          </button>
        </div>
      </div>

      <!-- Import / Export -->
      <div class="theme-import-export-section">
        <h4 class="section-subtitle">Import and export</h4>
        <p class="section-help">Export your theme as JSON or import a previously exported theme</p>
        <div class="import-export-buttons">
          <button class="preset-card export-btn" @click="exportTheme">
            <Icon name="download" :size="18" />
            Export theme
          </button>
          <button class="preset-card import-btn" @click="triggerImportInput">
            <Icon name="upload" :size="18" />
            Import theme
          </button>
          <input
            ref="importFileInput"
            type="file"
            accept=".json,application/json"
            class="hidden-file-input"
            tabindex="-1"
            :aria-label="$t('a11y.settings.importThemeFile')"
            @change="handleImportFile"
          />
        </div>
      </div>

      <!-- Advanced CSS (all themes) -->
      <div class="theme-collapse advanced-css-collapse">
        <button
          type="button"
          class="theme-collapse-header"
          :class="{ open: showAdvancedCss }"
          :aria-expanded="showAdvancedCss ? 'true' : 'false'"
          :aria-controls="`${a11yId}-advanced-body`"
          @click="showAdvancedCss = !showAdvancedCss"
        >
          <span class="theme-collapse-swatch theme-collapse-swatch-advanced" aria-hidden="true">{ }</span>
          <span class="theme-collapse-label">
            <span class="theme-collapse-title">{{ $t('settings.appearance.colors.advancedCss') }}</span>
            <span class="theme-collapse-hint">{{ $t('settings.appearance.colors.advancedCssHint') }}</span>
          </span>
          <span v-if="overrideCount > 0" class="override-badge">{{ overrideCount }}</span>
          <span class="theme-collapse-arrow" :class="{ open: showAdvancedCss }"><Icon name="chevron-down" :size="14" /></span>
        </button>

        <div v-show="showAdvancedCss" :id="`${a11yId}-advanced-body`" class="theme-collapse-body css-overrides-panel">
          <div v-if="overrideCount > 0" class="overrides-toolbar">
            <span class="override-summary">{{ t('settings.appearance.overrides.active', { count: overrideCount }, overrideCount) }}</span>
            <button type="button" class="reset-all-btn" @click="resetAllOverrides" :title="t('settings.appearance.overrides.resetAllHint')">
              {{ t('settings.appearance.overrides.resetAll') }}
            </button>
          </div>

          <template v-for="(group, gi) in themableVariables" :key="group.category">
            <div class="var-category-label" :class="{ 'is-first': gi === 0 }">{{ group.category }}</div>
            <div
              v-for="varName in group.vars"
              :key="varName"
              class="var-item"
              :class="{ 'has-override': settings.customCssOverrides?.[varName] }"
            >
              <label :for="varInputId(varName)" class="var-name">{{ varName }}</label>
              <div class="var-controls">
                <CssVarSwatch
                  class="var-swatch"
                  :value="getCssVarValue(varName)"
                  :label="varName"
                  @pick="setCssOverrideFromInput(varName, $event)"
                />
                <input
                  :id="varInputId(varName)"
                  type="text"
                  class="var-text-input"
                  :class="{ invalid: invalidVar?.name === varName }"
                  :value="settings.customCssOverrides?.[varName] || ''"
                  :placeholder="getComputedVar(varName)"
                  :title="invalidVar?.name === varName ? `Not a CSS colour: ${invalidVar.text}` : undefined"
                  @change="commitCssOverrideText(varName, $event.target as HTMLInputElement)"
                />
                <button
                  v-if="settings.customCssOverrides?.[varName]"
                  type="button"
                  class="var-reset-btn"
                  :aria-label="$t('settings.appearance.resetVariable', { name: varName })"
                  :title="$t('settings.appearance.resetVariable', { name: varName })"
                  @click="removeCssOverrideVar(varName)"
                >
                  <Icon name="x" :size="14" />
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">
        Skins
        <span class="beta-badge">Beta</span>
      </h3>
      <p class="section-description">
        Skins go beyond colour switching - they bundle a theme, a font, and a
        set of CSS rules that change borders, corners, decorative overlays and
        more. Picking one overrides the matching settings above; you can still
        tweak colours afterwards. Pick "None" to clear the skin layer.
      </p>

      <div class="skin-options">
        <button
          type="button"
          class="skin-card"
          :class="{ active: !settings.activeSkinId }"
          :aria-pressed="!settings.activeSkinId ? 'true' : 'false'"
          @click="onSkinChange(null)"
        >
          <div class="skin-card-preview skin-card-preview-none">
            <span class="skin-card-none-label">None</span>
          </div>
          <div class="skin-card-info">
            <h4 class="skin-card-name">None</h4>
            <p class="skin-card-description">Use the raw theme + font you've set above.</p>
          </div>
        </button>

        <button
          v-for="skin in builtinSkins"
          :key="skin.id"
          type="button"
          class="skin-card"
          :class="{ active: settings.activeSkinId === skin.id }"
          :aria-pressed="settings.activeSkinId === skin.id ? 'true' : 'false'"
          @click="onSkinChange(skin.id)"
        >
          <div class="skin-card-preview">
            <img v-if="skin.preview" :src="skin.preview" alt="" />
          </div>
          <div class="skin-card-info">
            <h4 class="skin-card-name">
              {{ skin.name }}
              <span v-if="skin.isBeta" class="beta-badge beta-badge-inline">Beta</span>
            </h4>
            <p class="skin-card-description">{{ skin.description }}</p>
          </div>
        </button>
      </div>

      <!-- Shown when the active skin manifest declares `options: SkinOption[]`.
           Each toggle flips `data-skin-<optionId>="on|off"` on `<html>`; skin
           CSS gates its decorative rules on that attribute. -->
      <div
        v-if="activeSkinOptions.length"
        class="skin-active-options"
      >
        <h4 class="skin-active-options-title">
          {{ activeSkin?.name }} - decorations
        </h4>
        <div
          v-for="option in activeSkinOptions"
          :key="option.id"
          class="setting-item skin-option-item"
        >
          <div class="setting-info">
            <h4 class="setting-label">{{ option.label }}</h4>
            <p v-if="option.description" class="setting-description">
              {{ option.description }}
            </p>
          </div>
          <div class="setting-control">
            <ToggleSwitch
              :label="option.label"
              :model-value="getActiveSkinOptionValue(option.id)"
              @update:model-value="(v: boolean) => onSkinOptionToggle(option.id, v)"
            />
          </div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Typography</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Font</h4>
          <p class="setting-description">
            Choose the typeface used across the entire app. Custom fonts are
            lazy-loaded, so picking the default doesn't download any extras.
          </p>
        </div>
        <div class="setting-control">
          <div class="font-family-options">
            <button
              v-for="opt in fontFamilyOptions"
              :key="opt.id"
              type="button"
              class="font-family-btn"
              :class="{ active: settings.fontFamily === opt.id }"
              :aria-pressed="settings.fontFamily === opt.id ? 'true' : 'false'"
              :style="{ fontFamily: opt.preview }"
              @click="onFontFamilyChange(opt.id)"
            >
              <span class="font-family-name">{{ opt.label }}</span>
              <span class="font-family-sample">The quick brown fox 0123</span>
            </button>
          </div>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 :id="`${a11yId}-font-size`" class="setting-label">{{ $t('settings.appearance.fontSize') }}</h4>
          <p :id="`${a11yId}-font-size-desc`" class="setting-description">{{ $t('settings.appearance.fontSizeDesc') }}</p>
        </div>
        <div class="setting-control">
          <div class="font-size-slider">
            <input
              v-model.number="settings.fontSize"
              type="range"
              min="12"
              max="20"
              step="1"
              class="slider"
              :aria-labelledby="`${a11yId}-font-size`"
              :aria-describedby="`${a11yId}-font-size-desc`"
              :aria-valuetext="`${settings.fontSize}px`"
            />
            <div class="font-size-display">{{ settings.fontSize }}px</div>
          </div>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 :id="`${a11yId}-zoom`" class="setting-label">{{ $t('settings.appearance.zoomLevel') }}</h4>
          <p :id="`${a11yId}-zoom-desc`" class="setting-description">{{ $t('settings.appearance.zoomLevelDesc') }}</p>
        </div>
        <div class="setting-control">
          <!-- aria-disabled, not disabled: a disabled button drops keyboard focus at the limit. -->
          <div class="zoom-controls" role="group" :aria-labelledby="`${a11yId}-zoom`" :aria-describedby="`${a11yId}-zoom-desc`">
            <button
              type="button"
              class="zoom-btn"
              data-testid="zoom-out"
              :aria-label="$t('settings.appearance.zoomOut')"
              :title="$t('settings.appearance.zoomOut')"
              :aria-describedby="`${a11yId}-zoom-value`"
              :aria-disabled="settings.zoomLevel <= ZOOM_MIN ? 'true' : undefined"
              @click="adjustZoom(-ZOOM_STEP)"
            >
              <span aria-hidden="true">-</span>
            </button>
            <span :id="`${a11yId}-zoom-value`" class="zoom-display" data-testid="zoom-value">{{ settings.zoomLevel }}%</span>
            <button
              type="button"
              class="zoom-btn"
              data-testid="zoom-in"
              :aria-label="$t('settings.appearance.zoomIn')"
              :title="$t('settings.appearance.zoomIn')"
              :aria-describedby="`${a11yId}-zoom-value`"
              :aria-disabled="settings.zoomLevel >= ZOOM_MAX ? 'true' : undefined"
              @click="adjustZoom(ZOOM_STEP)"
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">{{ $t('settings.appearance.messageDisplay') }}</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t2`">{{ $t('settings.appearance.showTimestamps') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t2-desc`">{{ $t('settings.appearance.showTimestampsDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t2`" :describedby="`${a11yId}-t2-desc`" 
            v-model="settings.showTimestamps"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t3`">{{ $t('settings.appearance.use24Hour') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t3-desc`">{{ $t('settings.appearance.use24HourDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t3`" :describedby="`${a11yId}-t3-desc`" 
            v-model="settings.use24HourTime"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t4`">{{ $t('settings.appearance.compactMode') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t4-desc`">{{ $t('settings.appearance.compactModeDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t4`" :describedby="`${a11yId}-t4-desc`" 
            v-model="settings.compactMode"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 :id="`${a11yId}-badge`" class="setting-label">{{ $t('settings.appearance.bridgeSourceBadge') }}</h4>
          <p :id="`${a11yId}-badge-desc`" class="setting-description">{{ $t('settings.appearance.bridgeSourceBadgeDesc') }}</p>
        </div>
        <div class="setting-control">
          <select
            v-model="settings.bridgeSourceBadge"
            :aria-labelledby="`${a11yId}-badge`"
            :aria-describedby="`${a11yId}-badge-desc`"
            class="form-select"
          >
            <option value="icon">{{ $t('settings.appearance.bridgeSourceBadgeIcon') }}</option>
            <option value="text">{{ $t('settings.appearance.bridgeSourceBadgeText') }}</option>
          </select>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t5`">{{ $t('settings.appearance.floatingVideo') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t5-desc`">{{ $t('settings.appearance.floatingVideoDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t5`" :describedby="`${a11yId}-t5-desc`" v-model="local.floatingVideoEnabled" />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 :id="`${a11yId}-player`" class="setting-label">{{ $t('settings.appearance.videoPlayer') }}</h4>
          <p :id="`${a11yId}-player-desc`" class="setting-description">{{ $t('settings.appearance.videoPlayerDesc') }}</p>
        </div>
        <div class="setting-control">
          <select
            :value="settings.videoPlayer === 'native' ? 'native' : 'harmony'"
            :aria-labelledby="`${a11yId}-player`"
            :aria-describedby="`${a11yId}-player-desc`"
            class="form-select"
            data-testid="video-player-setting"
            @change="settings.videoPlayer = ($event.target as HTMLSelectElement).value === 'native' ? 'native' : 'harmony'"
          >
            <option value="harmony">{{ $t('settings.appearance.videoPlayerHarmony') }}</option>
            <option value="native">{{ $t('settings.appearance.videoPlayerNative') }}</option>
          </select>
        </div>
      </div>

      <div v-if="instanceSettings.settings.allowCustomEmojisInDisplayNames" class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t6`">{{ $t('settings.appearance.showCustomEmojisInDisplayNames') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t6-desc`">{{ $t('settings.appearance.showCustomEmojisInDisplayNamesDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t6`" :describedby="`${a11yId}-t6-desc`" 
            :model-value="settings.showCustomEmojisInDisplayNames !== false"
            @update:model-value="(v: boolean) => (settings.showCustomEmojisInDisplayNames = v)"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t7`">{{ $t('settings.appearance.greentext') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t7-desc`">{{ $t('settings.appearance.greentextDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t7`" :describedby="`${a11yId}-t7-desc`"
            :model-value="settings.greentextEnabled !== false"
            @update:model-value="(v: boolean) => (settings.greentextEnabled = v)"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t8`">{{ $t('settings.appearance.convertSentEmoticons') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t8-desc`">{{ $t('settings.appearance.convertSentEmoticonsDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t8`" :describedby="`${a11yId}-t8-desc`"
            :model-value="settings.convertSentEmoticons !== false"
            @update:model-value="(v: boolean) => (settings.convertSentEmoticons = v)"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t9`">{{ $t('settings.appearance.renderEmoticonsAsEmoji') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t9-desc`">{{ $t('settings.appearance.renderEmoticonsAsEmojiDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t9`" :describedby="`${a11yId}-t9-desc`"
            :model-value="settings.renderEmoticonsAsEmoji !== false"
            @update:model-value="(v: boolean) => (settings.renderEmoticonsAsEmoji = v)"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t10`">{{ $t('settings.appearance.inviteBannerBg') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t10-desc`">{{ $t('settings.appearance.inviteBannerBgDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t10`" :describedby="`${a11yId}-t10-desc`"
            :model-value="settings.inviteBannerBackground !== false"
            @update:model-value="(v: boolean) => (settings.inviteBannerBackground = v)"
          />
        </div>
      </div>
    </div>

    <div class="settings-section" data-testid="mirror-links-settings">
      <h3 class="section-title">{{ $t('settings.appearance.mirrorLinks') }}</h3>
      <p class="section-description">{{ $t('settings.appearance.mirrorLinksDesc') }}</p>

      <div v-for="site in MIRROR_SITES" :key="site" class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-mirror-${site}`">
            {{ $t('settings.appearance.mirrorLinkSite', { site: MIRROR_SITE_NAMES[site] }) }}
          </h4>
        </div>
        <div class="setting-control mirror-link-control">
          <select
            :value="mirrors[site].host"
            :disabled="!mirrors[site].enabled"
            :aria-label="$t('settings.appearance.mirrorLinkHost', { site: MIRROR_SITE_NAMES[site] })"
            class="form-select"
            :data-testid="`mirror-host-${site}`"
            @change="setMirror(site, { host: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="host in MIRROR_HOSTS[site]" :key="host" :value="host">{{ host }}</option>
          </select>
          <ToggleSwitch
            :labelledby="`${a11yId}-mirror-${site}`"
            :model-value="mirrors[site].enabled"
            :data-testid="`mirror-toggle-${site}`"
            @update:model-value="(v: boolean) => setMirror(site, { enabled: v })"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">{{ $t('settings.appearance.quickReact') }}</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t11`">{{ $t('settings.appearance.quickReactEnable') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t11-desc`">{{ $t('settings.appearance.quickReactEnableDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t11`" :describedby="`${a11yId}-t11-desc`" v-model="local.quickReactEnabled" />
        </div>
      </div>

      <div v-if="local.quickReactEnabled" class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('settings.appearance.quickReactEmoji') }}</h4>
          <p class="setting-description">{{ $t('settings.appearance.quickReactEmojiDesc') }}</p>
        </div>
        <div class="setting-control">
          <button
            ref="quickReactBtn"
            type="button"
            class="quick-react-emoji-btn"
            :title="$t('settings.appearance.quickReactEmoji')"
            @click="toggleQuickReactPicker"
          >
            <img
              v-if="local.quickReactEmoji.url"
              :src="local.quickReactEmoji.url"
              :alt="local.quickReactEmoji.name"
              class="quick-react-emoji-img"
            />
            <span v-else class="quick-react-emoji-native">{{ local.quickReactEmoji.content || local.quickReactEmoji.id }}</span>
          </button>
          <EmojiPopup
            v-if="showQuickReactPicker"
            :trigger-element="quickReactTrigger"
            position="below"
            :is-reaction="true"
            :close-emoji-list="() => (showQuickReactPicker = false)"
            @sendEmoji="onQuickReactEmojiChosen"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Emoji style</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Emoji pack</h4>
          <p class="setting-description">Choose which emoji style to use throughout the app</p>
        </div>
        <div class="setting-control">
          <div class="emoji-pack-options">
            <button
              v-for="pack in packs"
              :key="pack.id"
              type="button"
              class="emoji-pack-btn"
              :class="{ active: local.emojiPack === pack.id }"
              :aria-pressed="local.emojiPack === pack.id ? 'true' : 'false'"
              @click="local.emojiPack = pack.id"
            >
              <img
                v-if="pack.previewImage"
                :src="pack.previewImage"
                alt=""
                class="pack-preview"
              />
              <span v-else class="pack-preview-native" aria-hidden="true">😀</span>
              <span>{{ pack.name }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Effects</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t12`">Enable blur &amp; glass effects</h4>
          <p class="setting-description" :id="`${a11yId}-t12-desc`">
            Many surfaces (modals, popovers, the voice dock, the sidebar) use
            <code>backdrop-filter: blur</code> for a frosted-glass look. Turn
            off for a flat / sharper UI, or if your device struggles with
            blur in voice / video calls.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t12`" :describedby="`${a11yId}-t12-desc`"
            :model-value="settings.glassEffectsEnabled !== false"
            @update:model-value="(v: boolean) => (settings.glassEffectsEnabled = v)"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">{{ $t('settings.appearance.highContrast') }}</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t13`">{{ $t('settings.appearance.highContrast') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t13-desc`">{{ $t('settings.appearance.highContrastDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t13`" :describedby="`${a11yId}-t13-desc`" 
            v-model="settings.highContrast"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t14`">{{ $t('settings.appearance.reduceMotion') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t14-desc`">{{ $t('settings.appearance.reduceMotionDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t14`" :describedby="`${a11yId}-t14-desc`" 
            v-model="settings.reduceMotion"
          />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t15`">{{ $t('settings.appearance.screenReader') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t15-desc`">{{ $t('settings.appearance.screenReaderDesc') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t15`" :describedby="`${a11yId}-t15-desc`" 
            v-model="settings.screenReaderSupport"
          />
        </div>
      </div>
      <MessageAnnouncementSetting />
    </div>

    <Transition name="savebar">
      <div v-if="hasChanges" ref="saveBarRef" class="settings-actions" role="region" :aria-label="$t('settings.appearance.unsavedChanges')" data-testid="appearance-save-bar">
        <p class="settings-actions-text">{{ $t('settings.appearance.unsavedChanges') }}</p>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="resetSettings">
          {{ $t('settings.appearance.resetSettings') }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="loading" @click="saveSettings">
          <span v-if="loading" class="loading-spinner"></span>
          {{ $t('settings.appearance.saveChanges') }}
        </button>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch, nextTick, onMounted, onBeforeUnmount, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import MessageAnnouncementSetting from '@/components/a11y/MessageAnnouncementSetting.vue'
import { useToast } from 'vue-toastification'
import type { User, Emoji } from '@/types'
import { useFloatingVideo } from '@/composables/useFloatingVideo'
import {
  useVisualTheme,
  COMMUNITY_PRESETS,
  BUILTIN_SKINS,
  type ThemePreset,
} from '@/composables/useVisualTheme'
import { useAppearanceDraft } from '@/composables/useAppearanceDraft'
import { useThemeEditorPanel } from '@/composables/useThemeEditorPanel'
import { useRouter } from 'vue-router'
import { CLOSE_USER_SETTINGS } from '@/utils/settingsHistory'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import {
  generatePreviewColors,
  decomposeBackgroundToneHex,
  canonicalizeBackgroundTone,
} from '@/utils/colorUtils'
import { isValidCssColor } from '@/utils/cssColor'
import { useEmojiPacks } from '@/services/emojiPackService'
import { useQuickReactSettings, type QuickReactEmoji } from '@/composables/useQuickReactSettings'

// Components
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import ColorPicker from '@/components/common/ColorPicker.vue'
import CssVarSwatch from '@/components/settings/user/CssVarSwatch.vue'
import ThemePaletteIdeas from '@/components/settings/user/ThemePaletteIdeas.vue'
import type { ThemeColors } from '@/utils/themeHarmony'
import Icon from '@/components/common/Icon.vue'
import EmojiPopup from '@/components/EmojiPopup.vue'

import { uid, focusElement } from '@/utils/a11y/focus'
import {
  MIRROR_HOSTS,
  MIRROR_SITES,
  MIRROR_SITE_NAMES,
  resolveMirrorPreferences,
  type MirrorSite,
  type MirrorSitePreference,
} from '@/utils/mirrorLinks'
import { useAnnouncer } from '@/composables/useAnnouncer'

// Ids pairing each switch with its visible label.
const a11yId = uid('appearance-settings')

interface Props {
  profile: User | null
  loading: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  'update-appearance': [settings: any]
}>()

const { t } = useI18n()
const toast = useToast()
const { isEnabled: floatingVideoEnabled, setEnabled: setFloatingVideoEnabled } = useFloatingVideo()
const visualTheme = useVisualTheme()
const themeEditorPanel = useThemeEditorPanel()
const router = useRouter()
const { currentPackId, packs, setCurrentPack } = useEmojiPacks()
const instanceSettings = useInstanceSettingsStore()
const quickReact = useQuickReactSettings()
const { polite } = useAnnouncer()

// Every visual-theme edit on this page is staged in `settings` (the draft) and
// previewed live; Save stores all of it, Reset restores the stored look.
const {
  draft: settings,
  isDirty: themeDirty,
  setTheme,
  setCssOverride,
  removeCssOverride,
  clearCssOverrides,
  applySkin,
  setSkinOption,
  applyPreset,
  save: saveTheme,
  discard: discardTheme,
  reload: reloadTheme,
} = useAppearanceDraft()

// Post-link mirrors of sent content, per site, with the defaults filled in.
const mirrors = computed(() => resolveMirrorPreferences(settings.value.linkMirrors))

function setMirror(site: MirrorSite, patch: MirrorSitePreference) {
  settings.value.linkMirrors = { ...(settings.value.linkMirrors ?? {}), [site]: { ...mirrors.value[site], ...patch } }
}

// Page settings stored outside the visual theme, staged the same way.
interface LocalSettings {
  floatingVideoEnabled: boolean
  emojiPack: string
  quickReactEnabled: boolean
  quickReactEmoji: QuickReactEmoji
}
const readLocal = (): LocalSettings => ({
  floatingVideoEnabled: floatingVideoEnabled.value,
  emojiPack: currentPackId.value,
  quickReactEnabled: quickReact.enabled.value,
  quickReactEmoji: { ...quickReact.emoji.value },
})
const local = ref<LocalSettings>(readLocal())
const savedLocal = ref<LocalSettings>(readLocal())
const localDirty = computed(() => JSON.stringify(local.value) !== JSON.stringify(savedLocal.value))

const hasChanges = computed(() => themeDirty.value || localDirty.value)

const titleRef = ref<HTMLElement | null>(null)
const saveBarRef = ref<HTMLElement | null>(null)

watch(hasChanges, (dirty, wasDirty) => {
  if (dirty && !wasDirty) polite(t('settings.appearance.unsavedChanges'))
})

// The save bar unmounts once the draft is clean; focus inside it would drop to
// <body>, so it moves to the page heading first.
function moveFocusOutOfSaveBar() {
  const active = document.activeElement
  if (saveBarRef.value && active instanceof Node && saveBarRef.value.contains(active)) {
    focusElement(titleRef.value)
  }
}

// Closes full-screen settings so colour edits are visible against the live
// chat and sidebars. The live editor seeds from the stored theme.
const closeUserSettings = inject(CLOSE_USER_SETTINGS, null)
const openLiveEditor = async () => {
  if (closeUserSettings) {
    if (!(await closeUserSettings())) return
  } else {
    router.back()
  }
  themeEditorPanel.open()
}

// Quick-react emoji chooser popup
const showQuickReactPicker = ref(false)
const quickReactBtn = ref<HTMLElement | null>(null)
const quickReactTrigger = computed(() => quickReactBtn.value || undefined)

function toggleQuickReactPicker() {
  showQuickReactPicker.value = !showQuickReactPicker.value
}

function onQuickReactEmojiChosen(emoji: Emoji) {
  local.value.quickReactEmoji = {
    id: emoji.id,
    name: emoji.name,
    url: emoji.url || undefined,
    // Native emoji: id is the unicode char and url is absent. Custom: undefined.
    content: emoji.content || (emoji.url ? undefined : emoji.id),
  }
  showQuickReactPicker.value = false
}

// `preview` is applied inline to each picker button so the card renders in its
// own typeface before selection.
const fontFamilyOptions: Array<{
  id: 'system' | 'pixel'
  label: string
  preview: string
}> = [
  { id: 'system', label: 'Default (Figtree)', preview: `'Figtree', sans-serif` },
  { id: 'pixel', label: 'NoRe Sans Pixel', preview: `'NoRe Sans Pixel Pro', monospace` },
]

const customPreviewColors = computed(() =>
  generatePreviewColors(
    settings.value.customBackgroundColor || '#0EA5E9',
    settings.value.customThemeMode || 'dark',
    settings.value.customBackgroundLightness ?? 0,
    settings.value.customBackgroundChroma ?? 0,
  ),
)

const showAdvancedCss = ref(false)
const colorExpanded = reactive({
  background: false,
  primary: false,
  accent: false,
})
const savedThemeName = ref('')
const importFileInput = ref<HTMLInputElement | null>(null)

// Saved themes
const savedThemesList = ref(visualTheme.getSavedCustomThemes())
const activeSavedThemeId = ref<string | null>(null)
const themeToDelete = ref<{ id: string; name: string } | null>(null)
const cancelDeleteBtn = ref<HTMLElement | null>(null)

// Checked radio of the theme set: a built-in theme id, or `saved:<id>`.
const themeChoice = computed(() =>
  activeSavedThemeId.value ? `saved:${activeSavedThemeId.value}` : settings.value.theme,
)

function refreshSavedThemes() {
  savedThemesList.value = visualTheme.getSavedCustomThemes()
}

function getSavedThemePreview(saved: { settings: Partial<typeof settings.value> }) {
  return generatePreviewColors(
    saved.settings.customBackgroundColor || '#0EA5E9',
    saved.settings.customThemeMode || 'dark',
    saved.settings.customBackgroundLightness || 0,
    saved.settings.customBackgroundChroma || 0
  )
}

function focusCheckedTheme() {
  const radios = Array.from(document.querySelectorAll<HTMLInputElement>(`input[name="${a11yId}-theme-choice"]`))
  focusElement(radios.find((r) => r.checked) ?? radios[0])
}

async function confirmDeleteSavedTheme(saved: { id: string; name: string }) {
  themeToDelete.value = saved
  await nextTick()
  focusElement(cancelDeleteBtn.value)
}

async function cancelDelete() {
  const id = themeToDelete.value?.id
  themeToDelete.value = null
  await nextTick()
  const opener = id
    ? Array.from(document.querySelectorAll<HTMLElement>('[data-saved-theme-delete]')).find((el) => el.dataset.savedThemeDelete === id)
    : null
  if (!focusElement(opener)) focusCheckedTheme()
}

async function confirmDelete() {
  if (!themeToDelete.value) return
  const id = themeToDelete.value.id
  visualTheme.deleteSavedTheme(id)
  refreshSavedThemes()
  if (activeSavedThemeId.value === id) activeSavedThemeId.value = null
  toast.success(t('settings.appearance.themeRemoved'))
  themeToDelete.value = null
  await nextTick()
  focusCheckedTheme()
}

function exportTheme() {
  const json = visualTheme.exportThemeAsJson(settings.value)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `harmony-theme-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
  toast.success(t('settings.appearance.toasts.exported'))
}

function triggerImportInput() {
  importFileInput.value?.click()
}

function handleImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const theme = visualTheme.parseThemeJson(reader.result as string, settings.value)
    if (theme) {
      Object.assign(settings.value, theme, { customCssOverrides: theme.customCssOverrides ?? {} })
      toast.success(t('settings.appearance.toasts.imported'))
    } else {
      toast.error(t('settings.appearance.toasts.invalidFile'))
    }
  }
  reader.readAsText(file)
  input.value = ''
}

function saveCurrentTheme() {
  const name = savedThemeName.value?.trim()
  if (!name) return
  const theme = visualTheme.saveCurrentThemeAsCustom(name, settings.value)
  if (theme) {
    savedThemeName.value = ''
    refreshSavedThemes()
    toast.success(t('settings.appearance.toasts.themeSaved', { name: theme.name }))
  }
}

function applySavedTheme(id: string) {
  const found = visualTheme.getSavedCustomThemes().find((theme) => theme.id === id)
  if (!found?.settings) return
  Object.assign(settings.value, JSON.parse(JSON.stringify(found.settings)), {
    theme: 'custom',
    customCssOverrides: { ...(found.settings.customCssOverrides ?? {}) },
  })
  activeSavedThemeId.value = id
}

const communityPresets = COMMUNITY_PRESETS
const PRESETS_SHOWN = 3
const showAllPresets = ref(false)
const visiblePresets = computed(() => (showAllPresets.value ? communityPresets : communityPresets.slice(0, PRESETS_SHOWN)))
const builtinSkins = BUILTIN_SKINS
const themableVariables = visualTheme.getThemableVariables()

const applyPresetTheme = (preset: ThemePreset) => {
  applyPreset(preset)
}

const invalidVar = ref<{ name: string; text: string } | null>(null)

const overrideCount = computed(() => Object.keys(settings.value.customCssOverrides || {}).length)

const getCssVarValue = (varName: string): string =>
  settings.value.customCssOverrides?.[varName] || getComputedVar(varName)

const getComputedVar = (varName: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || ''

const varInputId = (varName: string): string => `${a11yId}-var${varName.replace(/[^a-zA-Z0-9_-]/g, '')}`

const setCssOverrideFromInput = (varName: string, value: string) => {
  if (!value) return
  invalidVar.value = null
  setCssOverride(varName, value)
}

// Empty text clears the override. An invalid colour is rejected: on :root it is
// invalid at computed-value time in every var() consumer, which then falls back
// to inherit or initial; for backgrounds that is transparent.
const commitCssOverrideText = (varName: string, input: HTMLInputElement) => {
  const text = input.value.trim()
  if (!text) {
    invalidVar.value = null
    if (settings.value.customCssOverrides?.[varName]) removeCssOverride(varName)
    return
  }
  if (!isValidCssColor(text)) {
    invalidVar.value = { name: varName, text }
    input.value = settings.value.customCssOverrides?.[varName] || ''
    return
  }
  setCssOverrideFromInput(varName, text)
}

const removeCssOverrideVar = (varName: string) => {
  removeCssOverride(varName)
}

const resetAllOverrides = () => {
  clearCssOverrides()
  invalidVar.value = null
}

const themes = [
  {
    id: 'dark',
    name: 'Dark',
    description: 'A dark theme that\'s easier on the eyes.',
    preview: '#17181a',
    headerColor: '#121214',
    sidebarColor: '#121214',
    chatColor: '#17181a',
  },
  {
    id: 'light',
    name: 'Light',
    description: 'A clean, bright theme.',
    preview: '#ffffff',
    headerColor: '#f6f6f6',
    sidebarColor: '#f2f3f5',
    chatColor: '#ffffff'
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'An even darker theme for late night usage.',
    preview: '#1e2124',
    headerColor: '#1a1d20',
    sidebarColor: '#1a1d20',
    chatColor: '#1e2124'
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Create your own theme with a custom color.',
    preview: '#0EA5E9',
    headerColor: '#0284C7',
    sidebarColor: '#0284C7',
    chatColor: '#0EA5E9'
  }
]

const selectTheme = (themeId: string) => {
  setTheme(themeId as 'dark' | 'light' | 'midnight' | 'custom')
  activeSavedThemeId.value = null
  if (themeId === 'custom') {
    colorExpanded.background = false
    colorExpanded.primary = false
    colorExpanded.accent = false
  }
}

const syncBackgroundToneFromSliders = () => {
  settings.value.customBackgroundColor = canonicalizeBackgroundTone(
    settings.value.customBackgroundColor || '#0EA5E9',
    settings.value.customBackgroundLightness ?? 0,
    settings.value.customBackgroundChroma ?? 0,
    settings.value.customThemeMode || 'dark',
  )
}

const onCustomBackgroundChange = () => {
  const decomposed = decomposeBackgroundToneHex(
    settings.value.customBackgroundColor || '#0EA5E9',
    settings.value.customThemeMode || 'dark',
  )
  if (decomposed) {
    settings.value.customBackgroundLightness = decomposed.lightnessOffset
    settings.value.customBackgroundChroma = decomposed.chromaOffset
  }
}

// Suggestions carry no sidebar hue; a leftover one would clash with them.
const onPaletteIdea = (colors: ThemeColors) => {
  Object.assign(settings.value, colors, { customSidebarColor: undefined })
}

const onCustomThemeModeChange = () => {
  syncBackgroundToneFromSliders()
}

const onLightnessChange = () => {
  syncBackgroundToneFromSliders()
}

const onChromaChange = () => {
  syncBackgroundToneFromSliders()
}

/** aria-valuetext for the signed tone sliders: "+10, Lighter", "-5, Darker", "0". */
const toneValueText = (value: number | undefined, lowKey: string, highKey: string): string => {
  const n = value ?? 0
  if (n === 0) return '0'
  return t('settings.appearance.toneValue', { value: n > 0 ? `+${n}` : `${n}`, direction: t(n > 0 ? highKey : lowKey) })
}

const onFontFamilyChange = (family: 'system' | 'pixel') => {
  settings.value.fontFamily = family
}

const onSkinChange = (skinId: string | null) => {
  applySkin(skinId)
}

// Active skin manifest; undefined when "None" is selected.
const activeSkin = computed(() =>
  builtinSkins.find((s) => s.id === settings.value.activeSkinId)
)
const activeSkinOptions = computed(() => activeSkin.value?.options ?? [])

// Draft value when set, otherwise the option's declared default.
const getActiveSkinOptionValue = (optionId: string): boolean => {
  const skinId = settings.value.activeSkinId
  if (!skinId) return false
  const stored = settings.value.skinOptions?.[skinId]?.[optionId]
  return stored ?? activeSkinOptions.value.find((o) => o.id === optionId)?.default ?? false
}

const onSkinOptionToggle = (optionId: string, value: boolean) => {
  const skinId = settings.value.activeSkinId
  if (!skinId) return
  setSkinOption(skinId, optionId, value)
}

// Zoom percent.
const ZOOM_MIN = 50
const ZOOM_MAX = 200
const ZOOM_STEP = 10

const adjustZoom = (delta: number) => {
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, settings.value.zoomLevel + delta))
  if (next === settings.value.zoomLevel) return
  settings.value.zoomLevel = next
  polite(t('settings.appearance.zoomValue', { value: next }), { key: 'appearance-zoom', dedupeMs: 0 })
}

const saveSettings = () => {
  moveFocusOutOfSaveBar()
  saveTheme()
  setFloatingVideoEnabled(local.value.floatingVideoEnabled)
  setCurrentPack(local.value.emojiPack)
  quickReact.enabled.value = local.value.quickReactEnabled
  quickReact.setEmoji(local.value.quickReactEmoji)
  savedLocal.value = readLocal()
  local.value = readLocal()
  emit('update-appearance', { ...settings.value, ...local.value })
  polite(t('settings.appearance.saved'))
}

const resetSettings = () => {
  moveFocusOutOfSaveBar()
  discardTheme()
  local.value = { ...savedLocal.value, quickReactEmoji: { ...savedLocal.value.quickReactEmoji } }
  invalidVar.value = null
  activeSavedThemeId.value = null
  polite(t('settings.appearance.changesReset'))
}

onMounted(async () => {
  await visualTheme.initialize()
  reloadTheme()
  savedLocal.value = readLocal()
  local.value = readLocal()
})

// Leaving the page drops the draft; the preview reverts to the stored look.
onBeforeUnmount(() => {
  if (!hasChanges.value) return
  discardTheme()
  toast.info(t('settings.appearance.changesDiscarded'))
})
</script>

<style scoped>
.appearance-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.live-editor-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  margin-top: 14px;
  padding: 9px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-primary);
  background: var(--background-quaternary);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast);
}

.live-editor-btn:hover {
  border-color: var(--border-hover);
  background: var(--background-modifier-hover);
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--background-quaternary);
}

.section-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 20px 0;
}

.theme-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.theme-option {
  position: relative;
  display: block;
  border: 2px solid var(--background-quaternary);
  border-radius: var(--radius-md);
  padding: 16px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.theme-option:has(.theme-radio:focus-visible) {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.theme-option:hover {
  border-color: var(--h-primary, var(--harmony-primary));
}

.theme-option.active {
  border-color: var(--h-primary, var(--harmony-primary));
  background-color: color-mix(in srgb, var(--h-brand) 10%, transparent);
}

.theme-preview {
  width: 100%;
  height: 80px;
  border-radius: var(--radius-sm);
  margin-bottom: 12px;
  position: relative;
  overflow: hidden;
}

.theme-preview-content {
  width: 100%;
  height: 100%;
  position: relative;
}

.preview-header {
  height: 20px;
  width: 100%;
  opacity: 0.8;
}

.preview-sidebar {
  width: 30%;
  height: 60px;
  position: absolute;
  top: 20px;
  left: 0;
  opacity: 0.9;
}

.preview-chat {
  width: 70%;
  height: 60px;
  position: absolute;
  top: 20px;
  right: 0;
}

.theme-info {
  text-align: center;
}

.theme-name {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.theme-description {
  display: block;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0;
}

.preview-accent-dot {
  position: absolute;
  bottom: 8px;
  right: 8px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

/* Saved theme cards */
.saved-theme-wrap {
  position: relative;
}

.saved-theme-wrap > .theme-option {
  height: 100%;
  box-sizing: border-box;
}

/* Card border 2px + padding 16px + 4px inset from the preview corner. */
.saved-theme-delete-btn {
  position: absolute;
  top: 22px;
  right: 22px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: var(--text-on-primary);
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

.saved-theme-wrap:hover .saved-theme-delete-btn,
.saved-theme-wrap:focus-within .saved-theme-delete-btn {
  opacity: 1;
}

.saved-theme-delete-btn:hover {
  background: var(--error);
}

.delete-theme-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  margin-top: 8px;
}

.delete-theme-confirm p {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.delete-confirm-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.cancel-delete-btn {
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-primary);
}

.cancel-delete-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.confirm-delete-btn {
  padding: 6px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  background: var(--error-fill);
  color: var(--text-on-primary);
  border: none;
}

.confirm-delete-btn:hover {
  background: var(--error-fill-hover);
}

.custom-color-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--background-quaternary);
}

.section-subtitle {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-help {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0 0 16px 0;
  line-height: 1.5;
}

.custom-theme-mode {
  margin-bottom: 24px;
}

.custom-palette-ideas {
  max-width: 520px;
  margin-bottom: 24px;
}

.mode-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin-bottom: 8px;
}

.mode-options {
  display: flex;
  gap: 12px;
}

.mode-btn {
  flex: 1;
  padding: 12px 16px;
  border: 2px solid var(--background-quaternary);
  background-color: var(--surface-inset);
  color: var(--text-secondary);
  border-radius: var(--radius-base);
  cursor: pointer;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  transition: all 0.2s ease;
}

.mode-btn:hover {
  border-color: var(--h-primary, var(--harmony-primary));
  background-color: var(--background-quaternary);
}

.mode-btn.active {
  border-color: var(--h-primary, var(--harmony-primary));
  background-color: color-mix(in srgb, var(--h-brand) 15%, transparent);
  color: var(--text-primary);
}

.quick-react-emoji-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 2px solid var(--background-quaternary, var(--border-color));
  background-color: var(--surface-inset);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s ease;
  padding: 0;
}

.quick-react-emoji-btn:hover {
  border-color: var(--harmony-primary);
}

.quick-react-emoji-img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.quick-react-emoji-native {
  font-size: var(--font-size-2xl);
  line-height: 1;
}

.emoji-pack-options {
  display: flex;
  gap: 12px;
}

.emoji-pack-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  border: 2px solid var(--background-quaternary);
  background-color: var(--surface-inset);
  color: var(--text-secondary);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  transition: all 0.2s ease;
  min-width: 120px;
}

.emoji-pack-btn:hover {
  border-color: var(--h-primary, var(--harmony-primary));
  background-color: var(--background-quaternary);
}

.emoji-pack-btn.active {
  border-color: var(--h-primary, var(--harmony-primary));
  background-color: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  color: var(--text-primary);
}

.pack-preview {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.pack-preview-native {
  font-size: 32px;
  line-height: 1;
}

/* Skin picker (Beta) */
.beta-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: var(--font-weight-medium);
  padding: 1px 6px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-hover);
  color: var(--text-secondary);
  vertical-align: middle;
  margin-left: 8px;
}

.beta-badge-inline {
  font-size: 10px;
  padding: 0 5px;
}

.skin-options {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
  margin-top: 12px;
}

.skin-card {
  display: flex;
  flex-direction: column;
  border: 2px solid var(--background-quaternary);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  text-align: left;
  overflow: hidden;
  padding: 0;
}

.skin-card:hover {
  border-color: var(--harmony-primary);
}

.skin-card.active {
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.skin-card-preview {
  width: 100%;
  height: 140px;
  background: var(--surface-inset);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.skin-card-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.skin-card-preview-none {
  background: repeating-linear-gradient(
    45deg,
    var(--background-tertiary),
    var(--background-tertiary) 10px,
    var(--background-quaternary) 10px,
    var(--background-quaternary) 20px
  );
}

.skin-card-none-label {
  padding: 2px 10px;
  border-radius: var(--radius-full);
  background: var(--background-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.skin-card-info {
  padding: 12px 14px 14px;
}

.skin-card-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  margin: 0 0 6px 0;
  color: var(--text-primary);
}

.skin-card-description {
  font-size: var(--font-size-xs);
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.4;
}

/* Per-skin decoration toggles under the active skin card; a tighter
   `.setting-item` row so it reads as an inline detail panel. */
.skin-active-options {
  margin-top: 18px;
  padding: 14px 16px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-quaternary);
}

.skin-active-options-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.skin-option-item {
  padding: 8px 0;
  border-bottom: 1px solid var(--border-secondary);
}

.skin-option-item:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

/* Font family picker */
.font-family-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 360px;
}

.font-family-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border: 2px solid var(--background-quaternary);
  border-radius: var(--radius-md);
  background-color: var(--background-secondary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.font-family-btn:hover {
  border-color: var(--harmony-primary);
  background-color: var(--background-quaternary);
}

.font-family-btn.active {
  border-color: var(--harmony-primary);
  background-color: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
}

.font-family-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.font-family-sample {
  font-size: 13px;
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

.theme-collapse-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 24px;
}

.theme-collapse {
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--background-primary);
}

.theme-collapse-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: background 0.12s ease;
}

.theme-collapse-header:hover {
  background: var(--background-quaternary);
}

.theme-collapse-header.open {
  border-bottom: 1px solid var(--background-quaternary);
}

.theme-collapse-swatch {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-base);
  border: 1px solid var(--background-quaternary);
  flex-shrink: 0;
}

.theme-collapse-label {
  flex: 1;
  min-width: 0;
}

.theme-collapse-title {
  display: block;
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.theme-collapse-hint {
  display: block;
  font-size: 11px;
  color: var(--text-tertiary);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.theme-collapse-hex {
  font-family: 'Courier New', monospace;
  font-size: 10px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.theme-collapse-swatch-advanced {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background-quaternary) !important;
  font-family: monospace;
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  color: var(--text-secondary);
}

.theme-collapse-arrow {
  display: inline-flex;
  color: var(--text-secondary);
  flex-shrink: 0;
  transition: transform var(--transition-base);
}

.theme-collapse-arrow.open {
  transform: rotate(180deg);
}

.theme-collapse-body {
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.theme-collapse-body :deep(.color-picker) {
  width: 100%;
}

.theme-collapse-body .picker-help {
  margin: 0;
}

.theme-slider-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.picker-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin-bottom: 4px;
}

.picker-help {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0 0 12px 0;
}

/* Lightness Slider */
.lightness-slider-container {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.lightness-label {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  min-width: 50px;
  text-align: center;
}

.lightness-slider {
  flex: 1;
  height: 8px;
  border-radius: var(--radius-sm);
  background: linear-gradient(to right, 
    oklch(15% 0.02 260), 
    oklch(50% 0.02 260), 
    oklch(85% 0.02 260)
  );
  outline: none;
  appearance: none;
  cursor: pointer;
}

.lightness-slider::-webkit-slider-thumb {
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--h-primary, var(--harmony-primary));
  cursor: pointer;
  border: 3px solid var(--text-primary);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.lightness-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--h-primary, var(--harmony-primary));
  cursor: pointer;
  border: 3px solid var(--text-primary);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.lightness-value {
  text-align: center;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
  margin-top: 8px;
}

/* Chroma (Saturation) Slider */
.chroma-slider-container {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.chroma-label {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  min-width: 50px;
  text-align: center;
}

.chroma-slider {
  flex: 1;
  height: 8px;
  border-radius: var(--radius-sm);
  background: linear-gradient(to right, 
    oklch(30% 0.00 260), 
    oklch(30% 0.06 260), 
    oklch(30% 0.12 260)
  );
  outline: none;
  appearance: none;
  cursor: pointer;
}

.chroma-slider::-webkit-slider-thumb {
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--h-primary, var(--harmony-primary));
  cursor: pointer;
  border: 3px solid var(--text-primary);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.chroma-slider::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--h-primary, var(--harmony-primary));
  cursor: pointer;
  border: 3px solid var(--text-primary);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.chroma-value {
  text-align: center;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
  margin-top: 8px;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--background-quaternary);
}

.setting-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.setting-info {
  flex: 1;
  margin-right: 16px;
}

.setting-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.setting-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.setting-control {
  flex-shrink: 0;
}

.mirror-link-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.font-size-slider {
  display: flex;
  align-items: center;
  gap: 12px;
}

.slider {
  width: 120px;
  height: 4px;
  border-radius: 2px;
  background: var(--background-quaternary);
  outline: none;
  appearance: none;
}

.slider::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--h-primary, var(--harmony-primary));
  cursor: pointer;
}

.slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--h-primary, var(--harmony-primary));
  cursor: pointer;
  border: none;
}

.font-size-display {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  min-width: 40px;
  text-align: center;
}

.zoom-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.zoom-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--background-quaternary);
  background-color: var(--surface-inset);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: var(--font-weight-semibold);
  transition: all 0.15s ease;
}

.zoom-btn:hover:not([aria-disabled="true"]) {
  background-color: var(--background-quaternary);
}

.zoom-btn[aria-disabled="true"] {
  opacity: 0.5;
  cursor: not-allowed;
}

.zoom-display {
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  min-width: 60px;
  text-align: center;
}

.select-input {
  padding: 8px 12px;
  background-color: var(--surface-inset);
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.select-input:focus {
  outline: none;
  border-color: var(--h-primary, var(--harmony-primary));
}

/* Unsaved-changes bar, pinned to the bottom of the settings scroller. */
.settings-actions {
  position: sticky;
  bottom: var(--space-4);
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-6);
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  background: var(--background-floating);
  box-shadow: var(--shadow-large);
}

.settings-actions-text {
  flex: 1;
  min-width: 160px;
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

@media (max-width: 480px) {
  .settings-actions-text {
    flex-basis: 100%;
  }

  .settings-actions .btn {
    flex: 1;
    min-height: 40px;
  }
}

.savebar-enter-active,
.savebar-leave-active {
  transition: opacity var(--transition-base), transform var(--transition-base);
}

.savebar-enter-from,
.savebar-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.btn {
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: none;
  font-weight: var(--font-weight-medium);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background-color: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled) {
  background-color: var(--harmony-primary-fill-hover);
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--background-quaternary);
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid var(--text-on-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .settings-section {
    padding: 16px;
  }
  
  .theme-options {
    grid-template-columns: 1fr;
  }
  
  .setting-item {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  
  .setting-info {
    margin-right: 0;
  }
  
  .font-size-slider {
    justify-content: space-between;
  }
}

/* Community Presets */
.presets-more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 6px 10px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.presets-more:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.presets-more-chevron {
  transition: transform 0.15s ease;
}

.presets-more-chevron.open {
  transform: rotate(180deg);
}

.community-presets-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--background-quaternary);
}

.presets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.preset-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--background-secondary);
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color var(--transition-fast);
  text-align: left;
  color: inherit;
}

.preset-card:hover {
  border-color: var(--harmony-primary);
}

.preset-swatch {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  flex-shrink: 0;
}

.preset-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.preset-name {
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.preset-desc {
  font-size: 11px;
  color: var(--text-secondary);
}

/* Import / Export */
.theme-import-export-section {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid var(--background-quaternary);
}

.import-export-buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.export-btn,
.import-btn {
  min-width: 120px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.hidden-file-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

.save-theme-row {
  display: flex;
  gap: 12px;
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--background-quaternary);
}

.theme-name-input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid var(--background-quaternary);
  background: var(--background-secondary);
  color: var(--text-primary);
  border-radius: var(--radius-base);
  font-size: var(--font-size-sm);
}

.theme-name-input::placeholder {
  color: var(--text-tertiary);
}

.save-theme-btn {
  padding: 10px 20px;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-base);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  white-space: nowrap;
}

.save-theme-btn:hover:not(:disabled) {
  background: var(--harmony-primary-fill-hover);
}

.save-theme-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.section-help.muted {
  color: var(--text-tertiary);
  font-style: italic;
}

.advanced-css-collapse {
  margin-top: 24px;
}

.var-category-label {
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
  padding: 10px 2px 4px;
  border-top: 1px solid var(--background-quaternary);
}

.var-category-label.is-first {
  border-top: none;
  padding-top: 0;
}

.override-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  line-height: 1;
}

.css-overrides-panel {
  gap: 2px;
}

.overrides-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  margin-bottom: 16px;
  background: var(--background-tertiary);
  border-radius: var(--radius-base);
  border: 1px solid var(--background-quaternary);
}

.override-summary {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.reset-all-btn {
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--error);
  background: transparent;
  color: var(--text-danger);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: all 0.15s;
}

.reset-all-btn:hover {
  background: var(--error-fill);
  color: var(--text-on-primary);
}

.var-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  border-left: 2px solid transparent;
  transition: border-color 0.15s;
}

.var-item:hover {
  background: var(--background-quaternary);
}

.var-item.has-override {
  border-left-color: var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 4%, transparent);
}

.var-name {
  font-size: var(--font-size-xs);
  font-family: monospace;
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 180px;
}

.var-item.has-override .var-name {
  color: var(--text-primary);
}

.var-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  justify-content: flex-end;
}

.var-swatch {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-hover);
  flex-shrink: 0;
}

.var-text-input {
  width: 140px;
  padding: 4px 8px;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 11px;
  font-family: monospace;
}

.var-text-input::placeholder {
  color: var(--text-muted);
}

.var-text-input.invalid {
  border-color: var(--error);
}

.var-reset-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--font-size-sm);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.var-reset-btn:hover {
  color: var(--text-danger);
  background: color-mix(in srgb, var(--error) 10%, transparent);
}
</style>