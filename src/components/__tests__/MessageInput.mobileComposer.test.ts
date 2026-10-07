/**
 * MessageInput compact composer (viewport <= 768px): with content, `+`, mic and GIF
 * collapse behind one chevron; emoji sits inside the field; send shows with content.
 * Desktop markup does not change.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'

const isMobileViewport = ref(false)
const serverChannelStore = reactive({
  channels: [] as Array<{ id: string; slowmode_seconds?: number }>,
  currentServerId: null as string | null,
  currentChannelId: null as string | null,
})
const editorProps: Array<Record<string, unknown>> = []

vi.mock('@/composables/useViewport', () => ({
  useViewport: () => ({
    viewportWidth: ref(1440),
    viewportHeight: ref(900),
    isMobileViewport,
    isTouchOnly: false,
    MOBILE_BREAKPOINT: 768,
  }),
}))

vi.mock('@/composables/useAutoSuggest', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    useAutoSuggest: () => ({
      state: vueRef({ isActive: false, selectedIndex: 0, position: { top: 0, left: 0 } }),
      suggestions: vueRef([]),
      headerText: vueRef(''),
      activeCommand: vueRef(null),
      handleInput: vi.fn(),
      handleKeyDown: vi.fn(() => false),
      selectSuggestion: vi.fn(),
      closeSuggestions: vi.fn(),
      dismissActiveCommand: vi.fn(),
      updatePosition: vi.fn(),
    }),
  }
})
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerMessage: vi.fn() }) }))
vi.mock('@/composables/useTypingIndicator', async () => {
  const { ref: vueRef } = await import('vue')
  return {
    useTypingIndicator: () => ({ typingUsers: vueRef([]), startTyping: vi.fn(), stopTyping: vi.fn() }),
  }
})
vi.mock('@/composables/useFrequentEmojis', () => ({ useFrequentEmojis: () => ({ recordEmojiUsage: vi.fn() }) }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: null }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => serverChannelStore }))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ settings: { maxMessageLength: 100, maxMediaAttachmentsPerPost: 20 } }),
}))
vi.mock('@/services/RoleService', () => ({
  roleService: { hasPermission: vi.fn(async () => true) },
  Permission: { SEND_MESSAGES: 'SEND_MESSAGES', MANAGE_MESSAGES: 'MANAGE_MESSAGES' },
}))
vi.mock('@/services/fileService', () => ({ backgroundUploadManager: { startUpload: vi.fn() } }))
vi.mock('@/services/privateMedia', () => ({ mediaRoom: () => null, uploadMessageMedia: vi.fn() }))
vi.mock('@/utils/ephemeralEmoji', () => ({
  buildEphemeralEmojiFromGif: vi.fn(),
  registerEphemeralEmoji: vi.fn(),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), info: vi.fn() }) }))

async function stub(name: string, tag = 'span', className?: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h(tag, className ? { class: className } : {}) }) }
}
vi.mock('@/components/TypingIndicator.vue', () => stub('TypingIndicator'))
vi.mock('@/components/MessageReply.vue', () => stub('MessageReply', 'div', 'attachedBars'))
vi.mock('@/components/FilePreview.vue', () => stub('FilePreview'))
vi.mock('@/components/InlineGifPicker.vue', () => stub('InlineGifPicker'))
vi.mock('@/components/FileUploadMenu.vue', () => stub('FileUploadMenu'))
vi.mock('@/components/AutoSuggest.vue', () => stub('AutoSuggest'))
vi.mock('@/components/EmojiUI.vue', () => stub('EmojiUI', 'div', 'spriteContainer'))
vi.mock('@/components/icons/Gif.vue', () => stub('GifIcon', 'svg'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon', 'svg'))
vi.mock('@/components/icons/Plus.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'PlusIcon',
      emits: ['click'],
      setup: (_, { emit }) => () => h('svg', { class: 'plus', onClick: (e: Event) => emit('click', e) }),
    }),
  }
})
vi.mock('@/components/VoiceRecorder.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'VoiceRecorder',
      props: { disabled: Boolean, autoStart: Boolean },
      render() {
        return h('div', { class: 'voice-recorder' }, [
          h('button', { class: 'mic-trigger', disabled: this.disabled, title: 'Record voice message' }),
        ])
      },
    }),
  }
})
vi.mock('@/components/RichTextEditor.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'RichTextEditor',
      props: {
        modelValue: { type: String, default: '' },
        placeholder: String,
        maxHeight: { type: Number, default: 200 },
        minHeight: { type: Number, default: 44 },
        autoSuggestActive: Boolean,
        autoSuggestSelectedId: String,
      },
      emits: ['update:modelValue', 'input', 'keydown', 'focus', 'blur', 'cursor-position-changed', 'paste'],
      setup(props, { expose }) {
        editorProps.push(props)
        expose({ focus: vi.fn(), clear: vi.fn(), getPlainText: () => props.modelValue })
        return () => h('div', {
          class: 'rich-text-editor',
          style: { '--min-height': `${props.minHeight}px`, '--max-height': `${props.maxHeight}px` },
        })
      },
    }),
  }
})

import MessageInput from '../MessageInput.vue'

type Wrapper = ReturnType<typeof mount<typeof MessageInput>>

const mountInput = (props: Record<string, unknown> = {}) =>
  mount(MessageInput, {
    props: { modelValue: '', ...props },
    global: { mocks: { $t: (key: string) => key }, stubs: { transition: false } },
  })

const lastEditorProps = () => editorProps[editorProps.length - 1]

/** Mirrors the parent's v-model round trip for a keystroke from the editor. */
const typeInEditor = async (wrapper: Wrapper, value: string) => {
  wrapper.findComponent({ name: 'RichTextEditor' }).vm.$emit('update:modelValue', value)
  await wrapper.setProps({ modelValue: value })
}

