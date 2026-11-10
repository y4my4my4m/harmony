import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import MatrixBridgedProfile from '../MatrixBridgedProfile.vue'
import en from '@/locales/en.json'
vi.mock('vue-i18n', async original => ({ ...await original<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string) => key.split('.').reduce((value: any, part) => value?.[part], en) || key }) }))
let wrapper: VueWrapper
beforeEach(() => { wrapper = mount(MatrixBridgedProfile, {
  props: { user: { id: '@sam:example.org', username: 'sam', displayName: '<script>Sam</script>', source: 'matrix', avatarUrl: '' } },
  global: { stubs: { UnifiedModal: { props: ['modelValue', 'title'], template: '<div v-if="modelValue"><h2>{{ title }}</h2><slot /></div>' }, Avatar: true, BridgeSourceBadge: true } },
}) })
afterEach(() => wrapper.unmount())
describe('read-only Matrix member identity', () => {
  it('shows the native MXID and escapes names with no native profile actions', () => {
    expect(wrapper.text()).toContain('@sam:example.org')
    expect(wrapper.text()).toContain('not a Harmony profile')
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.get('a').attributes()).toMatchObject({ href: 'https://matrix.to/#/%40sam%3Aexample.org', target: '_blank', rel: 'noopener noreferrer' })
  })
  it('never builds a link for malformed Matrix identities', async () => {
    await wrapper.setProps({ user: { id: 'javascript:alert(1)', username: 'sam', displayName: 'Sam', source: 'matrix', avatarUrl: '' } })
    expect(wrapper.find('a').exists()).toBe(false)
  })
})
