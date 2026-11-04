/**
 * ReplyContextPreview: the parent above a reply's text, per state of the parent.
 */

import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

vi.mock('vue-i18n', () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})` : key
  return { useI18n: () => ({ t }), createI18n: () => ({ install: () => {}, global: { t } }) }
})

import ReplyContextPreview from '../ReplyContextPreview.vue'

const RouterLink = defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: true } },
  setup(props, { slots, attrs }) {
    return () => h('a', { ...attrs, href: `#${JSON.stringify(props.to)}` }, slots.default?.())
  },
})

const author = { id: 'a1', username: 'toonie', display_name: 'Toonie', domain: 'meow.example' }

const render = (context: any, loading = false) =>
  mount(ReplyContextPreview, {
    props: { context, loading, replyId: 'reply-1' },
    global: {
      stubs: {
        RouterLink,
        Avatar: { template: '<img class="avatar-stub" />' },
        DisplayName: { props: ['fallback'], template: '<span class="name-stub">{{ fallback }}</span>' },
        Icon: { props: ['name'], template: '<i :data-icon="name" />' },
      },
    },
  })

describe('ReplyContextPreview', () => {
  it('links to the parent with the reply highlighted, naming author and text', () => {
    const wrapper = render({ id: 'p1', state: 'post', author, content_preview: 'is this the right place?' })
    const link = wrapper.getComponent(RouterLink)
    expect(link.props('to')).toEqual({ name: 'PostDetail', params: { postId: 'p1' }, query: { highlight: 'reply-1' } })
    expect(link.attributes('title')).toBe('activitypub.replyingTo @toonie@meow.example')
    expect(link.attributes('aria-label')).toBeUndefined()
    expect(link.text().replace(/\s+/g, ' ')).toBe('activitypub.replyingTo Toonie is this the right place?')
    expect(wrapper.get('.reply-context-name').text()).toBe('Toonie')
    expect(wrapper.get('.reply-context-snippet').text()).toBe('is this the right place?')
  })

  it('shows the content warning in place of the text', () => {
    const wrapper = render({ id: 'p1', state: 'post', author, content_preview: 'spoiler', content_warning: 'film ending' })
    expect(wrapper.get('.reply-context-snippet').text()).toBe('activitypub.replyContext.contentWarning(text=film ending)')
    expect(wrapper.text()).not.toContain('spoiler')
  })

  it('names the attachments of a parent without text', () => {
    const one = render({ id: 'p1', state: 'post', author, content_preview: '', media_attachments: [{ type: 'video' }] })
    expect(one.get('.reply-context-media').text()).toBe('activitypub.video')
    const many = render({ id: 'p1', state: 'post', author, content_preview: '', media_attachments: [{ type: 'image' }, { type: 'image' }] })
    expect(many.get('.reply-context-media').text()).toBe('activitypub.replyContext.attachments(count=2)')
  })

  it.each([
    ['deleted', { id: 'p1', state: 'deleted' }, 'activitypub.replyContext.deleted'],
    ['hidden', { id: 'p1', state: 'hidden' }, 'activitypub.replyContext.hidden'],
  ])('is one unlinked line for a %s parent, naming no author', (_state, context, text) => {
    const wrapper = render(context)
    expect(wrapper.findComponent(RouterLink).exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).toBe(text)
  })

  it('links a remote parent that is not stored to its origin', () => {
    const url = 'https://meow.example/users/toonie/statuses/1'
    const wrapper = render({ id: null, state: 'remote', url })
    const link = wrapper.get('a')
    expect(link.attributes('href')).toBe(url)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.text()).toBe('activitypub.replyContext.remote(domain=meow.example)')
  })

  it('holds a line while the parent is read', () => {
    const wrapper = render(null, true)
    expect(wrapper.get('[data-testid="post-reply-context"]').attributes('data-state')).toBe('loading')
    expect(render(null, false).html()).toBe('<!--v-if-->')
  })
})
