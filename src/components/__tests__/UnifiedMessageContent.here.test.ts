/**
 * @here renders as a role pill, as @everyone does.
 */
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'en' } }),
}))

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

describe('UnifiedMessageContent @here', () => {
  it('renders the @here part as a role pill', async () => {
    const w = await render([
      { type: 'text', text: 'standup ' },
      { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null },
      { type: 'role_mention', roleId: '00000000-0000-4000-8000-0000000000e0', roleName: 'everyone', roleColor: null },
    ])
    expect(w.findAll('.role-mention').map(p => p.text())).toEqual(['@here', '@everyone'])
  })
})
