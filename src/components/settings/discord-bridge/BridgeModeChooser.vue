<template>
  <div class="db-card" data-testid="bridge-mode-chooser" :data-platform="platform">
    <h3 class="db-card-title">{{ t(key('title')) }}</h3>
    <p class="db-muted">{{ t(key(instanceBotEnabled ? 'needsInstance' : 'needs')) }}</p>

    <article
      v-if="instanceBotEnabled"
      class="mode-option mode-option--featured"
      data-testid="mode-instance"
      :aria-labelledby="`${uid}-instance`"
    >
      <div class="mode-head">
        <Icon name="zap" :size="20" aria-hidden="true" />
        <h4 :id="`${uid}-instance`">{{ t(key('instance.title'), { instance: instanceName }) }}</h4>
        <span class="db-badge db-badge--ok">{{ t(key('instance.recommended')) }}</span>
      </div>
      <ul class="mode-points">
        <li>{{ t(key('instance.point1')) }}</li>
        <li>{{ t(key('instance.point2')) }}</li>
      </ul>
      <p class="mode-tradeoff">
        <Icon name="alert-triangle" :size="14" aria-hidden="true" />
        <span>{{ t(key('instance.tradeoff')) }}</span>
      </p>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="busy"
        data-testid="choose-instance"
        @click="emit('choose', 'instance')"
      >
        {{ t(key('instance.choose'), { instance: instanceName }) }}
      </button>
    </article>

    <p v-if="instanceBotEnabled" class="db-card-sub alternatives">{{ t(key('ownBot')) }}</p>

    <div class="mode-grid" :class="{ single: !hostingEnabled && !ownProgram }">
      <article v-if="hostingEnabled" class="mode-option" data-testid="mode-hosted" :aria-labelledby="`${uid}-hosted`">
        <div class="mode-head">
          <Icon name="server" :size="20" aria-hidden="true" />
          <h4 :id="`${uid}-hosted`">{{ t(key('hosted.title')) }}</h4>
        </div>
        <p class="mode-lead" data-testid="hosted-lead">{{ t(key('hosted.lead')) }}</p>
        <ul class="mode-points">
          <li>{{ t(key('hosted.point1')) }}</li>
          <li>{{ t(key('hosted.point2')) }}</li>
        </ul>
        <p class="mode-tradeoff">
          <Icon name="alert-triangle" :size="14" aria-hidden="true" />
          <span>{{ t(key('hosted.tradeoff')) }}</span>
        </p>
        <button
          type="button"
          :class="['btn', instanceBotEnabled ? 'btn-secondary' : 'btn-primary']"
          :disabled="busy"
          data-testid="choose-hosted"
          @click="emit('choose', 'hosted')"
        >
          {{ t(key('hosted.choose')) }}
        </button>
      </article>

      <article class="mode-option" data-testid="mode-self" :aria-labelledby="`${uid}-self`">
        <div class="mode-head">
          <Icon name="monitor" :size="20" aria-hidden="true" />
          <h4 :id="`${uid}-self`">{{ t(key('self.title')) }}</h4>
        </div>
        <ul class="mode-points">
          <li>{{ t(key('self.point1')) }}</li>
          <li>{{ t(key('self.point2')) }}</li>
        </ul>
        <p class="mode-tradeoff">
          <Icon name="info" :size="14" aria-hidden="true" />
          <span>{{ t(key('self.tradeoff')) }}</span>
        </p>
        <button
          type="button"
          :class="['btn', hostingEnabled || instanceBotEnabled ? 'btn-secondary' : 'btn-primary']"
          :disabled="busy"
          data-testid="choose-self"
          @click="emit('choose', 'self')"
        >
          {{ t(key('self.choose')) }}
        </button>
      </article>

      <article v-if="ownProgram" class="mode-option" data-testid="mode-custom" :aria-labelledby="`${uid}-custom`">
        <div class="mode-head">
          <Icon name="wrench" :size="20" aria-hidden="true" />
          <h4 :id="`${uid}-custom`">{{ t(key('custom.title')) }}</h4>
        </div>
        <ul class="mode-points">
          <li>{{ t(key('custom.point1')) }}</li>
          <li>{{ t(key('custom.point2')) }}</li>
        </ul>
        <p class="mode-tradeoff">
          <Icon name="info" :size="14" aria-hidden="true" />
          <span>{{ t(key('custom.tradeoff')) }}</span>
        </p>
        <button type="button" class="btn btn-secondary" :disabled="busy" data-testid="choose-custom" @click="emit('choose-custom')">
          {{ t(key('custom.choose')) }}
        </button>
      </article>
    </div>

    <p v-if="!hostingEnabled && (platform === 'discord' || !instanceBotEnabled)" class="db-muted" data-testid="hosting-unavailable">{{ t(key('hostingUnavailable')) }}</p>
    <p class="db-muted">{{ t(key('bothWays')) }}</p>
    <p v-if="platform === 'discord'" class="db-muted">{{ t(key('presenceNote')) }}</p>
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import type { BridgeMode } from '@/utils/discordBridgeSetup'
import type { BridgeRemotePlatform } from './bridgeApi'

const props = withDefaults(
  defineProps<{
    hostingEnabled: boolean
    busy: boolean
    /** discord_bridge_instance_bot_enabled: the instance's own Discord bot is offered first. */
    instanceBotEnabled?: boolean
    instanceName?: string
    platform?: BridgeRemotePlatform
    /** A bridge program of any make, with a bot of the manager's, is offered last. */
    ownProgram?: boolean
  }>(),
  { instanceBotEnabled: false, instanceName: '', platform: 'discord', ownProgram: false },
)

const emit = defineEmits<{ choose: [mode: BridgeMode]; 'choose-custom': [] }>()

const { t } = useI18n()
const uid = `bridge-mode-${useId()}`
const START_KEYS: Record<BridgeRemotePlatform, string> = { discord: 'discordBridge.start', matrix: 'matrixBridge.start' }
const key = (name: string) => `${START_KEYS[props.platform]}.${name}`
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.mode-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.mode-grid.single {
  grid-template-columns: minmax(0, 1fr);
}

.mode-option {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  background: var(--background-primary);
  min-width: 0;
}

.mode-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-link);
}

.mode-head h4 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.mode-lead {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
}

.mode-points {
  margin: 0;
  padding-left: 18px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
}

.mode-points li + li {
  margin-top: 4px;
}

.mode-tradeoff {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
  flex: 1;
}

.mode-tradeoff :deep(.icon-wrap) {
  margin-top: 3px;
  flex-shrink: 0;
}

.mode-option .btn {
  align-self: flex-start;
}

.mode-option--featured {
  margin-bottom: 14px;
  border-color: color-mix(in srgb, var(--harmony-primary) 55%, var(--background-quaternary));
}

.mode-option--featured .mode-head h4 {
  flex: 1;
  min-width: 0;
}

.alternatives {
  margin-top: 4px;
}

@media (max-width: 640px) {
  .mode-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .mode-option .btn {
    align-self: stretch;
  }
}
</style>
