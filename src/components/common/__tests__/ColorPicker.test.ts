/**
 * ColorPicker: the saturation/brightness field and the hue track are keyboard
 * sliders, the swatches a radio group, the hex field a labelled input. Keyboard
 * changes emit update:color and change exactly like pointer drags.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en.json'
import ColorPicker from '../ColorPicker.vue'

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })

let wrapper: VueWrapper | null = null

function mountPicker(props: Record<string, unknown> = {}) {
  wrapper = mount(ColorPicker, {
    props: { color: '#ff0000', ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('ColorPicker', () => {
  it('names the picker group from the label prop, with a default', () => {
    expect(mountPicker({ label: 'Role color' }).get('.color-picker').attributes()).toMatchObject({
      role: 'group',
      'aria-label': 'Role color',
    })
    wrapper!.unmount()
    expect(mountPicker().get('.color-picker').attributes('aria-label')).toBe('Color picker')
  })

  it('saturation/brightness field is a slider: arrows adjust, Shift steps by 10, emits', async () => {
    const w = mountPicker()
    const sv = w.get('[data-testid="color-sv"]')
    expect(sv.attributes()).toMatchObject({
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Saturation and brightness',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '100',
      'aria-valuetext': 'Saturation 100%, brightness 100%',
    })
    const help = document.getElementById(sv.attributes('aria-describedby')!)
    expect(help?.textContent).toMatch(/Left and Right arrows change saturation/)

    await sv.trigger('keydown', { key: 'ArrowLeft' })
    expect(sv.attributes('aria-valuenow')).toBe('99')
    expect(sv.attributes('aria-valuetext')).toBe('Saturation 99%, brightness 100%')
    await sv.trigger('keydown', { key: 'ArrowDown', shiftKey: true })
    expect(sv.attributes('aria-valuetext')).toBe('Saturation 99%, brightness 90%')

    const updates = w.emitted('update:color')!
    const changes = w.emitted('change')!
    expect(updates).toHaveLength(2)
    expect(changes).toHaveLength(2)
    expect(updates[0][0]).toBe('#ff0303')
    expect(changes[1][0]).toBe(updates[1][0])

    await sv.trigger('keydown', { key: 'Home' })
    expect(sv.attributes('aria-valuetext')).toBe('Saturation 0%, brightness 90%')
    await sv.trigger('keydown', { key: 'Tab' })
    expect(w.emitted('update:color')).toHaveLength(3)
  })

  it('hue track is a slider in degrees: arrows, PageUp, Home and End', async () => {
    const w = mountPicker()
    const hue = w.get('[data-testid="color-hue"]')
    expect(hue.attributes()).toMatchObject({
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Hue',
      'aria-valuemin': '0',
      'aria-valuemax': '360',
      'aria-valuenow': '0',
      'aria-valuetext': '0 degrees',
    })
    await hue.trigger('keydown', { key: 'ArrowRight' })
    expect(hue.attributes('aria-valuetext')).toBe('1 degree')
    await hue.trigger('keydown', { key: 'PageUp' })
    expect(hue.attributes('aria-valuenow')).toBe('11')
    await hue.trigger('keydown', { key: 'End' })
    expect(hue.attributes('aria-valuenow')).toBe('360')
    await hue.trigger('keydown', { key: 'Home' })
    expect(hue.attributes('aria-valuenow')).toBe('0')
    expect(w.emitted('update:color')).toHaveLength(4)
    expect(w.emitted('update:color')![0][0]).toBe('#ff0400')
  })

  it('swatches form a named radio group with one Tab stop on the checked colour', () => {
    const w = mountPicker({ color: '#3498db' })
    const group = w.get('[role="radiogroup"]')
    expect(group.attributes('aria-label')).toBe('Preset colors')
    const radios = w.findAll('[role="radio"]')
    expect(radios.length).toBe(16)
    const checked = radios.filter((r) => r.attributes('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0].attributes('aria-label')).toBe('Blue #3498DB')
    expect(checked[0].attributes('tabindex')).toBe('0')
    expect(radios.filter((r) => r.attributes('tabindex') === '0')).toHaveLength(1)
    expect(radios[0].attributes('aria-label')).toBe('Blue #0EA5E9')
    expect(radios[14].attributes('aria-label')).toBe('White #FFFFFF')
  })

  it('arrow keys in the swatch group move focus and select the colour', async () => {
    const w = mountPicker({ color: '#0EA5E9' })
    const radios = w.findAll('[role="radio"]')
    ;(radios[0].element as HTMLElement).focus()
    await radios[0].trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(radios[1].element)
    expect(w.emitted('update:color')!.at(-1)![0]).toBe('#57f287')
    expect(w.emitted('change')!.at(-1)![0]).toBe('#57f287')
    expect(radios[1].attributes('aria-checked')).toBe('true')
    expect(radios[1].attributes('tabindex')).toBe('0')
    expect(radios[0].attributes('aria-checked')).toBe('false')
    expect(radios[0].attributes('tabindex')).toBe('-1')

    await radios[1].trigger('keydown', { key: 'ArrowLeft' })
    await radios[0].trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(radios[15].element)
    expect(w.emitted('update:color')!.at(-1)![0]).toBe('#000000')
  })

  it('hex field has a real label', async () => {
    const w = mountPicker()
    const input = w.get('[data-testid="color-hex"]')
    const id = input.attributes('id')!
    const label = w.get(`label[for="${id}"]`)
    expect(label.text()).toBe('Hex color')
    await input.setValue('#00ff00')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('update:color')!.at(-1)![0]).toBe('#00ff00')
  })

  it('a colour pushed by the parent moves the checked swatch and its Tab stop', async () => {
    const w = mountPicker({ color: '#0EA5E9' })
    await w.setProps({ color: '#ffffff' })
    const radios = w.findAll('[role="radio"]')
    expect(radios[14].attributes('aria-checked')).toBe('true')
    expect(radios[14].attributes('tabindex')).toBe('0')
    expect(radios[0].attributes('tabindex')).toBe('-1')
    expect(w.emitted('update:color')).toBeUndefined()
  })
})
