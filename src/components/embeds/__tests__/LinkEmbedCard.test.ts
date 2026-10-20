/**
 * Component test for `LinkEmbedCard.vue`.
 *
 * Verifies the variant prop is honoured (the `--thumbnail` modifier class
 * shows up so the matching CSS rules in `embed-previews.css` apply), and
 * that the thumbnail variant still renders the preview image. The CSS
 * deltas themselves (border, hover, image sizes) are visual - happy-dom
 * doesn't evaluate `@media` queries - so the test stops at the structural
 * contract the CSS depends on.
 */

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LinkEmbedCard from '../LinkEmbedCard.vue'

const basePayload = {
  cacheKey: 'ars',
  url: 'https://arstechnica.com/security/foo',
  normalizedUrl: 'https://arstechnica.com/security/foo',
  provider: 'generic' as const,
  title: 'A security headline',
  description: 'An article about security',
  siteName: 'Ars Technica',
  image: 'https://arstechnica.com/preview.jpg',
  fetchedAt: '2026-05-28T00:00:00Z',
  expiresAt: '2026-05-29T00:00:00Z',
}

describe('LinkEmbedCard', () => {
  it('applies the --thumbnail modifier class when variant="thumbnail"', () => {
    const wrapper = mount(LinkEmbedCard, {
      props: { payload: basePayload, variant: 'thumbnail' },
    })

    const card = wrapper.find('.link-embed-card')
    expect(card.exists()).toBe(true)
    expect(card.classes()).toContain('link-embed-card--thumbnail')
    expect(card.classes()).not.toContain('link-embed-card--compact')
  })

  it('still renders the preview image inside the thumbnail variant', () => {
    const wrapper = mount(LinkEmbedCard, {
      props: { payload: basePayload, variant: 'thumbnail' },
    })

    // The media slot is the small square preview; assert it's present so
    // the CSS sizing rules (`.link-embed-card__media`) have a target.
    const media = wrapper.find('.link-embed-card__media')
    expect(media.exists()).toBe(true)

    const img = media.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(basePayload.image)
    // Beside the title it repeats, the thumbnail is decorative.
    expect(img.attributes('alt')).toBe('')
  })

  it('renders title + description text in the body', () => {
    const wrapper = mount(LinkEmbedCard, {
      props: { payload: basePayload, variant: 'thumbnail' },
    })

    expect(wrapper.find('.link-embed-card__title').text()).toBe(basePayload.title)
    expect(wrapper.find('.link-embed-card__description').text()).toBe(basePayload.description)
  })

  it('falls back to the URL hostname when siteName is missing', () => {
    const wrapper = mount(LinkEmbedCard, {
      props: {
        payload: { ...basePayload, siteName: undefined },
        variant: 'thumbnail',
      },
    })

    expect(wrapper.find('.link-embed-card__site').text()).toBe('arstechnica.com')
  })

  it('defaults to the full-card variant when no variant prop is given', () => {
    const wrapper = mount(LinkEmbedCard, { props: { payload: basePayload } })

    const card = wrapper.find('.link-embed-card')
    expect(card.classes()).not.toContain('link-embed-card--thumbnail')
    expect(card.classes()).not.toContain('link-embed-card--compact')
    expect(card.classes()).toContain('link-embed-card--has-image')
  })

  it('omits the description element when the payload has no description', () => {
    // Constant card height with no description is enforced by CSS
    // (`min-height: 1em`). At the DOM level the `v-if`-skipped <p> is absent.
    const wrapper = mount(LinkEmbedCard, {
      props: {
        payload: { ...basePayload, description: undefined },
        variant: 'thumbnail',
      },
    })

    expect(wrapper.find('.link-embed-card__description').exists()).toBe(false)
    expect(wrapper.find('.link-embed-card__title').text()).toBe(basePayload.title)
  })
  it("puts the site's icon in place of an image that does not load, and the link glyph when the icon fails too", async () => {
    const icon = 'https://github.githubassets.com/favicons/favicon.svg'
    const wrapper = mount(LinkEmbedCard, { props: { payload: { ...basePayload, icon } } })
    expect(wrapper.find('[data-testid="link-embed-placeholder"]').exists()).toBe(false)

    await wrapper.find('.link-embed-card__media img').trigger('error')
    expect(wrapper.emitted('load')).toHaveLength(1)
    const tile = wrapper.find('[data-testid="link-embed-placeholder"]')
    expect(tile.exists()).toBe(true)
    expect(tile.find('img').attributes('src')).toBe(icon)
    // The card keeps its thumbnail column.
    expect(wrapper.find('.link-embed-card').classes()).toContain('link-embed-card--has-image')

    await tile.find('img').trigger('error')
    expect(wrapper.find('[data-testid="link-embed-placeholder"] img').exists()).toBe(false)
    expect(wrapper.find('[data-testid="link-embed-placeholder"] svg').exists()).toBe(true)
    expect(wrapper.find('.link-embed-card__icon').exists()).toBe(false)
  })

  it('a media card whose image fails becomes a card with the stand-in', async () => {
    const wrapper = mount(LinkEmbedCard, { props: { payload: { ...basePayload, description: undefined } } })
    expect(wrapper.find('.link-embed-card').classes()).toContain('link-embed-card--media')
    expect(wrapper.find('.link-embed-card__media img').attributes('alt')).toBe(basePayload.title)
    await wrapper.find('.link-embed-card__media img').trigger('error')
    expect(wrapper.find('.link-embed-card').classes()).not.toContain('link-embed-card--media')
    expect(wrapper.find('[data-testid="link-embed-placeholder"]').exists()).toBe(true)
  })
})
