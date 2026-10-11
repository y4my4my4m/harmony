<template>
  <div class="unified-notification-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.notifications.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.notifications.description') }}
      </p>
    </div>

    <!-- Do Not Disturb Section -->
    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">{{ $t('user.dnd') }}</h3>
        <div class="dnd-status" :class="{ active: isDndActive }">
          {{ isDndActive ? t('settings.notifications.dnd.active') : t('settings.notifications.dnd.inactive') }}
        </div>
      </div>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t1`">{{ $t('user.dnd') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t1-desc`">{{ t('settings.notifications.dnd.description') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t1`" :describedby="`${a11yId}-t1-desc`" 
            v-model="preferences.dnd_enabled"
            @change="updatePreferences"
          />
        </div>
      </div>

      <div v-if="preferences.dnd_enabled" class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-quiet`">{{ t('settings.notifications.quietHours.title') }}</h4>
          <p class="setting-description" :id="`${a11yId}-quiet-desc`">{{ t('settings.notifications.quietHours.description') }}</p>
        </div>
        <div
          class="setting-control time-range"
          role="group"
          :aria-labelledby="`${a11yId}-quiet`"
          :aria-describedby="`${a11yId}-quiet-desc`"
        >
          <label class="sr-only" :for="`${a11yId}-quiet-start`">{{ t('settings.notifications.quietHours.start') }}</label>
          <input
            :id="`${a11yId}-quiet-start`"
            type="time"
            :value="dndStartTimeLocal"
            @change="onDndStartChange"
            class="time-input"
            data-testid="quiet-hours-start"
          />
          <span class="time-separator" aria-hidden="true">{{ t('settings.notifications.quietHours.to') }}</span>
          <label class="sr-only" :for="`${a11yId}-quiet-end`">{{ t('settings.notifications.quietHours.end') }}</label>
          <input
            :id="`${a11yId}-quiet-end`"
            type="time"
            :value="dndEndTimeLocal"
            @change="onDndEndChange"
            class="time-input"
            data-testid="quiet-hours-end"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">{{ isMobileClient ? t('settings.notifications.enableMobile') : t('settings.notifications.enableDesktop') }}</h3>
        <div class="permission-status">
          <div v-if="!systemNotificationsAvailable" class="permission-info">
            <Icon name="alert-circle" class="permission-denied" aria-hidden="true" />
            <span class="permission-text">{{ isMobileClient ? t('settings.notifications.permission.unsupportedMobile') : t('settings.notifications.permission.unsupported') }}</span>
          </div>
          <template v-else>
            <div class="permission-info">
              <Icon :name="permissionIcon" :class="permissionClass" aria-hidden="true" />
              <span class="permission-text">{{ permissionText }}</span>
            </div>
            <button
              v-if="!hasNotificationPermission"
              @click="requestPermission"
              class="permission-btn"
              :disabled="isRequestingPermission"
            >
              <Icon v-if="isRequestingPermission" name="loader" class="spinning" aria-hidden="true" />
              <span>{{ isRequestingPermission ? t('common.loading') : t('settings.notifications.permission.grant') }}</span>
            </button>
          </template>
        </div>
      </div>
      
      <div class="notification-categories">
        <!-- Chat Notifications -->
        <div class="notification-category">
          <div class="category-header">
            <Icon name="message-circle" class="category-icon chat" :size="20" aria-hidden="true" />
            <div class="category-info">
              <h4 class="category-title" :id="`${a11yId}-t2`">{{ $t('navigation.chat') }} & {{ $t('activitypub.messages') }}</h4>
              <p class="category-description" :id="`${a11yId}-t2-desc`">{{ t('settings.notifications.chat.description') }}</p>
            </div>
            <ToggleSwitch :labelledby="`${a11yId}-t2`" :describedby="`${a11yId}-t2-desc`" 
              v-model="preferences.desktop_notifications"
              @change="updatePreferences"
            />
          </div>
          
          <div v-if="preferences.desktop_notifications" class="category-settings">
            <div class="notification-type-grid">
              <div class="notification-type" v-for="type in chatNotificationTypes" :key="type.key">
                <div class="type-header">
                  <Icon :name="type.icon" class="type-icon" aria-hidden="true" />
                  <div class="type-info">
                    <span class="type-label">{{ type.label }}</span>
                    <span class="type-description">{{ type.description }}</span>
                  </div>
                </div>
                <div class="type-controls">
                  <div class="control-group">
                    <Icon name="monitor" class="control-icon" aria-hidden="true" />
                    <ToggleSwitch 
                      :label="t('a11y.notifications.desktopFor', { type: type.name })"
                      v-model="(preferences as any)[type.desktopKey]"
                      @change="updatePreferences"
                      size="small"
                    />
                  </div>
                  <div class="control-group">
                    <Icon name="volume-2" class="control-icon" aria-hidden="true" />
                    <ToggleSwitch 
                      :label="t('a11y.notifications.soundFor', { type: type.name })"
                      v-model="(preferences as any)[type.soundKey]"
                      @change="updatePreferences"
                      size="small"
                    />
                  </div>
                  <button 
                    type="button"
                    class="test-btn" 
                    :aria-label="t('a11y.notifications.testFor', { type: type.name })"
                    :title="t('a11y.notifications.testFor', { type: type.name })"
                    :aria-disabled="isTestingType === type.testType || undefined"
                    :aria-busy="isTestingType === type.testType || undefined"
                    data-testid="notification-test"
                    @click="testNotification(type.testType as NotificationType)"
                  >
                    <Icon v-if="isTestingType === type.testType" name="loader" class="spinning" aria-hidden="true" />
                    <Icon v-else name="play" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div class="notification-type" data-testid="newcomer-alerts-preference">
                <div class="type-header">
                  <Icon name="user-plus" class="type-icon" aria-hidden="true" />
                  <div class="type-info">
                    <span class="type-label">{{ $t('newcomerAlerts.preference.label') }}</span>
                    <span class="type-description">{{ $t('newcomerAlerts.preference.description') }}</span>
                  </div>
                </div>
                <div class="type-controls">
                  <div class="control-group">
                    <Icon name="bell" class="control-icon" aria-hidden="true" />
                    <ToggleSwitch
                      v-model="preferences.newcomer_alerts"
                      :label="$t('newcomerAlerts.preference.label')"
                      @change="updatePreferences"
                      size="small"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ActivityPub Notifications -->
        <div class="notification-category">
          <div class="category-header">
            <Icon name="globe" class="category-icon activitypub" aria-hidden="true" />
            <div class="category-info">
              <h4 class="category-title" :id="`${a11yId}-t6`">{{ t('settings.notifications.activitypub.title') }}</h4>
              <p class="category-description" :id="`${a11yId}-t6-desc`">{{ t('settings.notifications.activitypub.description') }}</p>
            </div>
            <ToggleSwitch :labelledby="`${a11yId}-t6`" :describedby="`${a11yId}-t6-desc`" 
              v-model="preferences.activitypub_notifications"
              @change="updatePreferences"
            />
          </div>
          
          <div v-if="preferences.activitypub_notifications" class="category-settings">
            <div class="notification-type-grid">
              <div class="notification-type" v-for="type in activityPubNotificationTypes" :key="type.key">
                <div class="type-header">
                  <Icon :name="type.icon" class="type-icon" aria-hidden="true" />
                  <div class="type-info">
                    <span class="type-label">{{ type.label }}</span>
                    <span class="type-description">{{ type.description }}</span>
                  </div>
                </div>
                <div class="type-controls">
                  <div class="control-group">
                    <Icon name="monitor" class="control-icon" aria-hidden="true" />
                    <ToggleSwitch 
                      :label="t('a11y.notifications.desktopFor', { type: type.name })"
                      v-model="(preferences as any)[type.desktopKey]"
                      @change="updatePreferences"
                      size="small"
                    />
                  </div>
                  <div class="control-group">
                    <Icon name="volume-2" class="control-icon" aria-hidden="true" />
                    <ToggleSwitch 
                      :label="t('a11y.notifications.soundFor', { type: type.name })"
                      v-model="(preferences as any)[type.soundKey]"
                      @change="updatePreferences"
                      size="small"
                    />
                  </div>
                  <button 
                    type="button"
                    class="test-btn" 
                    :aria-label="t('a11y.notifications.testFor', { type: type.name })"
                    :title="t('a11y.notifications.testFor', { type: type.name })"
                    :aria-disabled="isTestingType === type.testType || undefined"
                    :aria-busy="isTestingType === type.testType || undefined"
                    data-testid="notification-test"
                    @click="testNotification(type.testType as NotificationType)"
                  >
                    <Icon v-if="isTestingType === type.testType" name="loader" class="spinning" aria-hidden="true" />
                    <Icon v-else name="play" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Sound Settings Section -->
    <div class="settings-section">
      <h3 class="section-title">{{ t('settings.notifications.sound.title') }}</h3>
      <p class="section-description">{{ t('settings.notifications.sound.description') }}</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">
            <label :for="`${a11yId}-volume`">{{ t('a11y.notifications.volume') }}</label>
          </h4>
          <p class="setting-description" :id="`${a11yId}-volume-desc`">{{ t('settings.notifications.sound.volumeDescription') }}</p>
        </div>
        <div class="setting-control">
          <div class="volume-control">
            <Icon name="volume-1" aria-hidden="true" />
            <input 
              :id="`${a11yId}-volume`"
              type="range" 
              min="0" 
              max="100" 
              v-model.number="soundVolume"
              :aria-describedby="`${a11yId}-volume-desc`"
              :aria-valuetext="`${soundVolume}%`"
              class="volume-slider"
              data-testid="notification-volume"
              @input="onVolumeChange"
            />
            <Icon name="volume-2" aria-hidden="true" />
            <span class="volume-value" aria-hidden="true">{{ soundVolume }}%</span>
          </div>
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t9`">{{ t('settings.notifications.sound.voiceActivity') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t9-desc`">{{ t('settings.notifications.sound.voiceActivityDescription') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t9`" :describedby="`${a11yId}-t9-desc`" 
            v-model="preferences.sound_voice_activity"
            @change="updatePreferences"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="section-header">
        <h3 class="section-title">
          <Icon name="smartphone" class="section-icon" aria-hidden="true" />
          {{ isNativeClient && !isAndroidClient ? t('settings.notifications.push.titleOther') : t('settings.notifications.push.title') }}
        </h3>
        <div class="push-status-badge" :class="isNativeClient ? 'available' : pushStatusClass">
          <Icon :name="isNativeClient ? 'info' : pushStatusIcon" aria-hidden="true" />
          <span>{{ pushStatusBadgeText }}</span>
        </div>
      </div>
      <p class="section-description">
        {{ pushSectionDescription }}
      </p>

      <AndroidPushSettings v-if="isAndroidClient" />

      <!-- Native mobile app other than Android: no background push transport -->
      <div v-else-if="isNativeMobile" class="push-warning">
        <Icon name="info" aria-hidden="true" />
        <div>
          <strong>{{ t('settings.notifications.push.nativeMobileTitle') }}</strong>
          <p>{{ t('settings.notifications.push.nativeMobileText') }}</p>
        </div>
      </div>

      <!-- iOS PWA Warning -->
      <div v-if="!isNativeClient && pushNotifications.requiresPWA.value" class="push-warning">
        <Icon name="info" aria-hidden="true" />
        <div>
          <strong>{{ t('settings.notifications.push.iosTitle') }}</strong>
          <p>{{ t('settings.notifications.push.iosText') }}</p>
        </div>
      </div>

      <!-- Not Supported Warning -->
      <div v-if="!isNativeClient && !pushNotifications.isSupported.value" class="push-warning error">
        <Icon name="alert-triangle" aria-hidden="true" />
        <div>
          <strong>{{ t('settings.notifications.push.unsupportedTitle') }}</strong>
          <p>{{ t('settings.notifications.push.unsupportedText') }}</p>
        </div>
      </div>

      <!-- Permission Denied Warning -->
      <div v-else-if="!isNativeClient && pushNotifications.permission.value === 'denied'" class="push-warning error">
        <Icon name="x-circle" aria-hidden="true" />
        <div>
          <strong>{{ t('settings.notifications.push.blockedTitle') }}</strong>
          <p>{{ t('settings.notifications.push.blockedText') }}</p>
        </div>
      </div>

      <!-- Push error (e.g. 429) with Retry -->
      <div v-else-if="pushNotifications.error.value && !isAndroidClient" class="push-warning error push-error-with-retry">
        <Icon name="alert-triangle" aria-hidden="true" />
        <div>
          <strong>{{ t('settings.notifications.push.errorTitle') }}</strong>
          <p>{{ pushNotifications.error.value }}</p>
          <button
            class="retry-btn"
            :disabled="pushNotifications.isLoading.value"
            @click="pushNotifications.retryInitialize"
          >
            <Icon v-if="pushNotifications.isLoading.value" name="loader" class="spinning" aria-hidden="true" />
            <Icon v-else name="refresh-cw" aria-hidden="true" />
            {{ t('common.retry') }}
          </button>
        </div>
      </div>

      <!-- Subscribe/Unsubscribe Buttons (web push - browser only) -->
      <div v-if="!isNativeClient && pushNotifications.isSupported.value" class="push-actions">
        <button 
          v-if="!pushNotifications.isSubscribed.value"
          @click="handlePushSubscribe"
          class="push-subscribe-btn"
          :disabled="pushNotifications.isLoading.value || !pushNotifications.canSubscribe.value"
        >
          <Icon v-if="pushNotifications.isLoading.value" name="loader" class="spinning" aria-hidden="true" />
          <Icon v-else name="bell" aria-hidden="true" />
          <span>{{ t('settings.notifications.push.turnOn') }}</span>
        </button>

        <button 
          v-else
          @click="handlePushUnsubscribe"
          class="push-unsubscribe-btn"
          :disabled="pushNotifications.isLoading.value"
        >
          <Icon v-if="pushNotifications.isLoading.value" name="loader" class="spinning" aria-hidden="true" />
          <Icon v-else name="bell-off" aria-hidden="true" />
          <span>{{ t('settings.notifications.push.turnOff') }}</span>
        </button>

        <button 
          v-if="pushNotifications.isSubscribed.value"
          @click="handleTestPush"
          class="push-test-btn"
          :disabled="pushNotifications.isLoading.value"
        >
          <Icon v-if="isTestingPush" name="loader" class="spinning" aria-hidden="true" />
          <Icon v-else name="send" aria-hidden="true" />
          <span>{{ t('settings.notifications.push.test') }}</span>
        </button>
      </div>

      <!-- Push preferences: account-wide, apply to every subscribed device -->
      <div v-if="pushNotifications.isSubscribed.value || pushNotifications.subscriptions.value.length > 0" class="push-preferences">
        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label" :id="`${a11yId}-t10`">{{ t('settings.notifications.push.toMyDevices') }}</h4>
            <p class="setting-description" :id="`${a11yId}-t10-desc`">{{ t('settings.notifications.push.toMyDevicesDescription') }}</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch :labelledby="`${a11yId}-t10`" :describedby="`${a11yId}-t10-desc`"
              v-model="preferences.push_notifications"
              @change="updatePreferences"
            />
          </div>
        </div>

        <template v-if="preferences.push_notifications">
          <div class="setting-item">
            <div class="setting-info">
              <h4 class="setting-label" :id="`${a11yId}-t11`">{{ t('settings.notifications.push.awayOnly') }}</h4>
              <p class="setting-description" :id="`${a11yId}-t11-desc`">{{ t('settings.notifications.push.awayOnlyDescription') }}</p>
            </div>
            <div class="setting-control">
              <ToggleSwitch :labelledby="`${a11yId}-t11`" :describedby="`${a11yId}-t11-desc`"
                v-model="preferences.push_offline_only"
                @change="updatePreferences"
              />
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <h4 class="setting-label" :id="`${a11yId}-t12`">{{ t('settings.notifications.push.mentions') }}</h4>
              <p class="setting-description" :id="`${a11yId}-t12-desc`">{{ t('settings.notifications.push.mentionsDescription') }}</p>
            </div>
            <div class="setting-control">
              <ToggleSwitch :labelledby="`${a11yId}-t12`" :describedby="`${a11yId}-t12-desc`"
                v-model="preferences.push_mentions"
                @change="updatePreferences"
              />
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-info">
              <h4 class="setting-label" :id="`${a11yId}-t13`">{{ t('settings.notifications.push.dms') }}</h4>
              <p class="setting-description" :id="`${a11yId}-t13-desc`">{{ t('settings.notifications.push.dmsDescription') }}</p>
            </div>
            <div class="setting-control">
              <ToggleSwitch :labelledby="`${a11yId}-t13`" :describedby="`${a11yId}-t13-desc`"
                v-model="preferences.push_dms"
                @change="updatePreferences"
              />
            </div>
          </div>
        </template>
      </div>

      <!-- Native client with nothing to manage -->
      <p
        v-if="isNativeClient && !isAndroidClient && !pushNotifications.isSubscribed.value && pushNotifications.subscriptions.value.length === 0"
        class="push-empty-note"
      >
        {{ t('settings.notifications.push.noDevices') }}
      </p>

      <!-- Subscribed Devices List -->
      <div v-if="pushNotifications.subscriptions.value.length > 0" class="subscribed-devices">
        <h4 class="devices-title" :id="`${a11yId}-devices`">
          <Icon name="devices" aria-hidden="true" />
          {{ t('settings.notifications.devices.title', { count: pushNotifications.subscriptions.value.length }) }}
        </h4>
        <ul class="device-list" :aria-labelledby="`${a11yId}-devices`">
          <li
            v-for="sub in pushNotifications.subscriptions.value" 
            :key="sub.id" 
            class="device-item"
          >
            <div class="device-info">
              <Icon :name="getDeviceIcon(sub.user_agent)" class="device-icon" aria-hidden="true" />
              <div class="device-details">
                <span class="device-name">
                  {{ sub.device_name || getDeviceName(sub.user_agent) }}
                  <span v-if="sub.endpoint === pushNotifications.currentEndpoint.value" class="device-current">{{ t('security.sessions.thisDevice') }}</span>
                </span>
                <span class="device-date">
                  {{ t('settings.notifications.devices.added', { when: formatDate(sub.created_at) }) }}<template v-if="sub.transport === 'fcm'"> · Google (FCM)</template><template v-else-if="sub.transport === 'unifiedpush'"> · UnifiedPush</template><template v-if="sub.failure_count >= 5"> · {{ t('security.sessions.otherPush.unreachable') }}</template>
                </span>
              </div>
            </div>
            <button 
              type="button"
              @click="handleRemoveDevice(sub)"
              class="device-remove-btn"
              :aria-label="t('settings.notifications.devices.remove', { device: sub.device_name || getDeviceName(sub.user_agent) })"
              :title="t('settings.notifications.devices.remove', { device: sub.device_name || getDeviceName(sub.user_agent) })"
            >
              <Icon name="x" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </div>
    </div>


    <!-- Haptic Feedback Section (mobile devices only) -->
    <div class="settings-section" v-if="hapticsAvailable">
      <div class="section-header">
        <h3 class="section-title">{{ t('settings.notifications.haptics.title') }}</h3>
        <div class="haptic-status" :class="{ active: hapticSettings.isEnabled.value }">
          {{ hapticSettings.isEnabled.value ? t('settings.notifications.haptics.enabled') : t('settings.notifications.haptics.disabled') }}
        </div>
      </div>
      <p class="section-description">{{ t('settings.notifications.haptics.description') }}</p>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label" :id="`${a11yId}-t14`">{{ t('settings.notifications.haptics.enable') }}</h4>
          <p class="setting-description" :id="`${a11yId}-t14-desc`">{{ t('settings.notifications.haptics.enableDescription') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch :labelledby="`${a11yId}-t14`" :describedby="`${a11yId}-t14-desc`" 
            v-model="hapticSettings.isEnabled.value"
          />
        </div>
      </div>

      <div v-if="hapticSettings.isEnabled.value" class="haptic-categories">
        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label" :id="`${a11yId}-t15`">{{ t('settings.notifications.haptics.messages') }}</h4>
            <p class="setting-description" :id="`${a11yId}-t15-desc`">{{ t('settings.notifications.haptics.messagesDescription') }}</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch :labelledby="`${a11yId}-t15`" :describedby="`${a11yId}-t15-desc`" 
              v-model="hapticSettings.hapticTriggers.value.messages"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label" :id="`${a11yId}-t16`">{{ t('settings.notifications.haptics.reactions') }}</h4>
            <p class="setting-description" :id="`${a11yId}-t16-desc`">{{ t('settings.notifications.haptics.reactionsDescription') }}</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch :labelledby="`${a11yId}-t16`" :describedby="`${a11yId}-t16-desc`" 
              v-model="hapticSettings.hapticTriggers.value.reactions"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label" :id="`${a11yId}-t17`">{{ t('settings.notifications.haptics.navigation') }}</h4>
            <p class="setting-description" :id="`${a11yId}-t17-desc`">{{ t('settings.notifications.haptics.navigationDescription') }}</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch :labelledby="`${a11yId}-t17`" :describedby="`${a11yId}-t17-desc`" 
              v-model="hapticSettings.hapticTriggers.value.navigation"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label" :id="`${a11yId}-t18`">{{ t('settings.notifications.haptics.voice') }}</h4>
            <p class="setting-description" :id="`${a11yId}-t18-desc`">{{ t('settings.notifications.haptics.voiceDescription') }}</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch :labelledby="`${a11yId}-t18`" :describedby="`${a11yId}-t18-desc`" 
              v-model="hapticSettings.hapticTriggers.value.voice"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label" :id="`${a11yId}-t19`">{{ t('settings.notifications.haptics.interactions') }}</h4>
            <p class="setting-description" :id="`${a11yId}-t19-desc`">{{ t('settings.notifications.haptics.interactionsDescription') }}</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch :labelledby="`${a11yId}-t19`" :describedby="`${a11yId}-t19-desc`" 
              v-model="hapticSettings.hapticTriggers.value.interactions"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label" :id="`${a11yId}-t20`">{{ t('settings.notifications.haptics.toggles') }}</h4>
            <p class="setting-description" :id="`${a11yId}-t20-desc`">{{ t('settings.notifications.haptics.togglesDescription') }}</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch :labelledby="`${a11yId}-t20`" :describedby="`${a11yId}-t20-desc`" 
              v-model="hapticSettings.hapticTriggers.value.toggles"
              size="small"
            />
          </div>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <h4 class="setting-label" :id="`${a11yId}-t21`">{{ t('settings.notifications.haptics.destructive') }}</h4>
            <p class="setting-description" :id="`${a11yId}-t21-desc`">{{ t('settings.notifications.haptics.destructiveDescription') }}</p>
          </div>
          <div class="setting-control">
            <ToggleSwitch :labelledby="`${a11yId}-t21`" :describedby="`${a11yId}-t21-desc`" 
              v-model="hapticSettings.hapticTriggers.value.destructive"
              size="small"
            />
          </div>
        </div>

        <div class="haptic-test">
          <button type="button" @click="testHaptic" class="test-haptic-btn">
            <Icon name="zap" aria-hidden="true" />
            <span>{{ t('settings.notifications.haptics.test') }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Test All Section -->
    <div class="settings-section">
      <h3 class="section-title">{{ t('settings.notifications.test.title') }}</h3>
      <p class="section-description">{{ t('settings.notifications.test.description') }}</p>
      
      <div class="test-actions">
        <button 
          type="button"
          @click="testAllNotifications"
          class="test-all-btn"
          :aria-disabled="isTesting || undefined"
          :aria-busy="isTesting || undefined"
        >
          <Icon v-if="isTesting" name="loader" class="spinning" aria-hidden="true" />
          <Icon v-else name="zap" aria-hidden="true" />
          <span>{{ isTesting ? t('settings.notifications.test.testing') : t('settings.notifications.test.all') }}</span>
        </button>
        
        <button 
          type="button"
          @click="resetToDefaults"
          class="reset-btn"
          :aria-disabled="isAtDefaults || undefined"
        >
          <Icon name="rotate-ccw" aria-hidden="true" />
          <span>{{ t('settings.notifications.test.reset') }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { useNotificationStore } from '@/stores/useNotification'
import { useToast } from 'vue-toastification'
import type { NotificationPreferences, NotificationType } from '@/types'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Icon from '@/components/common/Icon.vue'
import { useUserData } from '@/composables/useUserData'
import { usePushNotifications } from '@/composables/usePushNotifications'
import { isTauri, isTauriMobile, isMobileDevice, supportsHaptics } from '@/utils/platform'
import { useHapticSettings } from '@/composables/useHapticSettings'
import { isAndroidApp } from '@/services/androidPush'
import AndroidPushSettings from '@/components/settings/user/AndroidPushSettings.vue'

import { uid } from '@/utils/a11y/focus'

// Ids pairing each switch with its visible label.
const a11yId = uid('notification-settings')

const { t } = useI18n()

// Stores
const notificationStore = useNotificationStore()
const toast = useToast()
const userData = useUserData()
const pushNotifications = usePushNotifications()
const hapticSettings = useHapticSettings()
const isNativeClient = isTauri()
const isNativeMobile = isTauriMobile()
const isAndroidClient = isAndroidApp()
const isMobileClient = isMobileDevice()
const hapticsAvailable = supportsHaptics()
const systemNotificationsAvailable = isNativeClient || typeof Notification !== 'undefined'

// Test haptic feedback
const testHaptic = () => {
  hapticSettings.hapticManager.trigger({ pattern: 'success' })
  toast.success(t('settings.notifications.haptics.sent'))
}

// State (initial values double as the factory defaults for reset)
const DEFAULT_PREFERENCES: Omit<NotificationPreferences, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
  desktop_notifications: true,
  desktop_mentions: true,
  desktop_dms: true,
  desktop_reactions: false,
  desktop_replies: true,
  desktop_chat_messages: true,
  sound_notifications: true,
  sound_mentions: true,
  sound_dms: true,
  sound_reactions: false,
  sound_replies: true,
  sound_chat_messages: true,
  sound_voice_activity: true,
  push_notifications: true,
  push_mentions: true,
  push_dms: true,
  push_offline_only: true,
  newcomer_alerts: true,
  email_notifications: false,
  email_digest: false,
  email_digest_frequency: 'weekly',
  dnd_enabled: false,
  dnd_start_time: '22:00:00',
  dnd_end_time: '08:00:00',
  activitypub_notifications: true,
  activitypub_follows: true,
  activitypub_favorites: true,
  activitypub_reblogs: true,
  activitypub_mentions: true,
  activitypub_replies: true,
  activitypub_follow_requests: true,
  activitypub_desktop_notifications: true,
  activitypub_desktop_follows: true,
  activitypub_desktop_favorites: false,
  activitypub_desktop_reblogs: false,
  activitypub_desktop_mentions: true,
  activitypub_desktop_replies: true,
  activitypub_sound_notifications: true,
  activitypub_sound_follows: true,
  activitypub_sound_favorites: false,
  activitypub_sound_reblogs: false,
  activitypub_sound_mentions: true,
  activitypub_sound_replies: true,
}

const preferences = reactive<NotificationPreferences>({
  id: '',
  user_id: '',
  created_at: '',
  updated_at: '',
  ...DEFAULT_PREFERENCES,
})

const originalPreferences = ref<NotificationPreferences>({} as NotificationPreferences)
const hasNotificationPermission = ref(false)
const isRequestingPermission = ref(false)
const isTesting = ref(false)
const isTestingType = ref<string | null>(null)
const soundVolume = ref(70)
const isTestingPush = ref(false)

// Notification type configurations. `name` is the label qualified for the
// assistive names of the per-type controls ("Fediverse mentions" vs "Mentions").
interface NotificationTypeRow {
  key: string
  label: string
  name: string
  description: string
  icon: string
  desktopKey: string
  soundKey: string
  testType: string
}

const typeRow = (
  key: string,
  i18nKey: string,
  icon: string,
  desktopKey: string,
  soundKey: string,
  testType: string,
  fediverse = false,
): NotificationTypeRow => {
  const label = t(`settings.notifications.types.${i18nKey}.label`)
  return {
    key,
    label,
    name: fediverse ? t(`settings.notifications.types.${i18nKey}.name`) : label,
    description: t(`settings.notifications.types.${i18nKey}.description`),
    icon,
    desktopKey,
    soundKey,
    testType,
  }
}

const chatNotificationTypes = computed<NotificationTypeRow[]>(() => [
  typeRow('desktop_chat_messages', 'chatMessages', 'message-square', 'desktop_chat_messages', 'sound_chat_messages', 'chat_message'),
  typeRow('desktop_mentions', 'mentions', 'at-sign', 'desktop_mentions', 'sound_mentions', 'mention'),
  typeRow('desktop_dms', 'dms', 'message-circle', 'desktop_dms', 'sound_dms', 'dm'),
  typeRow('desktop_replies', 'replies', 'corner-down-left', 'desktop_replies', 'sound_replies', 'reply'),
  typeRow('desktop_reactions', 'reactions', 'smile', 'desktop_reactions', 'sound_reactions', 'reaction'),
])

const activityPubNotificationTypes = computed<NotificationTypeRow[]>(() => [
  typeRow('activitypub_follows', 'apFollows', 'user-plus', 'activitypub_desktop_follows', 'activitypub_sound_follows', 'activitypub_follow', true),
  typeRow('activitypub_mentions', 'apMentions', 'at-sign', 'activitypub_desktop_mentions', 'activitypub_sound_mentions', 'activitypub_mention', true),
  typeRow('activitypub_replies', 'apReplies', 'message-circle', 'activitypub_desktop_replies', 'activitypub_sound_replies', 'activitypub_reply', true),
  typeRow('activitypub_favorites', 'apFavorites', 'heart', 'activitypub_desktop_favorites', 'activitypub_sound_favorites', 'activitypub_favorite', true),
  typeRow('activitypub_reblogs', 'apReblogs', 'repeat', 'activitypub_desktop_reblogs', 'activitypub_sound_reblogs', 'activitypub_reblog', true),
  typeRow('activitypub_follow_requests', 'apFollowRequests', 'user-check', 'activitypub_desktop_follows', 'activitypub_sound_follows', 'activitypub_follow_request', true),
])

// Computed properties
const isDndActive = computed(() => notificationStore.isDndActive)

const isAtDefaults = computed(() =>
  (Object.keys(DEFAULT_PREFERENCES) as Array<keyof typeof DEFAULT_PREFERENCES>).every(
    (key) => preferences[key] === DEFAULT_PREFERENCES[key]
  )
)

const permissionIcon = computed(() => {
  return hasNotificationPermission.value ? 'check-circle' : 'alert-circle'
})

const permissionClass = computed(() => {
  return hasNotificationPermission.value ? 'permission-granted' : 'permission-denied'
})

const permissionText = computed(() => {
  const generic = isNativeClient || isMobileClient
  if (hasNotificationPermission.value) {
    return generic ? t('settings.notifications.permission.enabled') : t('settings.notifications.permission.desktopEnabled')
  }
  return generic ? t('settings.notifications.permission.required') : t('settings.notifications.permission.desktopRequired')
})

// Methods
const loadPreferences = () => {
  const currentPreferences = notificationStore.preferences
  if (currentPreferences) {
    Object.assign(preferences, currentPreferences)
    originalPreferences.value = { ...currentPreferences }
  }
}

// DND timezone helpers: stored as UTC, displayed as local
const utcToLocal = (utcTime: string): string => {
  if (!utcTime) return ''
  const [h, m] = utcTime.split(':').map(Number)
  const now = new Date()
  const utcDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), h, m))
  return `${String(utcDate.getHours()).padStart(2, '0')}:${String(utcDate.getMinutes()).padStart(2, '0')}`
}

const localToUtc = (localTime: string): string => {
  if (!localTime) return ''
  const [h, m] = localTime.split(':').map(Number)
  const now = new Date()
  now.setHours(h, m, 0, 0)
  return `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:00`
}

const dndStartTimeLocal = computed(() => utcToLocal(preferences.dnd_start_time))
const dndEndTimeLocal = computed(() => utcToLocal(preferences.dnd_end_time))

const onDndStartChange = (e: Event) => {
  const target = e.target as HTMLInputElement
  preferences.dnd_start_time = localToUtc(target.value)
  updatePreferences()
}

const onDndEndChange = (e: Event) => {
  const target = e.target as HTMLInputElement
  preferences.dnd_end_time = localToUtc(target.value)
  updatePreferences()
}

const updatePreferences = async () => {
  try {
    await notificationStore.updatePreferences(preferences)
    toast.success(t('settings.notifications.toast.updated'))
  } catch (error) {
    debug.error('Failed to update preferences:', error)
    toast.error(t('settings.notifications.toast.updateFailed'))
  }
}

const requestPermission = async () => {
  try {
    isRequestingPermission.value = true

    if (isNativeClient) {
      const { isPermissionGranted, requestPermission: requestNativePermission } = await import('@tauri-apps/plugin-notification')
      hasNotificationPermission.value = (await isPermissionGranted())
        || (await requestNativePermission()) === 'granted'
    } else {
      if (typeof Notification === 'undefined') {
        toast.error(t('settings.notifications.toast.unsupported'))
        return
      }
      const permission = await Notification.requestPermission()
      hasNotificationPermission.value = permission === 'granted'
    }

    if (hasNotificationPermission.value) {
      toast.success(t('settings.notifications.toast.permissionGranted'))
    } else {
      toast.error(t('settings.notifications.toast.permissionDenied'))
    }
  } catch (error) {
    debug.error('Failed to request permission:', error)
    toast.error(t('settings.notifications.toast.permissionFailed'))
  } finally {
    isRequestingPermission.value = false
  }
}

const testNotification = async (type: NotificationType) => {
  if (isTestingType.value) return
  
  try {
    isTestingType.value = type
    
    const testData = createTestNotificationData(type)
    
    notificationStore.showToast(
      type,
      testData.title,
      testData.message,
      3000,
      testData.avatar
    )
    
    // Play sound
    await notificationStore.playNotificationSound(type)
    
    if (hasNotificationPermission.value) {
      const iconUrl = testData.avatar || '/img/app_icon_square.webp'

      if (isNativeClient) {
        const { nativeNotify } = await import('@/services/nativeNotify')
        await nativeNotify({
          title: testData.title,
          sender: testData.title,
          conversationTitle: '',
          message: testData.message,
          avatarUrl: testData.avatar,
        })
      } else if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        const registration = await navigator.serviceWorker.ready
        await registration.showNotification(testData.title, {
          body: testData.message,
          icon: iconUrl,
          badge: '/img/app_icon_badge.png',
          tag: `harmony-test-${type}`,
          requireInteraction: false,
          silent: true // Sound is already played above
        })
      } else {
        // Fallback for desktop browsers without service worker
        new Notification(testData.title, {
          body: testData.message,
          icon: iconUrl,
          badge: iconUrl
        })
      }
    }
    
    // toast.success(`Test notification sent for ${type}`)
  } catch (error) {
    debug.error('Failed to test notification:', error)
    toast.error(t('settings.notifications.toast.testFailed'))
  } finally {
    setTimeout(() => {
      isTestingType.value = null
    }, 1000)
  }
}

// Sample title and body per notification type.
const SAMPLE_KEYS: Record<string, string> = {
  mention: 'mention',
  dm: 'dm',
  reply: 'reply',
  reaction: 'reaction',
  voice_channel_activity: 'voiceActivity',
  server_invite: 'serverInvite',
  friend_request: 'followRequest',
  server_update: 'serverUpdate',
  emoji_added: 'emojiAdded',
  activitypub_follow: 'apFollow',
  activitypub_favorite: 'apFavorite',
  activitypub_reblog: 'apReblog',
  activitypub_mention: 'apMention',
  activitypub_reply: 'apReply',
  activitypub_follow_request: 'apFollowRequest',
}
const SERVER_SAMPLES = new Set(['server_invite', 'server_update', 'emoji_added'])

const createTestNotificationData = (type: NotificationType) => {
  const sample = SAMPLE_KEYS[type] ?? 'generic'
  return {
    title: t(`settings.notifications.samples.${sample}.title`),
    message: t(`settings.notifications.samples.${sample}.message`),
    avatar: SERVER_SAMPLES.has(type) ? '/default_server.webp' : userData.getUserAvatarUrlCurrent.value,
  }
}

const testAllNotifications = async () => {
  if (isTesting.value) return
  
  try {
    isTesting.value = true
    
    const allTypes = [...chatNotificationTypes.value, ...activityPubNotificationTypes.value]
    
    for (const type of allTypes) {
      // Type-safe access to preferences
      const isEnabled = (preferences as any)[type.key]
      if (isEnabled) {
        await testNotification(type.testType as NotificationType)
        await new Promise(resolve => setTimeout(resolve, 500)) // Delay between tests
      }
    }
    
    toast.success(t('settings.notifications.toast.allTested'))
  } catch (error) {
    debug.error('Failed to test all notifications:', error)
    toast.error(t('settings.notifications.toast.allTestFailed'))
  } finally {
    isTesting.value = false
  }
}

// Restores factory defaults, not the last-saved state: toggles save
// immediately, so "last saved" equals the current state.
const resetToDefaults = async () => {
  if (isAtDefaults.value) return
  Object.assign(preferences, DEFAULT_PREFERENCES)
  await updatePreferences()
}

const onVolumeChange = () => {
  notificationStore.setVolume(soundVolume.value / 100)
}

const pushStatusClass = computed(() => {
  if (!pushNotifications.isSupported.value) return 'not-supported'
  if (pushNotifications.permission.value === 'denied') return 'denied'
  if (pushNotifications.isSubscribed.value) return 'subscribed'
  return 'available'
})

const pushStatusIcon = computed(() => {
  if (!pushNotifications.isSupported.value) return 'x-circle'
  if (pushNotifications.permission.value === 'denied') return 'x-circle'
  if (pushNotifications.isSubscribed.value) return 'check-circle'
  return 'bell'
})

const pushStatusBadgeText = computed(() => {
  if (isAndroidClient) {
    const choice = pushNotifications.androidChoice.value
    if (choice?.kind === 'fcm') return t('settings.notifications.push.status.fcm')
    if (choice?.kind === 'unifiedpush') return t('settings.notifications.push.status.unifiedpush')
    return t('settings.notifications.push.status.whileOpen')
  }
  if (isNativeClient) {
    return isNativeMobile ? t('settings.notifications.push.status.foreground') : t('settings.notifications.push.status.native')
  }
  if (!pushNotifications.isSupported.value) return t('settings.notifications.push.status.notSupported')
  if (pushNotifications.permission.value === 'denied') return t('settings.notifications.push.status.blocked')
  if (pushNotifications.isSubscribed.value) return t('settings.notifications.push.status.enabled')
  return t('settings.notifications.push.status.available')
})

const pushSectionDescription = computed(() => {
  if (isAndroidClient) return t('settings.notifications.push.descAndroid')
  if (isNativeClient) {
    return isNativeMobile ? t('settings.notifications.push.descNativeMobile') : t('settings.notifications.push.descDesktop')
  }
  return t('settings.notifications.push.descWeb')
})

const handlePushSubscribe = async () => {
  const result = await pushNotifications.subscribe()
  if (result.success) {
    localStorage.removeItem('harmony-push-disabled')
    // A device just opted in; an account-wide off switch would silence it.
    if (!preferences.push_notifications) {
      preferences.push_notifications = true
      await updatePreferences()
    }
    toast.success(t('settings.notifications.toast.pushOn'))
  } else {
    toast.error(result.error || t('settings.notifications.toast.pushOnFailed'))
  }
}

// This device only; the account-wide switch and other devices are untouched.
const handlePushUnsubscribe = async () => {
  const result = await pushNotifications.unsubscribe()
  if (result.success) {
    localStorage.setItem('harmony-push-disabled', 'true')
    toast.success(t('settings.notifications.toast.pushOff'))
  } else {
    toast.error(result.error || t('settings.notifications.toast.pushOffFailed'))
  }
}

const handleTestPush = async () => {
  isTestingPush.value = true
  try {
    const result = await pushNotifications.sendTestNotification()
    if (result.success) {
      toast.success(t('settings.notifications.toast.testPushSent'))
    } else {
      toast.error(result.error || t('settings.notifications.toast.testPushFailed'))
    }
  } finally {
    isTestingPush.value = false
  }
}

const handleRemoveDevice = async (sub: { id: string; endpoint: string }) => {
  const result = await pushNotifications.removeSubscription(sub)
  if (result.success) {
    toast.success(t('settings.notifications.toast.deviceRemoved'))
  } else {
    toast.error(result.error || t('settings.notifications.toast.deviceRemoveFailed'))
  }
}

// Helper functions for device display
const getDeviceIcon = (userAgent?: string): string => {
  if (!userAgent) return 'smartphone'
  const ua = userAgent.toLowerCase()
  if (ua.includes('iphone') || ua.includes('ipad')) return 'smartphone'
  if (ua.includes('android')) return 'smartphone'
  if (ua.includes('windows')) return 'monitor'
  if (ua.includes('mac')) return 'monitor'
  if (ua.includes('linux')) return 'monitor'
  return 'smartphone'
}

const getDeviceName = (userAgent?: string): string => {
  if (!userAgent) return t('settings.notifications.devices.unknown')
  const ua = userAgent.toLowerCase()
  if (ua.includes('iphone')) return 'iPhone'
  if (ua.includes('ipad')) return 'iPad'
  if (ua.includes('android')) return t('settings.notifications.devices.android')
  if (ua.includes('windows')) return t('settings.notifications.devices.windows')
  if (ua.includes('mac')) return 'Mac'
  if (ua.includes('linux')) return t('settings.notifications.devices.linux')
  if (ua.includes('chrome')) return t('settings.notifications.devices.chrome')
  if (ua.includes('firefox')) return t('settings.notifications.devices.firefox')
  if (ua.includes('safari')) return t('settings.notifications.devices.safari')
  return t('settings.notifications.devices.unknown')
}

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffDays === 0) return t('settings.notifications.devices.today')
  if (diffDays === 1) return t('settings.notifications.devices.yesterday')
  if (diffDays < 7) return t('time.daysAgo', { count: diffDays })
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7)
    return weeks === 1 ? t('time.weekAgo') : t('time.weeksAgo', { count: weeks })
  }
  return date.toLocaleDateString()
}

// Check notification permission on mount
onMounted(async () => {
  if (isNativeClient) {
    try {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification')
      hasNotificationPermission.value = await isPermissionGranted()
    } catch {
      hasNotificationPermission.value = false
    }
  } else {
    hasNotificationPermission.value = typeof Notification !== 'undefined' && Notification.permission === 'granted'
  }
  loadPreferences()
  if (!isNativeClient) void pushNotifications.reconcile()
  else if (!isAndroidClient) void pushNotifications.initialize()
})

// Watch for changes in the store
watch(() => notificationStore.preferences, (newPreferences) => {
  if (newPreferences) {
    Object.assign(preferences, newPreferences)
    originalPreferences.value = { ...newPreferences }
  }
}, { deep: true })
</script>

<style scoped>
.unified-notification-settings {
  max-width: 700px;
  /* margin: 0 auto; */
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

.settings-section {
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  padding: 24px;
  margin-bottom: 32px;
  border: 1px solid var(--background-quaternary);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}



.section-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 20px 0;
}

.section-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0 0 20px 0;
  line-height: 1.5;
}

.dnd-status {
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  background: var(--background-modifier-hover);
  color: var(--text-muted);
}

.dnd-status.active {
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  color: var(--warning);
}

/* Haptic Feedback Section */
.haptic-status {
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--text-danger);
}

.haptic-status.active {
  background: color-mix(in srgb, var(--success) 10%, transparent);
  color: var(--text-success);
}

.haptic-categories {
  margin-top: 16px;
  padding-top: 16px;
}

.haptic-test {
  margin-top: 16px;
  padding-top: 16px;
}

.test-haptic-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.test-haptic-btn:hover {
  background: var(--harmony-primary-fill-hover);
}

.setting-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-secondary);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-info {
  flex: 1;
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
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.time-range {
  align-items: center;
  gap: 12px;
}

.time-input {
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-base);
  padding: 8px 12px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  width: 120px;
}

.time-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.time-separator {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.select-input {
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-base);
  padding: 8px 12px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  min-width: 120px;
}

.select-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.volume-slider {
  flex: 1;
  min-width: 120px;
}

.volume-value {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  min-width: 40px;
}

.permission-status {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--background-primary);
  border-radius: var(--radius-md);
  padding: 12px;
  border: 1px solid var(--border-secondary);
}

.permission-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
}

.permission-granted {
  color: var(--text-success);
}

.permission-denied {
  color: var(--text-danger);
}

.permission-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.permission-btn {
  background: var(--harmony-primary-fill);
  border: none;
  border-radius: var(--radius-base);
  padding: 8px 16px;
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color var(--transition-fast);
  display: flex;
  align-items: center;
  gap: 8px;
}

.permission-btn:hover {
  background: var(--harmony-primary-fill-hover);
}

.permission-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.notification-categories {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.notification-category {
  background: var(--background-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-secondary);
  overflow: hidden;
}

.category-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-secondary);
}

.category-icon {
  width: 40px;
  height: 40px;
  min-width: 40px;
  min-height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-primary);
  font-size: var(--font-size-lg);
  padding: 8px;
  overflow: hidden;
  flex-shrink: 0;
}

.category-icon.chat {
  background: var(--harmony-primary);
}

.category-icon.activitypub {
  background: var(--success);
}

.category-info {
  flex: 1;
}

.category-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.category-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.category-settings {
  padding: 20px;
}

.notification-type-grid {
  display: grid;
  gap: 16px;
}

.notification-type {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  background: var(--background-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-secondary);
}

.type-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.type-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background-modifier-active);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  padding: 6px;
}

.type-info {
  flex: 1;
}

.type-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  display: block;
  margin-bottom: 2px;
}

.type-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  display: block;
}

.type-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.control-icon {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.test-btn {
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-hover);
  border-radius: var(--radius-base);
  padding: 6px 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
}

.test-btn:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.test-btn:disabled,
.test-btn[aria-disabled='true'] {
  opacity: 0.5;
  cursor: not-allowed;
}

.test-actions {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: center;
}

.test-all-btn, .reset-btn {
  background: var(--harmony-primary-fill);
  border: none;
  border-radius: var(--radius-md);
  padding: 12px 24px;
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  display: flex;
  align-items: center;
  gap: 8px;
}

.test-all-btn:hover {
  background: var(--harmony-primary-hover);
}

.reset-btn {
  background: transparent;
  border: 1px solid var(--border-hover);
  color: var(--text-secondary);
}

.reset-btn:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.test-all-btn:disabled, .reset-btn:disabled,
.test-all-btn[aria-disabled='true'], .reset-btn[aria-disabled='true'] {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Push Notification Styles */
.section-icon {
  width: 20px;
  height: 20px;
  margin-right: 8px;
}

.push-status-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: var(--radius-lg);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
}

.push-status-badge.subscribed {
  background: color-mix(in srgb, var(--success) 10%, transparent);
  color: var(--text-success);
}

.push-status-badge.available {
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  color: var(--text-link);
}

.push-status-badge.denied,
.push-status-badge.not-supported {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--text-danger);
}

.push-warning {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: var(--radius-md);
  margin-bottom: 20px;
}

.push-warning.error {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border-color: color-mix(in srgb, var(--error) 30%, transparent);
}

.push-warning > svg {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  color: var(--warning);
}

.push-warning.error > svg {
  color: var(--text-danger);
}

.push-warning strong {
  display: block;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  margin-bottom: 4px;
}

.push-warning p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
  line-height: 1.4;
}

.push-error-with-retry > div {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.push-error-with-retry .retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  margin-top: 4px;
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background 0.2s ease;
  align-self: flex-start;
}

.push-error-with-retry .retry-btn:hover:not(:disabled) {
  background: var(--harmony-primary-fill-hover);
}

.push-error-with-retry .retry-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.push-actions {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.push-subscribe-btn,
.push-unsubscribe-btn,
.push-test-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
}

.push-subscribe-btn {
  background: var(--success);
  color: var(--text-on-primary);
}

.push-subscribe-btn:hover:not(:disabled) {
  background: var(--success-hover);
}

.push-unsubscribe-btn {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--text-danger);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
}

.push-unsubscribe-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--error) 20%, transparent);
}

.push-test-btn {
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  color: var(--text-link);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.push-test-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
}

.push-subscribe-btn:disabled,
.push-unsubscribe-btn:disabled,
.push-test-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.push-preferences {
  margin-bottom: 20px;
  padding: 16px;
  background: var(--background-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-secondary);
}

.push-empty-note {
  margin: 0 0 8px 0;
  padding: 12px 16px;
  background: var(--background-primary);
  border: 1px dashed var(--border-hover);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.subscribed-devices {
  margin-top: 20px;
}

.devices-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 12px 0;
}

.device-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.device-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--background-primary);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-secondary);
}

.device-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.device-icon {
  width: 32px;
  height: 32px;
  padding: 6px;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border-radius: var(--radius-md);
  color: var(--text-link);
}

.device-details {
  display: flex;
  flex-direction: column;
}

.device-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.device-current {
  margin-left: var(--spacing-xs, 4px);
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  color: var(--text-link);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold, 600);
}

.device-date {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.device-remove-btn {
  background: transparent;
  border: none;
  padding: 8px;
  border-radius: var(--radius-base);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.device-remove-btn:hover {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--text-danger);
}

/* Responsive design */
@media (max-width: 768px) {
  .notification-type {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .type-controls {
    width: 100%;
    justify-content: space-between;
  }
  
  .test-actions {
    flex-direction: column;
    gap: 12px;
  }
  
  .test-all-btn, .reset-btn {
    width: 100%;
    justify-content: center;
  }
  
  .push-actions {
    flex-direction: column;
  }
  
  .push-subscribe-btn,
  .push-unsubscribe-btn,
  .push-test-btn {
    width: 100%;
    justify-content: center;
  }
}
</style>