import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@/components/shared/UnifiedModal.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'UnifiedModal',
      props: { title: String, actions: Array },
      setup(props, { slots }) {
        return () => h('div', [
          h('h2', props.title),
          slots.default?.(),
          ...(props.actions as Array<{ key: string; label: string; handler: () => void }>).map((a) =>
            h('button', { 'data-action': a.key, onClick: a.handler }, a.label)),
        ])
      },
    }),
  }
})

import DrivePhotoDetailsDialog from '../DrivePhotoDetailsDialog.vue'

const item = (name: string, location: boolean, keep = false) => ({
  file: new File(['x'], name, { type: 'image/jpeg' }),
  details: { container: 'jpeg' as const, location, details: true },
  keep,
})

describe('DrivePhotoDetailsDialog', () => {
  it('lists each file with its own Keep photo details and location chip', async () => {
    const wrapper = mount(DrivePhotoDetailsDialog, { props: { items: [item('a.jpg', true), item('b.jpg', false, true)] } })
    const rows = wrapper.findAll('li')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('a.jpg')
    expect(rows[0].get('[data-testid="photo-location-chip"]').text()).toBe('photoDetails.locationRemoved')
    expect(rows[1].find('[data-testid="photo-location-chip"]').exists()).toBe(false)
    expect(rows[1].get<HTMLInputElement>('input').element.checked).toBe(true)
    const nameId = rows[0].get('span').attributes('id')
    expect(rows[0].get('input').attributes('aria-describedby')).toContain(nameId)

    await rows[0].get('input').setValue(true)
    expect(wrapper.emitted('set-keep')).toEqual([[0, true]])
    await wrapper.get('[data-action="upload"]').trigger('click')
    await wrapper.get('[data-action="cancel"]').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
