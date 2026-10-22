/**
 * System rows render from metadata: the people are metadata ids shown as clickable names,
 * never the row's author, and never the stored English content of a known type.
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import de from '@/locales/de.json'
import es from '@/locales/es.json'
import fr from '@/locales/fr.json'
import ja from '@/locales/ja.json'
import ko from '@/locales/ko.json'
import zh from '@/locales/zh.json'
import SystemEventBody from '@/components/messages/SystemEventBody.vue'

const ME = '00000000-0000-4000-8000-000000000001'
const BOB = '00000000-0000-4000-8000-000000000002'
const CAROL = '00000000-0000-4000-8000-000000000003'
const BOT = '00000000-0000-4000-8000-0000000000b1'
const THREAD = '00000000-0000-4000-8000-0000000000f1'
const NAMES: Record<string, string> = { [ME]: 'Me', [BOB]: 'Bob', [CAROL]: 'Carol' }

vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: ME } }) }))
vi.mock('@/components/DisplayName.vue', () => ({
  default: defineComponent({ props: { userId: String }, setup: (p) => () => h('span', NAMES[p.userId!] ?? '?') }),
}))
vi.mock('@/components/messages/CallJoinButton.vue', () => ({
  default: defineComponent({ setup: () => () => h('button', { class: 'join-call' }, 'Join') }),
}))
vi.mock('@/components/UnifiedMessageContent.vue', () => ({
  default: defineComponent({ props: { content: Array }, setup: (p) => () => h('span', { class: 'raw' }, (p.content as any[])?.[0]?.text) }),
}))
vi.mock('@/components/common/Icon.vue', () => ({
  default: defineComponent({ props: { name: String }, setup: (p) => () => h('i', { 'data-icon': p.name }) }),
}))

function render(metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
  return mount(SystemEventBody, {
    props: {
      message: {
        id: 'm1', is_system: true, user_id: null, bot_id: null, created_at: new Date(),
        content: [{ type: 'text', text: 'has joined the server' }], metadata, ...extra,
      } as any,
      conversationId: null,
      userColor: () => '#123456',
      botName: (id: string) => (id === BOT ? 'Discord Bridge' : 'Bot'),
    },
    global: { plugins: [i18n] },
  })
}

// Separate elements of a row (the sentence, a reason, a call's state) are joined by ' | '.
const text = (w: ReturnType<typeof render>) =>
  w.find('.system-text').findAll(':scope > *').map(e => e.text().replace(/\s+/g, ' ').trim()).join(' | ')

describe('SystemEventBody', () => {
  it('names the joined member from subject_id, clickable, without the stored content', async () => {
    const w = render({ type: 'member_join', subject_id: BOB })
    expect(text(w)).toBe('Bob joined the server.')
    expect(w.find('[data-system-type="member_join"]').exists()).toBe(true)
    await w.find('.system-user-mention').trigger('click')
    expect(w.emitted('showUserProfile')).toEqual([[BOB]])
  })

  it('reads a leave, a kick with its moderator and reason, and a ban with no moderator', () => {
    expect(text(render({ type: 'member_leave', subject_id: BOB }))).toBe('Bob left the server.')
    expect(text(render({ type: 'member_kick', subject_id: BOB, actor_id: CAROL, reason: 'spam' })))
      .toBe('Carol kicked Bob. | Reason: spam')
    expect(text(render({ type: 'member_ban', subject_id: BOB, reason: '' }))).toBe('Bob was banned.')
  })

  it('names a missing person "Someone"', () => {
    expect(text(render({ type: 'member_join' }))).toBe('Someone joined the server.')
  })

  it('links the thread and all threads', async () => {
    const w = render({ type: 'thread_created', actor_id: BOB, thread_id: THREAD, thread_name: 'Plans' })
    expect(text(w)).toBe('Bob started a thread: Plans. See all threads.')
    await w.find('.system-thread-link').trigger('click')
    await w.find('.system-threads-link').trigger('click')
    expect(w.emitted('openThread')).toEqual([[THREAD, 'Plans']])
    expect(w.emitted('showAllThreads')).toHaveLength(1)
  })

  it('names a bridged thread\'s Discord member, else its bot, else the name another instance sent', () => {
    expect(text(render({ type: 'thread_created', actor_bot_id: BOT, discord_user: { id: '1', username: 'finn', display_name: 'Finn' }, thread_id: THREAD, thread_name: 'Lounge' })))
      .toBe('Finn started a thread: Lounge. See all threads.')
    expect(text(render({ type: 'thread_created', actor_bot_id: BOT, thread_id: THREAD, thread_name: 'Weekend' })))
      .toBe('Discord Bridge started a thread: Weekend. See all threads.')
    expect(text(render({ type: 'thread_created', actor_name: 'Remote Bot' }))).toBe('Remote Bot started a thread.')
  })

  it('reads calls from the caller in actor_id', () => {
    expect(text(render({ type: 'call_started', actor_id: BOB, call_type: 'video' }))).toBe('Bob started a video call. | Join')
    expect(text(render({ type: 'call_ended', actor_id: BOB, call_type: 'voice', participants: [BOB, ME], duration_seconds: 185 })))
      .toBe('Bob started a voice call that lasted 3m 5s.')
    expect(text(render({ type: 'call_ended', actor_id: BOB, call_type: 'voice', participants: [BOB] })))
      .toBe('You missed a voice call from Bob.')
    expect(text(render({ type: 'call_ended', actor_id: ME, call_type: 'voice', participants: [ME] })))
      .toBe('Me started a voice call. | No answer')
  })

  it('reads group notices with a plural count and a list of added members', async () => {
    expect(text(render({ type: 'group_created', actor_id: BOB, event: 'created', participant_count: 3 })))
      .toBe('Bob created the group with 3 participants.')
    const w = render({ type: 'group_created', actor_id: BOB, event: 'members_added', user_ids: [CAROL, ME] })
    expect(text(w)).toBe('Bob added Carol, Me to the group.')
    expect(w.findAll('.system-user-mention')).toHaveLength(3)
  })

  it('reads encryption toggles with the moderator first', () => {
    expect(text(render({ type: 'channel_voice_encryption_disabled', actor_id: CAROL })))
      .toBe('Carol turned off end-to-end encryption for voice and video.')
  })

  it('renders the stored content for an unknown type', () => {
    const w = render({ type: 'something_new' }, { content: [{ type: 'text', text: 'server text' }] })
    expect(w.find('.raw').text()).toBe('server text')
  })
})

describe('systemEvents locales', () => {
  type Tree = Record<string, unknown>
  const leaves = (tree: Tree, prefix = ''): Array<[string, string]> =>
    Object.entries(tree).flatMap(([k, v]) =>
      v && typeof v === 'object' ? leaves(v as Tree, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)]])
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().filter((v, i, a) => a.indexOf(v) === i)
  const base = new Map(leaves((en as any).systemEvents))

  it.each(Object.entries({ de, es, fr, ja, ko, zh }))('%s has every key with the same placeholders', (_locale, messages) => {
    const local = new Map(leaves((messages as any).systemEvents))
    expect([...local.keys()].sort()).toEqual([...base.keys()].sort())
    for (const [key, value] of base) {
      expect([key, placeholders(local.get(key)!)]).toEqual([key, placeholders(value)])
    }
  })
})
