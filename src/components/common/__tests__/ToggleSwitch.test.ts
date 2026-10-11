import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import fs from 'node:fs'
import path from 'node:path'
import ToggleSwitch from '../ToggleSwitch.vue'

vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerToggle: () => {} }) }))

const SRC = path.resolve(__dirname, '../../..')

/** <ToggleSwitch ...> opening tags, quote-aware (attribute values contain '>'). */
function toggleTags(source: string): string[] {
  const tags: string[] = []
  let i = source.indexOf('<ToggleSwitch')
  while (i >= 0) {
    let j = i + '<ToggleSwitch'.length
    let quote: string | null = null
    for (; j < source.length; j++) {
      const c = source[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    tags.push(source.slice(i, j + 1))
    i = source.indexOf('<ToggleSwitch', j)
  }
  return tags
}

function vueFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : vueFiles(full)
    return entry.name.endsWith('.vue') ? [full] : []
  })
}

describe('ToggleSwitch', () => {
  it('is a switch button named by its label and reporting its state', async () => {
    const wrapper = mount(ToggleSwitch, { props: { modelValue: false, label: 'Compact mode' } })
    const button = wrapper.get('button')
    expect(button.attributes('role')).toBe('switch')
    expect(button.attributes('aria-checked')).toBe('false')
    expect(button.attributes('aria-label')).toBe('Compact mode')
    await button.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([true])
  })

  it('prefers labelledby over label and wires describedby', () => {
    const wrapper = mount(ToggleSwitch, { props: { modelValue: true, label: 'x', labelledby: 'h-1', describedby: 'd-1' } })
    const button = wrapper.get('button')
    expect(button.attributes('aria-labelledby')).toBe('h-1')
    expect(button.attributes('aria-label')).toBeUndefined()
    expect(button.attributes('aria-describedby')).toBe('d-1')
    expect(button.attributes('aria-checked')).toBe('true')
  })

  it('stays focusable but inert to clicks when disabled', async () => {
    const wrapper = mount(ToggleSwitch, { props: { modelValue: false, label: 'x', disabled: true } })
    const button = wrapper.get('button')
    expect(button.attributes('aria-disabled')).toBe('true')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('every usage in src passes label or labelledby', () => {
    const missing: string[] = []
    for (const file of vueFiles(SRC)) {
      if (file.endsWith(`${path.sep}ToggleSwitch.vue`)) continue
      const source = fs.readFileSync(file, 'utf8')
      for (const tag of toggleTags(source)) {
        if (!/\s:?(label|labelledby)=/.test(tag)) missing.push(`${path.relative(SRC, file)}: ${tag.replace(/\s+/g, ' ').slice(0, 80)}`)
      }
    }
    expect(missing).toEqual([])
  })
})