const isCollapsed = (wrapper: Wrapper, selector: string) =>
  wrapper.get(selector).classes().includes('is-collapsed')

describe('MessageInput compact composer', () => {
  beforeEach(() => {
    isMobileViewport.value = true
    serverChannelStore.channels = []
    editorProps.length = 0
  })

  it('shows + left and mic, GIF right while empty; no chevron, no send', () => {
    const wrapper = mountInput()
    expect(isCollapsed(wrapper, '.left-icons .composer-expand')).toBe(true)
    expect(isCollapsed(wrapper, '.left-icons .plus-icon-container')).toBe(false)
    expect(isCollapsed(wrapper, '.right-icons .voice-recorder')).toBe(false)
    expect(isCollapsed(wrapper, '.right-icons button[aria-label="GIFs"]')).toBe(false)
    expect(wrapper.find('[data-testid="message-send-btn"]').exists()).toBe(false)
  })

  it('collapses +, mic and GIF behind the chevron once the field has content', async () => {
    const wrapper = mountInput()
    await typeInEditor(wrapper, 'hello')
    expect(isCollapsed(wrapper, '.left-icons .composer-expand')).toBe(false)
    expect(isCollapsed(wrapper, '.left-icons .plus-icon-container')).toBe(true)
    expect(isCollapsed(wrapper, '.right-icons .voice-recorder')).toBe(true)
    expect(isCollapsed(wrapper, '.right-icons button[aria-label="GIFs"]')).toBe(true)
    expect(wrapper.get('.composer-expand').attributes('aria-label')).toBe('message.moreActions')
  })

  it('re-expands on chevron tap until the next keystroke', async () => {
    const wrapper = mountInput({ modelValue: 'hello' })
    expect(isCollapsed(wrapper, '.plus-icon-container')).toBe(true)

    await wrapper.get('.composer-expand').trigger('click')
    expect(isCollapsed(wrapper, '.composer-expand')).toBe(true)
    expect(isCollapsed(wrapper, '.plus-icon-container')).toBe(false)
    expect(isCollapsed(wrapper, '.right-icons .voice-recorder')).toBe(false)
    expect(isCollapsed(wrapper, '.right-icons button[aria-label="GIFs"]')).toBe(false)

    await typeInEditor(wrapper, 'hello!')
    expect(isCollapsed(wrapper, '.plus-icon-container')).toBe(true)
    expect(isCollapsed(wrapper, '.composer-expand')).toBe(false)
  })

  it('collapses again once an expanded action is used', async () => {
    const wrapper = mountInput({ modelValue: 'hello' })
    await wrapper.get('.composer-expand').trigger('click')
    await wrapper.get('.right-icons button[aria-label="GIFs"]').trigger('click')
    expect(wrapper.emitted('toggleGiphy')).toHaveLength(1)
    expect(isCollapsed(wrapper, '.plus-icon-container')).toBe(true)
  })

  it('keeps + expanded while its upload menu is open', async () => {
    const wrapper = mountInput({ modelValue: 'hello' })
    await wrapper.get('.composer-expand').trigger('click')
    await wrapper.get('.plus-icon-container .plus').trigger('click')
    await typeInEditor(wrapper, 'hello!')
    expect(isCollapsed(wrapper, '.plus-icon-container')).toBe(false)

    wrapper.findComponent({ name: 'FileUploadMenu' }).vm.$emit('close')
    await nextTick()
    expect(isCollapsed(wrapper, '.plus-icon-container')).toBe(true)
  })

  it('places emoji inside the field and not among the right icons', () => {
    const wrapper = mountInput()
    const emoji = wrapper.get('.textarea-wrapper button[aria-label="Emoji"]')
    expect(emoji.attributes('title')).toBe('Emoji')
    expect(wrapper.find('.right-icons button[aria-label="Emoji"]').exists()).toBe(false)
    expect((wrapper.vm as unknown as { emojiTriggerRef: HTMLElement }).emojiTriggerRef).toBe(emoji.element)
  })

  it('shows the send button only with content, outside the field', async () => {
    const wrapper = mountInput()
    expect(wrapper.find('[data-testid="message-send-btn"]').exists()).toBe(false)
    await typeInEditor(wrapper, 'hello')
    const send = wrapper.get('[data-testid="message-send-btn"]')
    expect(send.element.closest('.textarea-wrapper')).toBeNull()
    expect(send.element.closest('.right-icons')).not.toBeNull()
    await send.trigger('click')
    expect(wrapper.emitted('sendMessage')?.[0]?.[0]).toBe('hello')

    await wrapper.setProps({ modelValue: '' })
    expect(isCollapsed(wrapper, '.plus-icon-container')).toBe(false)
    expect(isCollapsed(wrapper, '.composer-expand')).toBe(true)
  })

  it('caps the editor at five lines', () => {
    mountInput()
    expect(lastEditorProps().maxHeight).toBe(128)
    expect(lastEditorProps().minHeight).toBe(40)
  })

  it('keeps slowmode and the char counter visible inside the field', async () => {
    serverChannelStore.channels = [{ id: 'c1', slowmode_seconds: 10 }]
    const wrapper = mountInput({ channelId: 'c1', modelValue: 'x'.repeat(90) })
    await nextTick()
    expect(wrapper.find('.textarea-wrapper .slowmode-indicator').exists()).toBe(true)
    expect(wrapper.get('.textarea-wrapper .message-char-count').text()).toBe('10')
    expect(wrapper.find('.right-icons .slowmode-indicator').exists()).toBe(false)
    expect(wrapper.find('.right-icons .message-char-count').exists()).toBe(false)
  })

  it('replaces the row with the recorder while recording', async () => {
    const wrapper = mountInput()
    wrapper.findComponent({ name: 'VoiceRecorder' }).vm.$emit('recording-started')
    await nextTick()
    expect(wrapper.find('.voice-recording-wrapper').exists()).toBe(true)
    expect(wrapper.find('.textarea-wrapper').exists()).toBe(false)
    expect(wrapper.find('.composer-expand').exists()).toBe(false)
  })
})

