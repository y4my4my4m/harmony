import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import GroupSettingsModal from '../GroupSettingsModal.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}${JSON.stringify(params)}` : key),
    locale: { value: 'en' },
  }),
}))

async function stubs() {
  const { defineComponent, h } = await import('vue')
  return {
    BaseModal: defineComponent({
      name: 'BaseModal',
      props: { show: Boolean, title: String },
      setup: (props, { slots }) => () => (props.show ? h('div', { role: 'dialog' }, [h('h2', props.title), slots.default?.()]) : null),
    }),
    ConfirmationModal: defineComponent({
      name: 'ConfirmationModal',
      props: { show: Boolean, title: String, message: String, confirmButtonText: String },
      setup: (props) => () => h('div', { class: 'confirm-stub' }, [props.title, ' ', props.message, ' ', props.confirmButtonText]),
    }),
    Plain: (name: string) => defineComponent({ name, render: () => h('span') }),
  }
}

vi.mock('@/components/common/BaseModal.vue', async () => ({ default: (await stubs()).BaseModal }))
vi.mock('@/components/ConfirmationModal.vue', async () => ({ default: (await stubs()).ConfirmationModal }))
vi.mock('@/components/common/Avatar.vue', async () => ({ default: (await stubs()).Plain('Avatar') }))
vi.mock('@/components/common/Icon.vue', async () => ({ default: (await stubs()).Plain('Icon') }))
vi.mock('@/components/common/GroupIcon.vue', async () => ({ default: (await stubs()).Plain('GroupIcon') }))
vi.mock('@/components/dm/GroupChatInviteModal.vue', async () => ({ default: (await stubs()).Plain('GroupChatInviteModal') }))
vi.mock('@/components/DisplayName.vue', async () => ({ default: (await stubs()).Plain('DisplayName') }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/utils/groupIconUtils', () => ({ uploadGroupIcon: vi.fn(), deleteGroupIcon: vi.fn() }))
vi.mock('@/utils/uploadValidation', () => ({ imageSourceError: () => null }))
vi.mock('@/composables/useImageCrop', () => ({ useImageCrop: () => ({ cropImage: vi.fn() }) }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => ({ getConversationParticipants: vi.fn(async () => []) }) }))
vi.mock('@/composables/useUserData', () => ({ useUserData: () => ({ getCurrentUser: { value: { id: 'me' } } }) }))

enableAutoUnmount(afterEach)

const participants = [
  { id: 'me', username: 'me', display_name: 'Me', is_local: true },
  { id: 'u2', username: 'alice', display_name: 'Alice', is_local: true },
  { id: 'u3', username: 'bob', display_name: null, is_local: false, handle: '@bob@remote.test' },
]

async function mountModal() {
  const wrapper = mount(GroupSettingsModal, {
    props: {
      show: true,
      conversation: { id: 'c1', name: 'Crew', created_by: 'me', icon_url: 'icon.png' } as any,
      conversationId: 'c1',
      participants: participants as any,
    },
  })
  await flushPromises()
  return wrapper
}

const ENGLISH = [
  'Group settings', 'Group icon', 'Upload new icon', 'Remove custom icon', 'Drag & drop', 'Max 5MB', 'Group name',
  'Leave empty', 'Saving', 'Save changes', 'Participants (', 'Add participant', 'Creator', 'Remove from group',
  'Danger zone', 'Leave group', 'Delete group', 'Are you sure', 'Group Chat',
]

describe('GroupSettingsModal', () => {
  it('renders translated strings only', async () => {
    const wrapper = await mountModal()
    const attrs = wrapper.findAll('[aria-label], [title], [placeholder]').flatMap((el) =>
      ['aria-label', 'title', 'placeholder'].map((name) => el.attributes(name) ?? ''),
    )
    const raw = [wrapper.text(), ...attrs].join('\n')
    // Translation keys (a.b.c) are stripped; what remains is literal text.
    const rendered = raw.replace(/[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+/g, ' ')

    for (const phrase of ENGLISH) expect(rendered).not.toContain(phrase)
    expect(raw).toContain('dm.groupSettings.title')
    expect(raw).toContain('dm.groupSettings.leaveConfirmMessage')
    expect(raw).toContain('dm.groupSettings.participants{"count":3}')
  })

  it('labels the name field and names the icon and participant buttons', async () => {
    const wrapper = await mountModal()

    const input = wrapper.get('input.group-name-input')
    expect(wrapper.get(`label[for="${input.attributes('id')}"]`).text()).toBe('dm.groupSettings.groupName')
    const described = input.attributes('aria-describedby')!.split(' ')
    expect(described).toHaveLength(2)

    expect(wrapper.get('[data-testid="group-icon-upload"]').attributes('aria-label')).toBe('dm.groupSettings.uploadIcon')
    expect(wrapper.get('.remove-btn').attributes('aria-label')).toBe('dm.groupSettings.removeIcon')
    expect(wrapper.get('.add-participant-btn').attributes('aria-label')).toBe('dm.groupSettings.addParticipant')

    const removeButtons = wrapper.findAll('.remove-participant')
    expect(removeButtons.map((b) => b.attributes('aria-label'))).toEqual([
      'dm.groupSettings.removeParticipant{"name":"Alice"}',
      'dm.groupSettings.removeParticipant{"name":"bob"}',
    ])
    expect(wrapper.findAll('ul.participants-list > li')).toHaveLength(3)
  })

  it('names the default group name from participants through i18n', async () => {
    const many = [...participants, ...['c', 'd', 'e'].map((id) => ({ id, username: id, display_name: null, is_local: true }))]
    const wrapper = mount(GroupSettingsModal, {
      props: { show: true, conversation: { id: 'c1', name: '', created_by: 'me' } as any, conversationId: 'c1', participants: many as any },
    })
    await flushPromises()
    expect(wrapper.get('input.group-name-input').attributes('placeholder')).toBe(
      'dm.groupSettings.defaultNameMore{"names":"Alice, bob, c","count":2}',
    )
  })
})
