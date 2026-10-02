<template>
  <div class="today-view">
    <header class="today-header">
      <button type="button" class="today-icon-button" :aria-label="t('today.back')" @click="goBack">
        <Icon name="arrow-left" :size="20" />
      </button>
      <div class="today-heading">
        <div class="today-heading-line">
          <h1>{{ greeting }}</h1>
          <span class="today-beta">{{ t('today.beta') }}</span>
        </div>
        <p class="today-subtitle">
          <span>{{ dateLabel }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ sinceLabel }}</span>
        </p>
      </div>
      <button
        type="button"
        class="today-icon-button"
        :aria-label="t('today.refresh')"
        :title="t('today.refresh')"
        :disabled="refreshing"
        @click="refresh"
      >
        <Icon name="refresh-cw" :size="18" :class="{ spinning: refreshing }" />
      </button>
    </header>

    <div class="today-scroll">
      <div class="today-inner">
        <nav v-if="status === 'ready'" class="today-stats" :aria-label="t('today.statsLabel')">
          <button
            v-for="stat in stats"
            :key="stat.key"
            type="button"
            class="today-stat"
            @click="focusSection(stat.section)"
          >
            {{ statLabel(stat) }}
          </button>
          <span v-if="stats.length === 0" class="today-stat calm">
            <Icon name="check-circle" :size="14" aria-hidden="true" />
            {{ t('today.allCaughtUp') }}
          </span>
        </nav>

        <p v-if="refreshFailed" class="today-refresh-failed" role="status">
          <Icon name="alert-circle" :size="14" aria-hidden="true" />
          <span>{{ t('today.refreshFailed') }}</span>
          <button type="button" class="today-text-button" @click="refresh">{{ t('common.retry') }}</button>
        </p>

        <section
          v-if="status === 'ready' && summary.announcements.length > 0"
          id="today-announcements"
          class="today-announcements"
          :aria-label="t('today.announcements.title')"
        >
          <article
            v-for="announcement in summary.announcements"
            :key="announcement.id"
            class="today-announcement"
          >
            <Icon :name="announcementIcon(announcement.icon)" :size="18" class="today-announcement-icon" aria-hidden="true" />
            <div class="today-announcement-body">
              <h2 class="today-announcement-title">
                {{ announcement.title }}
                <span v-if="announcement.isPinned" class="today-tag">{{ t('today.announcements.pinned') }}</span>
              </h2>
              <!-- eslint-disable-next-line vue/no-v-html -->
              <div class="today-announcement-content" v-html="renderAnnouncementHtml(announcement.content)"></div>
            </div>
            <button
              type="button"
              class="today-icon-button small"
              :aria-label="t('today.announcements.dismiss', { title: announcement.title })"
              :title="t('today.announcements.dismissShort')"
              @click="dismissAnnouncement(announcement.id)"
            >
              <Icon name="x" :size="16" />
            </button>
          </article>
          <RouterLink
            v-if="summary.totals.announcements > summary.announcements.length"
            :to="{ name: 'UserSettings', params: { section: 'announcements' } }"
            class="today-text-button"
          >
            {{ t('today.announcements.more', { count: summary.totals.announcements - summary.announcements.length }) }}
          </RouterLink>
        </section>

        <div class="today-columns">
          <div class="today-main">
            <TodaySection
              id="mentions"
              icon="at-sign"
              class="order-mentions"
              :title="t('today.mentions.title')"
              :state="stateFor(summary.mentions.length > 0)"
              :count="summary.totals.mentionsUnread"
              :empty-text="t('today.mentions.empty')"
              :error-text="t('today.mentions.error')"
              @retry="refresh"
            >
              <ul class="today-list">
                <TodayMentionRow
                  v-for="mention in visible('mentions', summary.mentions)"
                  :key="mention.message.id"
                  :mention="mention"
                />
              </ul>
              <ShowMore
                v-if="summary.mentions.length > PREVIEW_COUNT"
                :expanded="expanded.mentions"
                :total="summary.mentions.length"
                @toggle="toggle('mentions')"
              />
            </TodaySection>

            <TodaySection
              id="conversations"
              icon="message-circle"
              class="order-conversations"
              :title="t('today.conversations.title')"
              :state="stateFor(summary.conversations.length > 0)"
              :count="summary.totals.conversations"
              :empty-text="t('today.conversations.empty')"
              :error-text="t('today.conversations.error')"
              @retry="refresh"
            >
              <template #actions>
                <RouterLink :to="{ name: 'DMHome' }" class="today-text-button">{{ t('today.seeAll') }}</RouterLink>
              </template>
              <ul class="today-list">
                <TodayConversationRow
                  v-for="conversation in summary.conversations"
                  :key="conversation.id"
                  :conversation="conversation"
                  :me-id="meId"
                />
              </ul>
              <p v-if="summary.totals.conversations > summary.conversations.length" class="today-more-note">
                {{ t('today.conversations.more', { count: summary.totals.conversations - summary.conversations.length }) }}
              </p>
            </TodaySection>

            <TodaySection
              id="catch-up"
              icon="hash"
              class="order-catch-up"
              :title="t('today.catchUp.title')"
              :state="stateFor(summary.servers.length > 0)"
              :count="summary.totals.channels"
              :empty-text="t('today.catchUp.empty')"
              :error-text="t('today.catchUp.error')"
              @retry="refresh"
            >
              <template #actions>
                <button type="button" class="today-text-button" @click="markAllChannelsRead">
                  {{ t('today.catchUp.markAllRead') }}
                </button>
              </template>
              <ul class="today-servers">
                <li v-for="server in visible('servers', summary.servers)" :key="server.id" class="today-server">
                  <div class="today-server-head">
                    <ServerIcon :src="server.icon" :alt="server.name" size="xs" :show-title="false" />
                    <RouterLink
                      v-if="server.channels[0]"
                      :to="channelRoute(server.id, server.channels[0].id)"
                      class="today-server-name"
                    >{{ server.name }}</RouterLink>
                    <span v-else class="today-server-name">{{ server.name }}</span>
                    <span class="today-server-counts">
                      {{ t('today.catchUp.serverCounts', { count: server.unreadMessages }, server.unreadMessages) }}
                      <template v-if="server.unreadMentions > 0">
                        · <span class="today-mention-count">{{ t('today.catchUp.serverMentions', { count: server.unreadMentions }, server.unreadMentions) }}</span>
                      </template>
                    </span>
                    <button
                      type="button"
                      class="today-text-button subtle"
                      :aria-label="t('today.catchUp.markServerRead', { server: server.name })"
                      @click="markServerRead(server.id)"
                    >
                      {{ t('today.catchUp.markRead') }}
                    </button>
                  </div>
                  <ul class="today-chips">
                    <li v-for="channel in server.channels" :key="channel.id">
                      <RouterLink
                        :to="channelRoute(server.id, channel.id)"
                        class="today-chip"
                        :class="{ mentioned: channel.unreadMentions > 0 }"
                        :aria-label="channelLabel(channel)"
                      >
                        <Icon :name="channel.type === 1 ? 'volume-2' : 'hash'" :size="12" aria-hidden="true" />
                        <span class="today-chip-name">{{ channel.name }}</span>
                        <span v-if="channel.unreadMentions > 0" class="today-chip-mentions">@{{ channel.unreadMentions }}</span>
                        <span class="today-chip-count">{{ channel.unreadMessages > 99 ? '99+' : channel.unreadMessages }}</span>
                      </RouterLink>
                    </li>
                    <li v-if="server.channelCount > server.channels.length">
                      <span class="today-chip more">
                        {{ t('today.catchUp.moreChannels', { count: server.channelCount - server.channels.length }) }}
                      </span>
                    </li>
                  </ul>
                </li>
              </ul>
              <ShowMore
                v-if="summary.servers.length > SERVER_PREVIEW_COUNT"
                :expanded="expanded.servers"
                :total="summary.servers.length"
                @toggle="toggle('servers')"
              />
            </TodaySection>
          </div>

          <div class="today-side">
            <TodaySection
              v-if="todayAiSummariesEnabled && status === 'ready' && (highlightsPending || highlights.length > 0)"
              id="highlights"
              icon="sparkles"
              class="order-highlights"
              :title="t('today.highlights.title')"
              :state="highlights.length > 0 ? 'ready' : 'loading'"
              :skeleton-rows="2"
            >
              <template #actions>
                <span class="today-tag" :title="t('today.highlights.onDeviceHint')">{{ t('today.highlights.onDevice') }}</span>
              </template>
              <ul class="today-list">
                <li v-for="h in highlights" :key="h.channelId" class="today-highlight">
                  <RouterLink :to="channelRoute(h.serverId, h.channelId)" class="today-chip">
                    <Icon name="hash" :size="12" aria-hidden="true" />
                    <span class="today-chip-name">{{ h.channelName }}</span>
                  </RouterLink>
                  <span class="today-highlight-server">{{ h.serverName }}</span>
                  <p class="today-highlight-text">{{ h.summary }}</p>
                </li>
              </ul>
            </TodaySection>

            <TodaySection
              id="voice"
              icon="volume-2"
              class="order-voice"
              :title="t('today.voice.title')"
              :state="stateFor(summary.voice.length > 0)"
              :empty-text="t('today.voice.empty')"
              :error-text="t('today.voice.error')"
              :skeleton-rows="1"
              @retry="refresh"
            >
              <ul class="today-list">
                <li v-for="voice in summary.voice" :key="voice.channelId" class="today-voice">
                  <div class="today-voice-body">
                    <div class="today-voice-title">
                      <span class="today-live-dot" aria-hidden="true"></span>
                      <span class="today-voice-name">{{ voice.channelName }}</span>
                    </div>
                    <div class="today-voice-sub">
                      <ServerIcon :src="voice.server.icon" :alt="voice.server.name" size="mini" :show-title="false" />
                      <span class="today-voice-server">{{ voice.server.name }}</span>
                      <template v-if="voice.startedAt">
                        <span aria-hidden="true">·</span>
                        <span>{{ t('today.voice.since', { time: relative(voice.startedAt) }) }}</span>
                      </template>
                    </div>
                    <div class="today-avatar-stack" :aria-label="voiceParticipantsLabel(voice)" role="img">
                      <Avatar
                        v-for="person in voice.participants"
                        :key="person.id"
                        :src="person.avatarUrl"
                        :alt="person.displayName || person.username || ''"
                        size="xs"
                        class="today-stack-avatar"
                      />
                      <span v-if="voice.participantCount > voice.participants.length" class="today-stack-more">
                        +{{ voice.participantCount - voice.participants.length }}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    class="today-join"
                    :class="{ secondary: voice.includesMe }"
                    :disabled="joiningChannel === voice.channelId"
                    :aria-label="voice.includesMe
                      ? t('today.voice.openLabel', { channel: voice.channelName })
                      : t('today.voice.joinLabel', { channel: voice.channelName, server: voice.server.name })"
                    @click="joinVoice(voice)"
                  >
                    <Icon :name="voice.includesMe ? 'chevron-right' : 'headphones'" :size="14" aria-hidden="true" />
                    {{ voice.includesMe ? t('today.voice.open') : t('today.voice.join') }}
                  </button>
                </li>
              </ul>
            </TodaySection>

            <TodaySection
              id="threads"
              icon="thread"
              class="order-threads"
              :title="t('today.threads.title')"
              :state="stateFor(summary.threads.length > 0)"
              :count="summary.totals.threads"
              :empty-text="t('today.threads.empty')"
              :error-text="t('today.threads.error')"
              :skeleton-rows="2"
              @retry="refresh"
            >
              <ul class="today-list">
                <li v-for="thread in visible('threads', summary.threads)" :key="thread.id" class="today-row">
                  <span class="today-thread-icon" aria-hidden="true"><Icon name="thread" :size="16" /></span>
                  <div class="today-row-body">
                    <div class="today-row-meta">
                      <RouterLink
                        :to="threadRoute(thread)"
                        class="today-row-link today-ellipsis"
                        :aria-label="t('today.threads.linkLabel', { name: thread.name, count: thread.newReplies }, thread.newReplies)"
                      >{{ thread.name }}</RouterLink>
                      <time v-if="thread.lastReplyAt" class="today-row-time" :datetime="thread.lastReplyAt">{{ relative(thread.lastReplyAt) }}</time>
                    </div>
                    <div class="today-row-sub">#{{ thread.channelName }} · {{ thread.server.name }}</div>
                    <div class="today-thread-foot">
                      <span class="today-avatar-stack small" aria-hidden="true">
                        <Avatar
                          v-for="person in thread.repliers"
                          :key="person.id"
                          :src="person.avatarUrl"
                          size="mini"
                          class="today-stack-avatar"
                        />
                      </span>
                      <span class="today-thread-count">
                        {{ t('today.threads.newReplies', { count: thread.newReplies }, thread.newReplies) }}
                      </span>
                    </div>
                  </div>
                </li>
              </ul>
              <ShowMore
                v-if="summary.threads.length > PREVIEW_COUNT"
                :expanded="expanded.threads"
                :total="summary.threads.length"
                @toggle="toggle('threads')"
              />
            </TodaySection>

            <TodaySection
              id="social"
              icon="users"
              class="order-social"
              :title="t('today.social.title')"
              :state="stateFor(hasSocial)"
              :count="summary.totals.followRequests"
              :empty-text="t('today.social.empty')"
              :error-text="t('today.social.error')"
              :skeleton-rows="2"
              @retry="refresh"
            >
              <template #actions>
                <RouterLink :to="{ name: 'Mentions' }" class="today-text-button">{{ t('today.seeAll') }}</RouterLink>
              </template>

              <div v-if="summary.followRequests.length > 0" class="today-subsection">
                <h3 class="today-subheading">
                  {{ t('today.social.followRequests', { count: summary.totals.followRequests }, summary.totals.followRequests) }}
                </h3>
                <ul class="today-list">
                  <li v-for="person in summary.followRequests" :key="person.id" class="today-person">
                    <Avatar :src="person.avatarUrl" size="sm" class="today-row-avatar" />
                    <button type="button" class="today-person-name" @click="openProfile(person)">
                      <DisplayName :user-id="person.id" :fallback="person.displayName || person.username || ''" truncate />
                      <span class="today-handle">{{ handle(person) }}</span>
                    </button>
                    <div class="today-person-actions">
                      <button
                        type="button"
                        class="today-pill-button primary"
                        :aria-label="t('today.social.acceptLabel', { name: person.displayName || person.username })"
                        @click="respondToFollowRequest(person, true)"
                      >{{ t('today.social.accept') }}</button>
                      <button
                        type="button"
                        class="today-pill-button"
                        :aria-label="t('today.social.declineLabel', { name: person.displayName || person.username })"
                        @click="respondToFollowRequest(person, false)"
                      >{{ t('today.social.decline') }}</button>
                    </div>
                  </li>
                </ul>
                <RouterLink
                  v-if="summary.totals.followRequests > summary.followRequests.length"
                  :to="{ name: 'FollowRequests' }"
                  class="today-text-button"
                >{{ t('today.social.allRequests', { count: summary.totals.followRequests }) }}</RouterLink>
              </div>

              <div v-if="summary.newFollowers.length > 0" class="today-subsection today-followers">
                <span class="today-avatar-stack" aria-hidden="true">
                  <Avatar
                    v-for="person in summary.newFollowers.slice(0, 5)"
                    :key="person.id"
                    :src="person.avatarUrl"
                    size="xs"
                    class="today-stack-avatar"
                  />
                </span>
                <RouterLink :to="{ name: 'Followers' }" class="today-followers-text">{{ newFollowersLabel }}</RouterLink>
              </div>

              <ul v-if="activityChips.length > 0" class="today-chips today-subsection" :aria-label="t('today.social.activityLabel')">
                <li v-for="chip in activityChips" :key="chip.key">
                  <span class="today-chip static">
                    <Icon :name="chip.icon" :size="12" aria-hidden="true" />
                    {{ chip.label }}
                  </span>
                </li>
              </ul>

              <ul v-if="summary.socialItems.length > 0" class="today-list today-subsection">
                <li v-for="item in summary.socialItems" :key="item.notificationId" class="today-row">
                  <Avatar :src="item.post.author?.avatarUrl" size="sm" class="today-row-avatar" />
                  <div class="today-row-body">
                    <div class="today-row-meta">
                      <RouterLink
                        :to="postRoute(item.post.id)"
                        class="today-row-link"
                        :aria-label="socialItemLabel(item)"
                      >
                        <DisplayName
                          v-if="item.post.author"
                          :user-id="item.post.author.id"
                          :fallback="item.post.author.displayName || item.post.author.username || ''"
                          truncate
                        />
                      </RouterLink>
                      <span class="today-tag">{{ item.type === 'activitypub_reply' ? t('today.social.replied') : t('today.social.mentioned') }}</span>
                      <time v-if="item.createdAt" class="today-row-time" :datetime="item.createdAt">{{ relative(item.createdAt) }}</time>
                    </div>
                    <TodayPreview
                      :content="item.post.content"
                      :message-id="item.post.id"
                      :content-warning="item.post.contentWarning"
                      :extra-attachments="item.post.mediaCount"
                    />
                  </div>
                </li>
              </ul>
            </TodaySection>

            <TodaySection
              id="posts"
              icon="trending-up"
              class="order-posts"
              :title="t('today.posts.title')"
              :state="stateFor(summary.followedPosts.length > 0)"
              :empty-text="t('today.posts.empty')"
              :error-text="t('today.posts.error')"
              @retry="refresh"
            >
              <template #actions>
                <RouterLink :to="{ name: 'SocialHome' }" class="today-text-button">{{ t('today.seeAll') }}</RouterLink>
              </template>
              <ul class="today-list">
                <li v-for="post in summary.followedPosts" :key="post.id" class="today-row">
                  <Avatar :src="post.author?.avatarUrl" size="sm" class="today-row-avatar" />
                  <div class="today-row-body">
                    <div class="today-row-meta">
                      <RouterLink :to="postRoute(post.id)" class="today-row-link" :aria-label="postLabel(post)">
                        <DisplayName
                          v-if="post.author"
                          :user-id="post.author.id"
                          :fallback="post.author.displayName || post.author.username || ''"
                          truncate
                        />
                      </RouterLink>
                      <span v-if="post.author" class="today-handle">{{ handle(post.author) }}</span>
                      <time v-if="post.createdAt" class="today-row-time" :datetime="post.createdAt">{{ relative(post.createdAt) }}</time>
                    </div>
                    <TodayPreview
                      :content="post.content"
                      :message-id="post.id"
                      :content-warning="post.contentWarning"
                      :extra-attachments="post.mediaCount"
                      :lines="3"
                    />
                    <div class="today-post-stats" aria-hidden="true">
                      <span><Icon name="message-circle" :size="12" /> {{ post.repliesCount }}</span>
                      <span><Icon name="repeat" :size="12" /> {{ post.reblogsCount }}</span>
                      <span><Icon name="heart" :size="12" /> {{ post.favoritesCount }}</span>
                    </div>
                  </div>
                </li>
              </ul>
            </TodaySection>
          </div>
        </div>
      </div>
    </div>

    <p class="today-sr-only" aria-live="polite">{{ liveStatus }}</p>

    <UserProfileModal
      :show="showProfileModal"
      :user="profileModalUser"
      @close="showProfileModal = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import ServerIcon from '@/components/common/ServerIcon.vue'