describe('MessageInput desktop composer', () => {
  beforeEach(() => {
    isMobileViewport.value = false
    serverChannelStore.channels = []
    editorProps.length = 0
  })

  it('keeps + left and mic, GIF, emoji right, with no chevron or send', async () => {
    const wrapper = mountInput()
    await typeInEditor(wrapper, 'hello')
    const children = (selector: string) =>
      Array.from(wrapper.get(selector).element.children).map((el) => el.getAttribute('aria-label') ?? el.className)
    expect(children('.left-icons')).toEqual(['plus-icon-container'])
    expect(children('.textarea-wrapper')).toEqual(['rich-text-editor'])
    expect(children('.right-icons')).toEqual(['voice-recorder', 'GIFs', 'Emoji'])
    expect(wrapper.find('.is-collapsed').exists()).toBe(false)
  })

  it('leaves the editor at its default height bounds', () => {
    mountInput()
    expect(lastEditorProps().maxHeight).toBe(200)
    expect(lastEditorProps().minHeight).toBe(44)
  })

  it('keeps slowmode and the char counter among the right icons', async () => {
    serverChannelStore.channels = [{ id: 'c1', slowmode_seconds: 10 }]
    const wrapper = mountInput({ channelId: 'c1', modelValue: 'x'.repeat(90) })
    await nextTick()
    expect(wrapper.find('.right-icons .slowmode-indicator').exists()).toBe(true)
    expect(wrapper.find('.right-icons .message-char-count').exists()).toBe(true)
    expect(wrapper.find('.textarea-wrapper .slowmode-indicator').exists()).toBe(false)
  })
})
