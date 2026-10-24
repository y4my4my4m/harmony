/**
 * "On {instance}" for a server hosted elsewhere: scope named first, then the block with its
 * consequences and the counts of people from here it removes (the blocking staff member named
 * when among them), media hiding, and the people from here with Remove and Let back in.
 * Instance staff only; a moderator removes no instance staff.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'

const h = vi.hoisted(() => ({
  // A key, its parameters and the plural count, so a test reads which message and values were shown.
  t: (key: string, params?: Record<string, unknown>, plural?: number) =>
    `${key}${params ? ` ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}${plural !== undefined ? ` #${plural}` : ''}`,
  profile: { id: 'me', is_admin: true, is_moderator: false } as Record<string, unknown> | null,
  getRemoteServer: vi.fn(),
  getRemoteServerPeople: vi.fn(),
  setServerBlocked: vi.fn(),
  setServerMediaHidden: vi.fn(),
  removeMemberHere: vi.fn(),
  liftKeepout: vi.fn(),
  setServerMediaHiddenLocally: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: h.t, locale: ref('en') }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => h.toast }))
vi.mock('@/services/instanceConfig', () => ({ getInstanceDomain: () => 'harmony.test' }))
// DisplayName resolves emoji through the user cache; here a name is its text.
vi.mock('@/components/DisplayName.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['userId', 'fallback', 'truncate'], setup: (props) => () => h('span', props.fallback) }) }
})
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: h.profile }) }))
vi.mock('@/services/instanceServerTools', () => ({
  getRemoteServer: h.getRemoteServer,
  getRemoteServerPeople: h.getRemoteServerPeople,
  setServerBlocked: h.setServerBlocked,
  setServerMediaHidden: h.setServerMediaHidden,
  removeMemberHere: h.removeMemberHere,
  liftKeepout: h.liftKeepout,
}))
vi.mock('@/composables/useInstanceMediaHidden', () => ({ setServerMediaHiddenLocally: h.setServerMediaHiddenLocally }))
vi.mock('@/components/common/BaseModal.vue', async () => {
  const { defineComponent, h: render } = await import('vue')
  return {
    default: defineComponent({
      name: 'BaseModal',
      props: { show: Boolean, title: String },
      setup: (props, { slots }) => () => props.show
        ? render('div', { class: 'modal-stub' }, [render('h2', props.title), slots.default?.(), slots.footer?.()])
        : null,
    }),
  }
})

import InstanceServerPanel from '../InstanceServerPanel.vue'

enableAutoUnmount(afterEach)

const SERVER = 'c0000000-0000-4000-8000-000000000001'
const state = (extra: Record<string, unknown> = {}) => ({
  server_id: SERVER, name: 'Elsewhere', icon: null, host: 'remote.example', ap_id: `https://remote.example/servers/${SERVER}`,
  local_members: 3, blocked: false, media_hidden: false, reason: null, set_by: null, set_at: null, kept_out: 1, ...extra,
})
const person = (id: string, username: string, standing: string, extra: Record<string, unknown> = {}) =>
  ({ profile_id: id, username, display_name: null, avatar_url: null, standing, reason: null, set_at: null, is_instance_staff: false, ...extra })

async function mountPanel() {
  const wrapper = mount(InstanceServerPanel, {
    props: { serverId: SERVER },
    global: { stubs: { Icon: true, Avatar: true } },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  h.profile = { id: 'me', is_admin: true, is_moderator: false }
  for (const fn of [h.getRemoteServer, h.getRemoteServerPeople, h.setServerBlocked, h.setServerMediaHidden,
    h.removeMemberHere, h.liftKeepout, h.setServerMediaHiddenLocally, h.toast.success, h.toast.error]) fn.mockReset()
  h.getRemoteServer.mockResolvedValue(state())
  h.getRemoteServerPeople.mockResolvedValue([
    person('me', 'me', 'accepted'),
    person('u-bob', 'bob', 'accepted'),
    person('u-pat', 'pat', 'pending'),
    person('u-eve', 'eve', 'kept_out', { reason: 'spam' }),
  ])
})

describe('InstanceServerPanel', () => {
  it('names its scope: this instance only, not the server or its other members', async () => {
    const w = await mountPanel()
    expect(w.get('h2').text()).toBe('instanceServer.panel.title instance=harmony.test')
    expect(w.get('.settings-description').text()).toBe('instanceServer.panel.intro instance=harmony.test server=Elsewhere')
    expect(w.get('.hosted-on').text()).toBe('instanceServer.panel.hostedOn host=remote.example')
  })

  it('shows nothing but a notice to someone who is not instance staff, and reads nothing', async () => {
    h.profile = { id: 'me', is_admin: false, is_moderator: false }
    const w = await mountPanel()
    expect(w.text()).toContain('instanceServer.panel.staffOnly instance=harmony.test')
    expect(h.getRemoteServer).not.toHaveBeenCalled()
    expect(w.find('[data-testid="instance-block"]').exists()).toBe(false)
  })

  it('lists the consequences with the people from here it removes, the viewer among them, before blocking', async () => {
    const w = await mountPanel()
    const block = w.get('[data-testid="instance-block"]')
    expect(block.text()).toBe('instanceServer.block.action server=Elsewhere instance=harmony.test')
    await block.trigger('click')

    const dialog = w.get('[data-testid="instance-block-dialog"]')
    expect(dialog.findAll('li').map((li) => li.text())).toEqual([
      'instanceServer.block.consequenceSee instance=harmony.test',
      'instanceServer.block.consequenceMembers count=2 instance=harmony.test #2',
      'instanceServer.block.consequenceWaiting count=1 instance=harmony.test #1',
      'instanceServer.block.consequenceYou server=Elsewhere',
      'instanceServer.block.consequenceElsewhere server=Elsewhere',
    ])

    h.setServerBlocked.mockResolvedValue({ blocked: true, members_removed: 3 })
    h.getRemoteServer.mockResolvedValue(state({ blocked: true, local_members: 0, reason: 'raids' }))
    await w.get('[data-testid="instance-block-reason"]').setValue('raids')
    await w.get('[data-testid="instance-block-confirm"]').trigger('click')
    await flushPromises()

    expect(h.setServerBlocked).toHaveBeenCalledWith(SERVER, true, 'raids')
    expect(w.get('[data-testid="instance-blocked-badge"]').text()).toBe('instanceServer.block.blockedStatus instance=harmony.test')
    expect(w.get('[data-testid="instance-unblock"]').text()).toBe('instanceServer.block.unblock server=Elsewhere instance=harmony.test')
    expect(w.text()).toContain('raids')
  })

  it('names neither join requests nor the viewer when there are none', async () => {
    h.getRemoteServerPeople.mockResolvedValue([person('u-bob', 'bob', 'accepted'), person('u-eve', 'eve', 'kept_out')])
    const w = await mountPanel()
    await w.get('[data-testid="instance-block"]').trigger('click')
    expect(w.get('[data-testid="instance-block-dialog"]').findAll('li').map((li) => li.text())).toEqual([
      'instanceServer.block.consequenceSee instance=harmony.test',
      'instanceServer.block.consequenceMembers count=1 instance=harmony.test #1',
      'instanceServer.block.consequenceElsewhere server=Elsewhere',
    ])
  })

  it('allows a blocked server again', async () => {
    h.getRemoteServer.mockResolvedValue(state({ blocked: true, local_members: 0 }))
    h.setServerBlocked.mockResolvedValue({ blocked: false, members_removed: 0 })
    const w = await mountPanel()
    h.getRemoteServer.mockResolvedValue(state({ local_members: 0 }))
    await w.get('[data-testid="instance-unblock"]').trigger('click')
    await flushPromises()
    expect(h.setServerBlocked).toHaveBeenCalledWith(SERVER, false)
    expect(w.find('[data-testid="instance-block"]').exists()).toBe(true)
  })

  it('hides the server\'s media on this instance, with the hint saying who sees it hidden', async () => {
    h.setServerMediaHidden.mockResolvedValue(true)
    const w = await mountPanel()
    expect(w.get('[data-testid="instance-media"]').text()).toContain('instanceServer.media.hint instance=harmony.test')
    const toggle = w.get('[data-testid="instance-media-toggle"]')
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    await flushPromises()
    expect(h.setServerMediaHidden).toHaveBeenCalledWith(SERVER, true)
    expect(h.setServerMediaHiddenLocally).toHaveBeenCalledWith(SERVER, true)
    expect(toggle.attributes('aria-checked')).toBe('true')
  })

  it('offers Remove for each member from here but the viewer, and Let back in for a kept-out one', async () => {
    const w = await mountPanel()
    const rows = w.findAll('[data-testid="instance-person"]')
    expect(rows.map((r) => r.attributes('data-username'))).toEqual(['me', 'bob', 'pat', 'eve'])
    expect(rows[0].find('[data-testid="instance-remove"]').exists()).toBe(false)
    expect(rows[1].get('[data-testid="instance-remove"]').attributes('aria-label'))
      .toBe('instanceServer.people.removeLabel name=bob server=Elsewhere instance=harmony.test')
    expect(rows[2].text()).toContain('instanceServer.people.pending')
    expect(rows[3].text()).toContain('instanceServer.people.keptOut')
    expect(rows[3].text()).toContain('spam')

    h.liftKeepout.mockResolvedValue(true)
    await rows[3].get('[data-testid="instance-lift"]').trigger('click')
    await flushPromises()
    expect(h.liftKeepout).toHaveBeenCalledWith(SERVER, 'u-eve')
  })

  it('offers a moderator no Remove on instance staff; an admin has it', async () => {
    h.getRemoteServerPeople.mockResolvedValue([
      person('me', 'me', 'accepted'),
      person('u-bob', 'bob', 'accepted'),
      person('u-ada', 'ada', 'accepted', { is_instance_staff: true }),
    ])
    const remove = (w: Awaited<ReturnType<typeof mountPanel>>) => w.findAll('[data-testid="instance-person"]')
      .map((row) => [row.attributes('data-username'), row.find('[data-testid="instance-remove"]').exists()])

    h.profile = { id: 'me', is_admin: false, is_moderator: true }
    expect(remove(await mountPanel())).toEqual([['me', false], ['bob', true], ['ada', false]])

    h.profile = { id: 'me', is_admin: true, is_moderator: false }
    expect(remove(await mountPanel())).toEqual([['me', false], ['bob', true], ['ada', true]])
  })

  it('removes a member after a confirmation that says the server is not told, keeping them out when asked', async () => {
    const w = await mountPanel()
    await w.findAll('[data-testid="instance-remove"]')[0].trigger('click')

    const dialog = w.get('[data-testid="instance-remove-dialog"]')
    expect(w.get('.modal-stub h2').text()).toBe('instanceServer.remove.action server=Elsewhere instance=harmony.test')
    expect(dialog.get('.consequence').text())
      .toBe('instanceServer.remove.confirmText name=bob server=Elsewhere instance=harmony.test')
    expect(dialog.get('.keep-out').text()).toBe('instanceServer.remove.keepOut instance=harmony.test')

    h.removeMemberHere.mockResolvedValue({ removed: true, kept_out: true })
    await w.get('[data-testid="instance-remove-keepout"]').setValue(true)
    await w.get('[data-testid="instance-remove-reason"]').setValue('spam links')
    await w.get('[data-testid="instance-remove-confirm"]').trigger('click')
    await flushPromises()

    expect(h.removeMemberHere).toHaveBeenCalledWith(SERVER, 'u-bob', true, 'spam links')
    expect(h.toast.success).toHaveBeenCalledWith('instanceServer.remove.done name=bob server=Elsewhere instance=harmony.test')
    expect(w.find('[data-testid="instance-remove-dialog"]').exists()).toBe(false)
  })
})