import DisplayName from '@/components/DisplayName.vue'
import UserProfileModal from '@/components/UserProfileModal.vue'
import TodaySection, { type TodaySectionState } from '@/components/today/TodaySection.vue'
import TodayMentionRow from '@/components/today/TodayMentionRow.vue'
import TodayConversationRow from '@/components/today/TodayConversationRow.vue'
import TodayPreview from '@/components/today/TodayPreview.vue'
import { useTodaySummary, joinVoiceFromToday } from '@/composables/useTodaySummary'
import { useTodayDashboard } from '@/composables/useTodayDashboard'
import { useProfileStore } from '@/stores/useProfile'
import { todayDigestService, type ChannelHighlight } from '@/services/TodayDigestService'
import { renderAnnouncementHtml } from '@/utils/announcementContent'
import { formatShortRelativeTime } from '@/utils/shortRelativeTime'
import { userStorage } from '@/utils/userScopedStorage'
import {
  announcementIcon,
  channelRoute,
  headlineStats,
  postRoute,
  relativePhrase,
  threadRoute,
  type HeadlineStat,
  type TodayChannel,
  type TodayPost,
  type TodayProfile,
  type TodaySectionId,
  type TodaySocialItem,
  type TodayVoiceChannel,
} from '@/utils/todaySummary'

