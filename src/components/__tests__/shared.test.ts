import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent, h } from 'vue'

vi.mock('@/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }) },
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() }),
  },
}))

const StubComponent = defineComponent({
  name: 'StubComponent',
  props: {
    label: { type: String, default: 'Click me' },
    disabled: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
  },
  emits: ['click'],
  setup(props, { emit }) {
    const onClick = () => {
      if (!props.disabled && !props.loading) {
        emit('click')
      }
    }
    return () =>
      h(
        'button',
        {
          class: { disabled: props.disabled, loading: props.loading },
          disabled: props.disabled || props.loading,
          onClick,
        },
        props.loading ? 'Loading...' : props.label,
      )
  },
})

describe('Shared component patterns', () => {
  it('renders with default props', () => {
    const wrapper = mount(StubComponent)
    expect(wrapper.text()).toBe('Click me')
  })

  it('renders with custom label', () => {
    const wrapper = mount(StubComponent, { props: { label: 'Submit' } })
    expect(wrapper.text()).toBe('Submit')
  })

  it('emits click event', async () => {
    const wrapper = mount(StubComponent)
    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('does not emit click when disabled', async () => {
    const wrapper = mount(StubComponent, { props: { disabled: true } })
    await wrapper.trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('shows loading text when loading', () => {
    const wrapper = mount(StubComponent, { props: { loading: true } })
    expect(wrapper.text()).toBe('Loading...')
  })

  it('disables button when loading', () => {
    const wrapper = mount(StubComponent, { props: { loading: true } })
    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
  })
})

describe('Vue component mounting with Pinia', () => {
  it('can mount a component with Pinia plugin', () => {
    const TestComponent = defineComponent({
      setup() {
        return () => h('div', 'With Pinia')
      },
    })

    const wrapper = mount(TestComponent, {
      global: { plugins: [createPinia()] },
    })
    expect(wrapper.text()).toBe('With Pinia')
  })
})
