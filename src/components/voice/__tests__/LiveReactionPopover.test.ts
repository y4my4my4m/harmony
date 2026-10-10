import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import LiveReactionPopover from '../LiveReactionPopover.vue'
import { SEND_BURST, decodeLiveReaction, liveReactions } from '@/services/voice/liveReactions'
import { VOICE_POPOVER_DISMISS } from '../voiceMenuModel'

// The quick bar offers frequent emoji then the defaults, sends to the tile it
// was opened for, says so when rate limited, and is driven from the keyboard.

const m = vi.hoisted(() => ({
  top: [] as Array<{ id: string; native?: string; name: string; url?: string }>,
  record: null as any,
}))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/common/Icon.vue', () => ({ __esModule: true, default: { name: 'Icon', render: () => null } }))
vi.mock('@/composables/useFrequentEmojis', () => ({
  useFrequentEmojis: () => ({ getTopEmojis: (n: number) => m.top.slice(0, n), recordEmojiUsage: m.record }),
}))
vi.mock('@/components/EmojiPopup.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    __esModule: true,
    default: defineComponent({
      name: 'EmojiPopup',
      props: ['triggerElement', 'teleportTo', 'closeEmojiList', 'position', 'isReaction'],
      emits: ['sendEmoji'],
      setup(_props, { emit }) {
        return () => h('button', {
          class: 'stub-picker',
          onClick: () => emit('sendEmoji', { id: 'party-id', name: 'party', url: 'https://cdn.test/party.webp' }),
        })
      },
    }),
  }
})

const CUSTOM = 'party-id'
let published: Uint8Array[] = []
let wrapper: VueWrapper | null = null
let anchor: HTMLButtonElement

const Host = defineComponent({
  props: { target: { type: Object, default: null } },
  emits: ['close'],
  setup(props, { emit }) {
    return () => h(LiveReactionPopover, {
      visible: true,
      anchor,
      target: props.target as any,
      onClose: () => emit('close'),
    })
  },
})

async function open(target: unknown = { userId: 'bob', source: 'screen' }) {
  wrapper = mount(Host, { props: { target }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

const panel = () => document.body.querySelector<HTMLElement>('.lrp')!
const emojiButtons = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('.lrp-emoji'))
const labels = () => emojiButtons().map(b => b.getAttribute('aria-label'))

beforeEach(() => {
  published = []
  m.top = []
  m.record = vi.fn()
  anchor = document.createElement('button')
  document.body.appendChild(anchor)
  liveReactions.connect({
    publish: payload => { published.push(payload); return true },
    toWireId: id => `wire-${id}`,
    fromWireId: () => null,
    localUserId: () => 'me',
    isParticipant: () => true,
    showOthers: () => true,
    resolveUnicode: value => ({ kind: 'text', text: value, label: value }),
    resolveCustom: id => (id === CUSTOM ? { src: '/emoji/party.webp', label: 'party' } : null),
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  anchor.remove()
  liveReactions.disconnect()
})

describe('LiveReactionPopover', () => {
  it('offers frequent emoji first, skips unknown custom ones and fills with the defaults', async () => {
    m.top = [
      { id: '🙏', native: '🙏', name: 'pray' },
      { id: CUSTOM, name: 'party', url: 'https://cdn.test/party.webp' },
      { id: 'gone-id', name: 'gone', url: 'https://cdn.test/gone.webp' },
      { id: '🔥', native: '🔥', name: 'fire' },
    ]
    await open()
    expect(labels()).toEqual(['🙏', 'party', '🔥', '👍', '❤️', '😂'])
    expect(document.body.querySelector('.lrp-emoji-img')?.getAttribute('src')).toBe('/emoji/party.webp')
  })

  it('sends to the tile it was opened for and stays open', async () => {
    await open({ userId: 'bob', source: 'screen' })
    emojiButtons()[0].click()
    await nextTick()
    expect(decodeLiveReaction(published[0])).toEqual({
      type: 'live_reaction',
      emoji: { kind: 'unicode', value: '👍' },
      targetParticipant: 'wire-bob',
      targetSource: 'screen',
    })
    expect(m.record).toHaveBeenCalledWith({ id: '👍', native: '👍', name: '👍' })
    expect(wrapper!.emitted('close')).toBeUndefined()
    expect(panel()).not.toBeNull()
  })

  it('without a target sends an untargeted reaction', async () => {
    await open(null)
    emojiButtons()[1].click()
    expect(decodeLiveReaction(published[0])?.targetParticipant).toBeUndefined()
  })

  it('says to slow down once the send budget is spent', async () => {
    await open()
    for (let i = 0; i < SEND_BURST + 1; i++) emojiButtons()[0].click()
    await nextTick()
    expect(published).toHaveLength(SEND_BURST)
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe('voice.reactionSlowDown')
  })

  it('sends a custom emoji picked from the full picker by id', async () => {
    await open()
    document.body.querySelector<HTMLButtonElement>('.lrp-more')!.click()
    await flushPromises()
    document.body.querySelector<HTMLButtonElement>('.stub-picker')!.click()
    await flushPromises()
    expect(decodeLiveReaction(published[0])?.emoji).toEqual({ kind: 'custom', value: CUSTOM })
    expect(document.body.querySelector('.stub-picker')).toBeNull()
  })

  it('focuses the first emoji, moves with the arrow keys and closes on Escape', async () => {
    await open()
    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.lrp-row button'))
    expect(document.activeElement).toBe(buttons[0])

    const key = (k: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    key('ArrowRight')
    expect(document.activeElement).toBe(buttons[1])
    key('ArrowLeft')
    key('ArrowLeft')
    expect(document.activeElement).toBe(buttons[buttons.length - 1])
    key('Home')
    expect(document.activeElement).toBe(buttons[0])

    key('Escape')
    await nextTick()
    expect(wrapper!.emitted('close')).toHaveLength(1)
    expect(document.activeElement).toBe(anchor)
  })

  it('closes when the overlay dismisses voice popovers', async () => {
    await open()
    window.dispatchEvent(new CustomEvent(VOICE_POPOVER_DISMISS))
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })
})
