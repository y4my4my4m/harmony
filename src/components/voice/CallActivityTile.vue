<!--
  A call's activity this member has not joined, as a tile beside the participants: a game of the
  call's channel (play together) or the call's watch or listen together. Shows what it is, who is in
  it and Join, or why this member cannot join. Watch together shows the source and title only; the
  item's picture stays unloaded until the member joins, as ActivityInvite.
-->
<template>
  <div
    class="call-activity-tile"
    role="group"
    :aria-label="title"
    :data-kind="game ? 'game' : 'watch'"
    data-testid="call-activity-tile"
    @click.stop
  >
    <div class="call-activity-tile__art" aria-hidden="true">
      <img v-if="gameApp" :src="gameApp.iconUrl" alt="" class="call-activity-tile__icon" />
      <span v-else class="call-activity-tile__glyph"><Icon :name="watch ? activitySourceIcon(watch.source) : 'play'" :size="28" /></span>
    </div>
    <p class="call-activity-tile__title">{{ title }}</p>
    <p class="call-activity-tile__who">
      <template v-if="game">
        <i18n-t
          v-if="gameFirst"
          :keypath="game.members.length === 1 ? 'playTogether.bannerOne' : 'playTogether.bannerMany'"
          :plural="game.members.length - 1"
          scope="global"
          tag="span"
        >
          <template #name>
            <DisplayName :user-id="gameFirst.id" :fallback="gameFirst.display_name || gameFirst.username || ''" :truncate="true" />
          </template>
          <template #n>{{ game.members.length - 1 }}</template>
          <template #app>{{ title }}</template>
        </i18n-t>
        <template v-else>{{ t('playTogether.bannerEmpty', { app: title }) }}</template>
      </template>
      <i18n-t v-else-if="watch?.host_id" keypath="activities.startedBy" scope="global" tag="span">
        <template #name><DisplayName :user-id="watch.host_id" :truncate="true" /></template>
      </i18n-t>
    </p>
    <div v-if="game && game.members.length" class="call-activity-tile__people" aria-hidden="true">
      <Avatar
        v-for="member in game.members.slice(0, 4)"
        :key="member.id"
        :src="member.avatar_url ? getAvatarUrl(member.avatar_url, 64) : undefined"
        :alt="member.display_name || member.username || ''"
        size="xs"
      />
    </div>
    <span v-if="gameApp?.source === 'package'" class="call-activity-tile__chip" data-testid="call-activity-third-party">{{ t('playTogether.thirdParty') }}</span>
    <p v-if="game?.refusal" class="call-activity-tile__refusal" data-testid="play-together-refusal">{{ playTogether.refusalText(game.refusal) }}</p>
    <button
      v-else
      type="button"
      class="call-activity-tile__join"
      :data-testid="game ? 'play-together-join' : 'activity-join'"
      :disabled="joining"
      @click.stop="join"
    >
      {{ game ? t('playTogether.join') : t('activities.join') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import { activitySourceIcon, activitySourceLabel } from '@/components/activities/activitySources'
import { useT } from '@/composables/useT'
import type { VoiceActivity } from '@/services/activities/activityService'
import type { ActivitySession } from '@/services/playTogether/sessions'
import { useActivitiesStore } from '@/stores/activities'
import { usePlayTogetherStore } from '@/stores/playTogether'
import { getAvatarUrl } from '@/utils/avatarUtils'

const props = defineProps<{ game?: ActivitySession | null; watch?: VoiceActivity | null }>()

const { t } = useT()
const playTogether = usePlayTogetherStore()
const activities = useActivitiesStore()
const joining = ref(false)

const gameApp = computed(() => (props.game ? playTogether.appById(props.game.app_id) : undefined))
const gameFirst = computed(() => props.game?.members[0])
const title = computed(() => {
  if (props.game) return gameApp.value ? playTogether.appLabel(gameApp.value).name : props.game.app_name
  if (props.watch) return props.watch.item.title || activitySourceLabel(props.watch.source, t)
  return ''
})

async function join(): Promise<void> {
  if (joining.value) return
  joining.value = true
  try {
    if (props.game) await playTogether.join(props.game)
    else await activities.join()
  } finally {
    joining.value = false
  }
}
</script>

<style scoped>
.call-activity-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px;
  overflow: hidden;
  border-radius: var(--radius-md);
  background:
    radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--accent-color, #0EA5E9) 22%, transparent), transparent 70%),
    var(--background-secondary);
  border: 1px solid color-mix(in srgb, var(--accent-color, #0EA5E9) 35%, var(--border-primary, transparent));
  text-align: center;
  container-type: size;
}

.call-activity-tile__art {
  flex-shrink: 0;
}

.call-activity-tile__icon,
.call-activity-tile__glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
}

.call-activity-tile__glyph {
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
}

.call-activity-tile__title {
  margin: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
  font-size: 15px;
  color: var(--text-primary);
}

.call-activity-tile__who {
  margin: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
}

.call-activity-tile__people {
  display: flex;
}

.call-activity-tile__people > * + * {
  margin-left: -6px;
}

.call-activity-tile__chip {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
}

.call-activity-tile__refusal {
  margin: 0;
  font-size: 12px;
  color: var(--warning);
}

.call-activity-tile__join {
  padding: 6px 20px;
  border: none;
  border-radius: 999px;
  font-weight: 700;
  font-size: 13px;
  background: var(--accent-color, #0EA5E9);
  color: #fff;
  cursor: pointer;
}

.call-activity-tile__join:disabled {
  opacity: 0.6;
  cursor: default;
}

.call-activity-tile__join:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
}

/* A filmstrip tile is short: the art and the button only. */
@container (max-height: 120px) {
  .call-activity-tile__who,
  .call-activity-tile__people,
  .call-activity-tile__chip {
    display: none;
  }

  .call-activity-tile__icon,
  .call-activity-tile__glyph {
    width: 28px;
    height: 28px;
    border-radius: 8px;
  }

  .call-activity-tile__title {
    font-size: 12px;
  }

  .call-activity-tile__join {
    padding: 3px 12px;
    font-size: 12px;
  }
}
</style>
