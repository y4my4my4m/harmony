import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({
  joinGame: vi.fn(async () => true),
  joinWatch: vi.fn(async () => true),
  apps: new Map<string, { id: string; iconUrl: string; source: string }>(),
}))

vi.mock('@/stores/playTogether', () => ({
  usePlayTogetherStore: () => ({
    appById: (id: string) => mocks.apps.get(id),
    appLabel: (app: { id: string }) => ({ name: app.id === 'drawinphone' ? 'DrawinPhone' : 'Tic Tac', description: '' }),
    refusalText: (code: string) => `refused:${code}`,
    join: mocks.joinGame,
  }),
}))
vi.mock('@/stores/activities', () => ({ useActivitiesStore: () => ({ join: mocks.joinWatch }) }))
vi.mock('@/composables/useT', () => ({ useT: () => ({ t: (key: string) => key, locale: { value: 'en' } }) }))
vi.mock('@/utils/avatarUtils', () => ({ getAvatarUrl: (url: string) => url }))

import CallActivityTile from '../CallActivityTile.vue'

const stubs = {
  'i18n-t': { props: ['keypath'], template: '<span :data-key="keypath"><slot name="name" /> <slot name="app" /></span>' },
  DisplayName: { props: ['userId', 'fallback'], template: '<b class="who">{{ fallback || userId }}</b>' },
  Avatar: { template: '<i class="avatar" />' },
  Icon: { props: ['name'], template: '<i class="icon" :data-name="name" />' },
}

const session = (over: Record<string, unknown> = {}) => ({
  id: 's1', app_id: 'drawinphone', app_name: 'DrawinPhone', conversation_id: null, channel_id: 'v1', message_id: null,
  status: 'active', started_at: '', ended_at: null, played_count: 0,
  members: [{ id: 'sp', username: 'sp', display_name: 'Spartzy', avatar_url: null }],
  ...over,
})

beforeEach(() => {
  mocks.joinGame.mockClear()
  mocks.joinWatch.mockClear()
  mocks.apps.clear()
  mocks.apps.set('drawinphone', { id: 'drawinphone', iconUrl: '/activities/drawinphone/icon.svg', source: 'builtin' })
  mocks.apps.set('tictac', { id: 'tictac', iconUrl: '/activities/tictac/icon.svg', source: 'package' })
})

describe('CallActivityTile', () => {
  it('shows a game with its icon, who plays it, and Join that joins the session', async () => {
    const game = session()
    const w = mount(CallActivityTile, { props: { game: game as never }, global: { stubs } })
    expect(w.attributes('data-kind')).toBe('game')
    expect(w.find('img').attributes('src')).toBe('/activities/drawinphone/icon.svg')
    expect(w.find('.call-activity-tile__title').text()).toBe('DrawinPhone')
    expect(w.find('[data-key="playTogether.bannerOne"]').text()).toContain('Spartzy')
    expect(w.find('[data-testid="call-activity-third-party"]').exists()).toBe(false)
    await w.get('[data-testid="play-together-join"]').trigger('click')
    expect(mocks.joinGame).toHaveBeenCalledWith(game)
  })

  it('shows why a member cannot join a game instead of Join', () => {
    const w = mount(CallActivityTile, { props: { game: session({ refusal: 'CANNOT_SEND' }) as never }, global: { stubs } })
    expect(w.get('[data-testid="play-together-refusal"]').text()).toBe('refused:CANNOT_SEND')
    expect(w.find('[data-testid="play-together-join"]').exists()).toBe(false)
  })

  it('labels a third-party game', () => {
    const w = mount(CallActivityTile, { props: { game: session({ app_id: 'tictac' }) as never }, global: { stubs } })
    expect(w.find('[data-testid="call-activity-third-party"]').exists()).toBe(true)
  })

  it('shows watch together by its title and who started it, without its picture, and joins it', async () => {
    const watch = { channel_id: 'v1', host_id: 'h1', source: 'youtube', item: { video_id: 'x', title: 'A video', thumbnail: 'https://i.example/t.jpg' } }
    const w = mount(CallActivityTile, { props: { watch: watch as never }, global: { stubs } })
    expect(w.attributes('data-kind')).toBe('watch')
    expect(w.find('.call-activity-tile__title').text()).toBe('A video')
    expect(w.find('[data-key="activities.startedBy"]').text()).toContain('h1')
    expect(w.find('img').exists()).toBe(false)
    await w.get('[data-testid="activity-join"]').trigger('click')
    expect(mocks.joinWatch).toHaveBeenCalled()
    expect(mocks.joinGame).not.toHaveBeenCalled()
  })
})
