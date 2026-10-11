<!--
  MessageAnnouncementSetting - the "Announce new messages" switch, a setting row
  for Settings > Appearance > Accessibility. Stored per device
  (composables/useNewMessageAnnouncer.ts) and applied at once, outside the
  appearance save bar.
-->
<template>
  <div class="setting-item">
    <div class="message-announce-info">
      <h4 :id="labelId" class="message-announce-label">{{ t('messageA11y.setting.label') }}</h4>
      <p :id="descId" class="message-announce-desc">{{ t('messageA11y.setting.description') }}</p>
    </div>
    <div class="message-announce-control">
      <ToggleSwitch
        :model-value="enabled"
        :labelledby="labelId"
        :describedby="descId"
        data-testid="announce-new-messages"
        @update:model-value="setEnabled"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useNewMessageAnnouncementSetting } from '@/composables/useNewMessageAnnouncer'
import { useT } from '@/composables/useT'
import { uid } from '@/utils/a11y/focus'

const { t } = useT()
const { enabled, setEnabled } = useNewMessageAnnouncementSetting()
const labelId = uid('announce-label')
const descId = uid('announce-desc')
</script>

<style scoped>
/* Mirrors .setting-info / .setting-label / .setting-description of the
   settings pages, whose styles are scoped to them. */
.message-announce-info {
  flex: 1;
  margin-right: 16px;
}

.message-announce-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.message-announce-desc {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.message-announce-control {
  flex-shrink: 0;
}
</style>
