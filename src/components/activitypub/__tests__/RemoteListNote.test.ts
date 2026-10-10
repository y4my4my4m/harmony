/**
 * The Following and Followers tabs of a remote account list the accounts this instance
 * knows; RemoteListNote says so and links to the account on its own server.
 */

import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }),
}))

import RemoteListNote from '../RemoteListNote.vue'

describe('RemoteListNote', () => {
  it('states the list is partial and links to the original profile', () => {
    const wrapper = mount(RemoteListNote, {
      props: { domain: 'mastodon.nzoss.nz', profileUrl: 'https://mastodon.nzoss.nz/@strypey' },
    })
    expect(wrapper.text()).toContain('activitypub.remoteListNote')
    const link = wrapper.get('[data-testid="remote-list-link"]')
    expect(link.attributes('href')).toBe('https://mastodon.nzoss.nz/@strypey')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
    expect(link.text()).toContain('"domain":"mastodon.nzoss.nz"')
  })

  it('omits the link without a profile URL and refuses a script URL', () => {
    expect(mount(RemoteListNote, { props: { domain: 'x.test' } }).find('[data-testid="remote-list-link"]').exists()).toBe(false)
    const unsafe = mount(RemoteListNote, { props: { domain: 'x.test', profileUrl: 'javascript:alert(1)' } })
    expect(unsafe.get('[data-testid="remote-list-link"]').attributes('href') ?? '').not.toContain('javascript')
  })
})