const PREVIEW_COUNT = 5
const SERVER_PREVIEW_COUNT = 6

const router = useRouter()
const toast = useToast()
const { t, locale } = useI18n()
const profileStore = useProfileStore()
const { todayAiSummariesEnabled } = useTodayDashboard()

const {
  summary,
  status,
  refreshing,
  refreshFailed,
  previousVisit,
  reload,
  markServerRead,
  markAllChannelsRead,
  respondToFollowRequest,
  dismissAnnouncement,
} = useTodaySummary()

const meId = computed(() => profileStore.profileId ?? null)

// Header ----------------------------------------------------------------------------------

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 5) return t('today.greeting.night')
  if (hour < 12) return t('today.greeting.morning')
  if (hour < 18) return t('today.greeting.afternoon')
  return t('today.greeting.evening')
})

const dateLabel = computed(() =>
  new Intl.DateTimeFormat(locale.value, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()))

const relative = (iso: string | Date) =>
  formatShortRelativeTime(iso, { locale: locale.value, nowLabel: t('time.now') })

const sinceLabel = computed(() => {
  if (!previousVisit) return t('today.firstVisit')
  const phrase = relativePhrase(previousVisit, locale.value)
  return phrase ? t('today.sinceVisit', { time: phrase }) : t('today.sinceVisitMoments')
})

