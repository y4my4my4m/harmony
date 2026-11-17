/**
 * DiscoveryControls.vue, the collapsible controls of Discover communities, and This instance's
 * use of it (PublicServersSearch.vue): the toggle states aria-expanded and opens on the search
 * field; folded, every active filter stays on screen and is removable; a list scroll folds open
 * controls except while their field is typed in, moving focus out of the hidden panel.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { defineComponent, h, ref } from 'vue'
import en from '@/locales/en.json'
import DiscoveryControls from '../DiscoveryControls.vue'
import PublicServersSearch from '../PublicServersSearch.vue'

const i18n = () => createI18n({ legacy: false, locale: 'en', messages: { en } })
const mounted: VueWrapper[] = []

afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
})

function renderControls() {
  const expanded = ref(false)
  const filters = ref([{ key: 'category', label: 'Music', icon: 'music' }])
  const removed: string[] = []
  const Host = defineComponent({
    setup: () => () => h(DiscoveryControls, {
      ref: 'controls',
      expanded: expanded.value,
      filters: filters.value,
      count: '3 of 33 communities',
      countTestId: 'count',
      'onUpdate:expanded': (value: boolean) => { expanded.value = value },
      onRemove: (key: string) => {
        removed.push(key)
        filters.value = filters.value.filter((f) => f.key !== key)
      },
    }, () => [h('input', { 'data-testid': 'field' }), h('button', { 'data-testid': 'chip' }, 'Gaming')]),
  })
  const wrapper = mount(Host, { global: { plugins: [i18n()] }, attachTo: document.body })
  mounted.push(wrapper)
  const controls = () => wrapper.findComponent(DiscoveryControls).vm as unknown as { listScrolled(top: number): void }
  return { wrapper, expanded, removed, controls }
}

const toggle = (w: VueWrapper) => w.get('[data-testid="discovery-controls-toggle"]')
const panel = (w: VueWrapper) => w.get('[data-testid="discovery-controls-panel"]')

describe('DiscoveryControls', () => {
  it('starts folded with the count and active filters shown, and opens on its field', async () => {
    const { wrapper, expanded } = renderControls()
    expect(toggle(wrapper).attributes('aria-expanded')).toBe('false')
    expect(toggle(wrapper).attributes('aria-controls')).toBe(panel(wrapper).attributes('id'))
    expect(panel(wrapper).isVisible()).toBe(false)
    expect(wrapper.get('[data-testid="count"]').text()).toBe('3 of 33 communities')
    const chip = wrapper.get('[data-testid="discovery-filter-chip"]')
    expect(chip.text()).toBe('Remove filter Music')

    await toggle(wrapper).trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(expanded.value).toBe(true)
    expect(toggle(wrapper).attributes('aria-expanded')).toBe('true')
    expect(panel(wrapper).isVisible()).toBe(true)
    expect(document.activeElement).toBe(wrapper.get('[data-testid="field"]').element)
    // Open controls show the filters themselves.
    expect(wrapper.find('[data-testid="discovery-filter-chip"]').exists()).toBe(false)

    await toggle(wrapper).trigger('click')
    expect(expanded.value).toBe(false)
  })

  it('removes a filter from its chip and moves focus to the toggle once none remain', async () => {
    const { wrapper, removed } = renderControls()
    await wrapper.get('[data-testid="discovery-filter-chip"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(removed).toEqual(['category'])
    expect(document.activeElement).toBe(toggle(wrapper).element)
  })

  it('folds once the list scrolls past the open controls, focus moving from the panel to the toggle', async () => {
    const { wrapper, expanded, controls } = renderControls()
    controls().listScrolled(300)
    await toggle(wrapper).trigger('click')
    await wrapper.vm.$nextTick()
    ;(wrapper.get('[data-testid="chip"]').element as HTMLButtonElement).focus()

    controls().listScrolled(340)
    expect(expanded.value).toBe(true)
    controls().listScrolled(300 + 64)
    expect(expanded.value).toBe(false)
    expect(document.activeElement).toBe(toggle(wrapper).element)
  })

  it('stays open while its field has focus', async () => {
    const { wrapper, expanded, controls } = renderControls()
    await toggle(wrapper).trigger('click')
    await wrapper.vm.$nextTick()
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="field"]').element)
    controls().listScrolled(2000)
    expect(expanded.value).toBe(true)
  })
})

describe('PublicServersSearch, This instance', () => {
  function render(props: Partial<InstanceType<typeof PublicServersSearch>['$props']> = {}) {
    const wrapper = mount(PublicServersSearch, {
      props: {
        searchQuery: '', selectedCategory: null, expanded: false, isSearching: false, hasActiveFilter: false,
        categories: ['gaming', 'music'], totalServers: 33, filteredCount: 33, ...props,
      },
      global: { plugins: [i18n()] },
    })
    mounted.push(wrapper)
    return wrapper
  }

  it('shows no filter chip and the total with nothing filtered', () => {
    const wrapper = render()
    expect(wrapper.find('[data-testid="discovery-filter-chip"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="discovery-local-stats"]').text()).toBe('33 communities found')
  })

  it('keeps the category and the search text on screen while folded; each chip clears its own', async () => {
    const wrapper = render({ searchQuery: 'synth', selectedCategory: 'music', hasActiveFilter: true, filteredCount: 2 })
    const chips = wrapper.findAll('[data-testid="discovery-filter-chip"]')
    expect(chips.map((c) => c.text())).toEqual(['Remove filter Music', 'Remove filter “synth”'])
    expect(wrapper.get('[data-testid="discovery-local-stats"]').text()).toBe('2 of 33 communities')

    await chips[0].trigger('click')
    expect(wrapper.emitted('update:selectedCategory')).toEqual([[null]])
    await chips[1].trigger('click')
    expect(wrapper.emitted('update:searchQuery')).toEqual([['']])
  })

  it('labels the search field visibly', () => {
    const wrapper = render({ expanded: true })
    const label = wrapper.get('label.search-label')
    expect(label.text()).toBe('Search communities')
    expect(wrapper.get(`#${label.attributes('for')}`).element.tagName).toBe('INPUT')
  })
})
