/**
 * An attached image takes a description: a named button per image opens a dialog
 * whose labelled field has focus; Save hands the text to the composer.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import FilePreview, { type FilePreviewData } from '../FilePreview.vue'

const file = (name: string, type: string, extra: Partial<FilePreviewData> = {}): FilePreviewData => ({
  file: new File(['x'], name, { type }),
  name,
  size: 1,
  type,
  preview: `blob:${name}`,
  uploadStatus: 'uploading',
  uploadProgress: 40,
  ...extra,
})

let wrapper: VueWrapper | null = null
const global = { mocks: { $t: (key: string) => key } }

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('FilePreview image descriptions', () => {
  it('offers a description for images only, named after the file', () => {
    wrapper = mount(FilePreview, { props: { files: [file('a.png', 'image/png'), file('notes.pdf', 'application/pdf')] }, global })
    const buttons = wrapper.findAll('[data-testid="alt-text-button"]')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].attributes('aria-label')).toBe('messageA11y.alt.add')
    // The thumbnail is decorative: the file name is beside it.
    expect(wrapper.get('img.thumbnail-image').attributes('alt')).toBe('')
    const progress = wrapper.get('[role="progressbar"]')
    expect(progress.attributes('aria-valuenow')).toBe('40')
  })

  it('edits the description in a dialog whose field takes focus, and emits it on Save', async () => {
    wrapper = mount(FilePreview, { props: { files: [file('a.png', 'image/png', { altText: 'old' })] }, global, attachTo: document.body })
    expect(wrapper.get('[data-testid="alt-text-button"]').attributes('aria-label')).toBe('messageA11y.alt.edit')
    expect(wrapper.text()).toContain('old')
    await wrapper.get('[data-testid="alt-text-button"]').trigger('click')
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[data-testid="alt-text-dialog"]')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    const field = dialog.querySelector<HTMLTextAreaElement>('textarea')!
    expect(document.activeElement).toBe(field)
    expect(dialog.querySelector(`label[for="${field.id}"]`)?.textContent).toBe('activitypub.altTextLabel')
    expect(field.value).toBe('old')
    field.value = '  A red sunset  '
    field.dispatchEvent(new Event('input'))
    dialog.querySelector<HTMLButtonElement>('[data-testid="alt-text-save"]')!.click()
    await flushPromises()
    expect(wrapper.emitted('update-alt')).toEqual([[0, 'A red sunset']])
    expect(document.querySelector('[data-testid="alt-text-dialog"]')).toBeNull()
  })
})