const stats = computed(() => headlineStats(summary.value))

const statLabel = (stat: HeadlineStat) => t(`today.stats.${stat.key}`, { count: stat.count }, stat.count)

const focusSection = (id: TodaySectionId) => {
  const el = document.getElementById(`today-${id}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.focus({ preventScroll: true })
}

const liveStatus = computed(() => {
  if (status.value === 'loading') return t('today.loading')
  if (status.value === 'error') return t('today.loadFailed')
  return refreshing.value ? t('today.refreshing') : ''
})

// Sections --------------------------------------------------------------------------------

const stateFor = (hasItems: boolean): TodaySectionState => {
  if (status.value === 'loading') return 'loading'
  if (status.value === 'error') return 'error'
  return hasItems ? 'ready' : 'empty'
}

type Expandable = 'mentions' | 'servers' | 'threads'
const expanded = reactive<Record<Expandable, boolean>>({ mentions: false, servers: false, threads: false })
const toggle = (key: Expandable) => { expanded[key] = !expanded[key] }
const visible = <T,>(key: Expandable, items: T[]): T[] => {
  const limit = key === 'servers' ? SERVER_PREVIEW_COUNT : PREVIEW_COUNT
  return expanded[key] ? items : items.slice(0, limit)
}

const ShowMore = defineComponent({
  props: { expanded: Boolean, total: { type: Number, required: true } },
  emits: ['toggle'],
  setup(props, { emit }) {
    return () => h('button', {
      type: 'button',
      class: 'today-show-more',
      'aria-expanded': props.expanded,
      onClick: () => emit('toggle'),
    }, props.expanded ? t('today.showLess') : t('today.showAll', { count: props.total }))
  },
})

const channelLabel = (channel: TodayChannel) =>
  channel.unreadMentions > 0
    ? t('today.catchUp.channelLabelMentions', {
      channel: channel.name, count: channel.unreadMessages, mentions: channel.unreadMentions,
    })
    : t('today.catchUp.channelLabel', { channel: channel.name, count: channel.unreadMessages }, channel.unreadMessages)

const hasSocial = computed(() => {
  const s = summary.value
  return s.followRequests.length > 0 || s.newFollowers.length > 0 || s.socialItems.length > 0
    || activityChips.value.length > 0
})

const activityChips = computed(() => {
  const c = summary.value.socialCounts
  const chips = [
    { key: 'favorite', icon: 'heart', count: c.favorite },
    { key: 'reblog', icon: 'repeat', count: c.reblog },
    { key: 'reaction', icon: 'smile', count: c.reaction },
    { key: 'mention', icon: 'at-sign', count: c.mention },
    { key: 'reply', icon: 'reply', count: c.reply },
  ]
  return chips
    .filter(chip => chip.count > 0)
    .map(chip => ({ ...chip, label: t(`today.social.activity.${chip.key}`, { count: chip.count }, chip.count) }))
})

const nameOf = (p: Pick<TodayProfile, 'displayName' | 'username'>) =>
  p.displayName || p.username || t('today.unknownUser')

const newFollowersLabel = computed(() => {
  const people = summary.value.newFollowers
  const total = summary.value.totals.newFollowers
  const first = people.slice(0, 2).map(nameOf)
  if (total <= 1) return t('today.social.followedOne', { name: first[0] })
  if (total === 2 && first.length === 2) return t('today.social.followedTwo', { a: first[0], b: first[1] })
  return t('today.social.followedMany', { name: first[0], count: total - 1 }, total - 1)
})

const handle = (p: Pick<TodayProfile, 'username' | 'domain' | 'isLocal'>) =>
  p.username ? (p.isLocal || !p.domain ? `@${p.username}` : `@${p.username}@${p.domain}`) : ''

const voiceParticipantsLabel = (voice: TodayVoiceChannel) => {
  const names = voice.participants.map(nameOf)
  const extra = voice.participantCount - names.length
  return extra > 0
    ? t('today.voice.participantsMore', { names: names.join(', '), count: extra })
    : names.join(', ')
}

const socialItemLabel = (item: TodaySocialItem) =>
  t(item.type === 'activitypub_reply' ? 'today.social.replyLabel' : 'today.social.mentionLabel', {
    name: item.post.author ? nameOf(item.post.author) : t('today.unknownUser'),
  })

const postLabel = (post: TodayPost) =>
  t('today.posts.linkLabel', { name: post.author ? nameOf(post.author) : t('today.unknownUser') })

// Actions ---------------------------------------------------------------------------------

const refresh = () => {
  void reload()
  if (todayAiSummariesEnabled.value) aiForce = true
}

const joiningChannel = ref<string | null>(null)
const joinVoice = async (voice: TodayVoiceChannel) => {
  joiningChannel.value = voice.channelId
  try {
    const joined = await joinVoiceFromToday(router, voice)
    if (!joined) toast.error(t('today.voice.joinFailed'))
  } finally {
    joiningChannel.value = null
  }
}

const showProfileModal = ref(false)
const profileModalUser = ref<any>(null)
const openProfile = (person: TodayProfile) => {
  profileModalUser.value = {
    id: person.id,
    username: person.username,
    display_name: person.displayName,
    avatar_url: person.avatarUrl,
    domain: person.domain,
    is_local: person.isLocal,
  }
  showProfileModal.value = true
}

const goBack = () => router.back()

// On-device highlights --------------------------------------------------------------------

const AI_CACHE_KEY = 'today-ai-cache'
const AI_CACHE_MAX_AGE_MS = 12 * 3600_000
const AI_CACHE_VERSION = 4

interface AiCacheEntry {
  version: number
  signature: string
  highlights: ChannelHighlight[]
  at: number
}

const highlights = ref<ChannelHighlight[]>([])
const highlightsPending = ref(false)
let aiForce = false
let aiRunning = false

const readAiCache = (): AiCacheEntry | null => {
  try {
    const raw = userStorage.getItem(AI_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AiCacheEntry
    return parsed.version === AI_CACHE_VERSION ? parsed : null
  } catch {
    return null
  }
}

const writeAiCache = (entry: AiCacheEntry) => {
  try {
    userStorage.setItem(AI_CACHE_KEY, JSON.stringify(entry))
  } catch { /* storage full; the cache is best-effort */ }
}

// Probed while the summary loads. Without the model nothing renders, cached
// highlights included.
const aiAvailable = todayDigestService.isOnDeviceAiAvailable()

// The skeleton holds the section's slot from the summary's first render, through
// the probe and the model run, so neither moves the sections below it.
const runHighlights = async () => {
  if (!todayAiSummariesEnabled.value || aiRunning || !todayDigestService.isOnDeviceAiSupported()) return
  const channels = todayDigestService.activeChannels(summary.value.servers)
  const signature = todayDigestService.highlightSignature(channels)
  const cached = readAiCache()
  const reuse = cached !== null && Date.now() - cached.at < AI_CACHE_MAX_AGE_MS && !aiForce
  aiForce = false
  if (!reuse && channels.length === 0) return

  aiRunning = true
  highlightsPending.value = true
  try {
    if (!(await aiAvailable)) return
    if (reuse) {
      highlights.value = cached.highlights
      if (cached.signature === signature || channels.length === 0) return
    }
    const result = await todayDigestService.getChannelHighlights(channels)
    highlights.value = result
    writeAiCache({ version: AI_CACHE_VERSION, signature, highlights: result, at: Date.now() })
  } catch {
    /* highlights are optional */
  } finally {
    aiRunning = false
    highlightsPending.value = false
  }
}

// Highlights follow the first load and explicit refreshes, not realtime reloads.
let highlightsSeeded = false
watch(status, (value) => {
  if (value === 'ready' && (!highlightsSeeded || aiForce)) {
    highlightsSeeded = true
    void runHighlights()
  }
})
watch(refreshing, (value, previous) => {
  if (previous && !value && aiForce && status.value === 'ready') void runHighlights()
})
</script>

<style scoped src="../components/today/todayRow.css"></style>

<style scoped>
.today-view {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
  color: var(--text-primary);
}

.today-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 56px;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-primary);
  flex-shrink: 0;
}

.today-heading {
  flex: 1;
  min-width: 0;
}

.today-heading-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.today-heading h1 {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  line-height: var(--line-height-tight);
}

.today-beta {
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.today-subtitle {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--space-1);
  margin: 2px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.today-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-base);
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.today-icon-button.small {
  width: 28px;
  height: 28px;
}

.today-icon-button:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.today-icon-button:disabled {
  cursor: default;
  opacity: 0.6;
}

.today-icon-button:focus-visible,
.today-text-button:focus-visible,
.today-pill-button:focus-visible,
.today-join:focus-visible,
.today-stat:focus-visible,
.today-show-more:focus-visible,
.today-chip:focus-visible,
.today-server-name:focus-visible,
.today-person-name:focus-visible,
.today-followers-text:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.spinning {
  animation: spin 1s linear infinite;
}

.today-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-5) var(--space-5) 112px;
}

.today-inner {
  max-width: 1120px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Headline stats */
.today-stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.today-stat {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 6px 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: var(--background-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

button.today-stat:hover {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-alpha-light);
}

.today-stat.calm {
  cursor: default;
  color: var(--text-secondary);
}

.today-stat.calm :deep(.icon-wrap) {
  color: var(--success);
}

.today-refresh-failed {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.today-refresh-failed :deep(.icon-wrap) {
  color: var(--warning);
}

/* Announcements */
.today-announcements {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.today-announcement {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--harmony-primary-alpha-strong);
  border-radius: var(--radius-lg);
  background: var(--harmony-primary-alpha-light);
}

.today-announcement-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--harmony-primary);
}

.today-announcement-body {
  flex: 1;
  min-width: 0;
}

.today-announcement-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0 0 2px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.today-announcement-content {
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
}

.today-announcement-content :deep(p) {
  margin: 0;
}

.today-announcement-content :deep(a) {
  color: var(--harmony-primary);
}

/* Columns */
.today-columns {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  gap: var(--space-4);
  align-items: start;
}

.today-main,
.today-side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.today-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.today-subsection + .today-subsection {
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-secondary);
}

.today-subheading {
  margin: 0 0 var(--space-1);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.today-text-button {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--harmony-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}

.today-text-button:hover {
  text-decoration: underline;
}

.today-text-button.subtle {
  color: var(--text-secondary);
  font-weight: var(--font-weight-medium);
}

.today-text-button.subtle:hover {
  color: var(--text-primary);
}

.today-show-more {
  display: block;
  width: 100%;
  margin-top: var(--space-2);
  padding: 6px;
  border: none;
  border-radius: var(--radius-base);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
}

.today-show-more:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.today-more-note {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.today-tag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--background-modifier-selected);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  line-height: 18px;
}

.today-ellipsis {
  white-space: nowrap;
  text-overflow: ellipsis;
}

.today-row-sub {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.today-handle {
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Catch up */
.today-servers {
  list-style: none;
  margin: 0;
  padding: 0;
}

.today-server {
  padding: var(--space-3) 0;
}

.today-server:first-child {
  padding-top: 0;
}

.today-server + .today-server {
  border-top: 1px solid var(--border-secondary);
}

.today-server-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  margin-bottom: var(--space-2);
}

.today-server-name {
  min-width: 0;
  max-width: 100%;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: var(--radius-sm);
}

.today-server-name:hover {
  text-decoration: underline;
}

.today-server-counts {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.today-mention-count {
  color: var(--error);
  font-weight: var(--font-weight-semibold);
}

.today-server-head .today-text-button {
  margin-left: auto;
}

.today-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.today-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 10px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: var(--background-primary);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  text-decoration: none;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

a.today-chip:hover {
  border-color: var(--harmony-primary);
}

.today-chip :deep(.icon-wrap) {
  color: var(--text-muted);
  flex-shrink: 0;
}

.today-chip.mentioned {
  border-color: var(--harmony-primary-alpha-strong);
}

.today-chip.more,
.today-chip.static {
  color: var(--text-secondary);
  background: transparent;
}

.today-chip-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: var(--font-weight-medium);
}

.today-chip-mentions {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: var(--radius-full);
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  line-height: 16px;
}

.today-chip-count {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

/* Voice */
.today-voice {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}

.today-voice + .today-voice {
  border-top: 1px solid var(--border-secondary);
}

.today-voice-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.today-voice-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.today-voice-name {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.today-live-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 25%, transparent);
}

.today-voice-sub {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.today-voice-server {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.today-avatar-stack {
  display: inline-flex;
  align-items: center;
}

.today-stack-avatar {
  border-radius: var(--radius-full);
  box-shadow: 0 0 0 2px var(--background-secondary);
}

.today-stack-avatar + .today-stack-avatar {
  margin-left: -6px;
}

.today-stack-more {
  margin-left: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.today-join {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-base);
  background: var(--success);
  color: var(--text-on-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.today-join:hover:not(:disabled) {
  background: var(--success-hover);
}

.today-join.secondary {
  background: var(--background-modifier-selected);
  color: var(--text-primary);
}

.today-join:disabled {
  opacity: 0.6;
  cursor: progress;
}

/* Threads */
.today-thread-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--background-modifier-selected);
  color: var(--text-secondary);
}

.today-thread-foot {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 2px;
}

.today-thread-count {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--harmony-primary);
}

/* Social */
.today-person {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) 0;
}

.today-person .today-row-avatar {
  margin-top: 0;
}

.today-person-name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  text-align: left;
  cursor: pointer;
}

.today-person-name > * {
  max-width: 100%;
}

.today-person-actions {
  display: flex;
  gap: var(--space-1);
  flex-shrink: 0;
}

.today-pill-button {
  padding: 4px 10px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.today-pill-button:hover {
  background: var(--background-modifier-hover);
}

.today-pill-button.primary {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.today-pill-button.primary:hover {
  background: var(--harmony-primary-hover);
}

.today-followers {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.today-followers-text {
  min-width: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  text-decoration: none;
  border-radius: var(--radius-sm);
}

.today-followers-text:hover {
  color: var(--text-primary);
  text-decoration: underline;
}

.today-post-stats {
  display: flex;
  gap: var(--space-3);
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.today-post-stats span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

/* Highlights */
.today-highlight {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  padding: var(--space-2) 0;
}

.today-highlight-server {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.today-highlight-text {
  flex-basis: 100%;
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.today-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* One column below 900px: the column wrappers dissolve and `order` interleaves the sections. */
@media (max-width: 900px) {
  .today-columns {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  .today-main,
  .today-side {
    display: contents;
  }

  .order-mentions { order: 1; }
  .order-highlights { order: 2; }
  .order-conversations { order: 3; }
  .order-voice { order: 4; }
  .order-catch-up { order: 5; }
  .order-threads { order: 6; }
  .order-social { order: 7; }
  .order-posts { order: 8; }
}

@media (max-width: 600px) {
  .today-header {
    padding: var(--space-2) var(--space-3);
  }

  .today-scroll {
    padding: var(--space-3) var(--space-3) 112px;
  }

  .today-inner {
    gap: var(--space-3);
  }

  .today-person {
    flex-wrap: wrap;
  }

  .today-person-actions {
    width: 100%;
    padding-left: calc(40px + var(--space-3));
  }
}
</style>
