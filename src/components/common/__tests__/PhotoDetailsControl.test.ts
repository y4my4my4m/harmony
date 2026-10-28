import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PhotoDetailsControl from '../PhotoDetailsControl.vue'

const mountControl = (props: InstanceType<typeof PhotoDetailsControl>['$props']) => mount(PhotoDetailsControl, { props })

describe('PhotoDetailsControl', () => {
  it('renders nothing for a file without metadata, or before it is read', () => {
    expect(mountControl({ details: null, keep: false }).html()).toBe('<!--v-if-->')
    expect(mountControl({ details: { location: false, details: false }, keep: false }).html()).toBe('<!--v-if-->')
  })

  it('says the location is removed while the checkbox is off', () => {
    const wrapper = mountControl({ details: { location: true, details: true }, keep: false, describedby: 'name-1' })
    const chip = wrapper.get('[data-testid="photo-location-chip"]')
    expect(chip.text()).toBe('photoDetails.locationRemoved')
    const box = wrapper.get<HTMLInputElement>('[data-testid="keep-photo-details"]')
    expect(box.element.type).toBe('checkbox')
    expect(box.element.checked).toBe(false)
    // Labelled by its visible text; described by the file name and the chip.
    expect(box.element.closest('label')!.textContent!.trim()).toBe('photoDetails.keep')
    expect(box.attributes('aria-describedby')).toBe(`name-1 ${chip.attributes('id')}`)
  })

  it('says the location is included while the checkbox is on', () => {
    const wrapper = mountControl({ details: { location: true, details: true }, keep: true })
    expect(wrapper.get('[data-testid="photo-location-chip"]').text()).toBe('photoDetails.locationKept')
    expect(wrapper.get<HTMLInputElement>('[data-testid="keep-photo-details"]').element.checked).toBe(true)
  })

  it('shows no chip for a file with details but no location', () => {
    const wrapper = mountControl({ details: { location: false, details: true }, keep: false })
    expect(wrapper.find('[data-testid="photo-location-chip"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="keep-photo-details"]').exists()).toBe(true)
  })

  it('emits the new choice', async () => {
    const wrapper = mountControl({ details: { location: true, details: true }, keep: false })
    await wrapper.get('[data-testid="keep-photo-details"]').setValue(true)
    expect(wrapper.emitted('update:keep')).toEqual([[true]])
  })
})
