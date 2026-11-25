/**
 * A role menu message renders its card alone; the text part naming the roles is for text-only
 * readers.
 */
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

const MENU = { type: 'role_menu', serverId: 's1', group: 'Colours', title: 'Pick a colour' }

async function render(content: unknown[]) {
  setActivePinia(createPinia())
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } })
  const { default: UnifiedMessageContent } = await import('@/components/UnifiedMessageContent.vue')
  const wrapper = shallowMount(UnifiedMessageContent, {
    props: { content, messageId: 'm1', editableContent: '' },
    global: { mocks: { $t: (key: string) => key } },
  })
  await flushPromises()
  return wrapper
}

describe('UnifiedMessageContent role menus', () => {
  it('renders the role menu card and hides the text naming the roles', async () => {
    const w = await render([MENU, { type: 'text', text: 'Pick a colour: Red · Blue' }])
    const card = w.findComponent({ name: 'RoleMenuCard' })
    expect(card.exists()).toBe(true)
    expect(card.props('menu')).toEqual(MENU)
    expect(w.text()).not.toContain('Red · Blue')
  })

  it('drops a blank group and title from the part it hands the card', async () => {
    const w = await render([{ type: 'role_menu', serverId: 's1', group: '  ', title: '' }])
    expect(w.findComponent({ name: 'RoleMenuCard' }).props('menu')).toEqual({ type: 'role_menu', serverId: 's1', group: null })
  })

  it('renders a role_menu part without a server id as nothing special', async () => {
    const w = await render([{ type: 'role_menu' }, { type: 'text', text: 'plain' }])
    expect(w.findComponent({ name: 'RoleMenuCard' }).exists()).toBe(false)
    expect(w.text()).toContain('plain')
  })
})
