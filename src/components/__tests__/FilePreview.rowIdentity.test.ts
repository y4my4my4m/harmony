/**
 * Each attachment keeps its row: removing one leaves the others' elements (thumbnail, upload
 * bar, focus) with their own files. A keyboard removal moves focus to the next row's Remove.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import FilePreview, { type FilePreviewData } from '../FilePreview.vue'

const file = (name: string, progress: number): FilePreviewData => ({
  file: new File(['x'], name, { type: 'image/png' }),
  name,
  size: 1,
  type: 'image/png',
  preview: `blob:${name}`,
  uploadStatus: 'uploading',
  uploadProgress: progress,
})

let wrapper: VueWrapper | null = null
const global = { mocks: { $t: (key: string) => key } }

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

/** Mounts the list and applies its remove-file events as the composer does. */
function mountList(files: FilePreviewData[]) {
  const onRemoveFile = (index: number) => {
    void w.setProps({ files: (w.props('files') as FilePreviewData[]).filter((_, i) => i !== index) })
  }
  const w: VueWrapper = mount(FilePreview, { props: { files, onRemoveFile }, global, attachTo: document.body })
  wrapper = w
  return w
}

const rows = (w: VueWrapper) => w.findAll('[data-testid="file-preview-item"]').map((r) => r.element as HTMLElement)

describe('FilePreview rows', () => {
  it('removing the first attachment keeps the second one\'s row element', async () => {
    const a = file('a.png', 80)
    const b = file('b.png', 10)
    wrapper = mount(FilePreview, { props: { files: [a, b] }, global })
    const [, rowB] = rows(wrapper)

    await wrapper.setProps({ files: [b] })

    expect(rows(wrapper)).toHaveLength(1)
    expect(rows(wrapper)[0]).toBe(rowB)
    expect(rowB.querySelector<HTMLElement>('.upload-progress')!.style.width).toBe('10%')
  })

  it('a keyboard removal leaves focus on the next attachment\'s Remove', async () => {
    const w = mountList([file('a.png', 0), file('b.png', 0), file('c.png', 0)])
    const removeA = w.findAll('.remove-file-btn')[0].element as HTMLButtonElement
    removeA.focus()

    removeA.click()
    await flushPromises()

    expect(document.activeElement?.getAttribute('aria-label')).toBe('messageA11y.upload.remove')
    expect(document.activeElement).toBe(w.findAll('.remove-file-btn')[0].element)
    expect(w.findAll('[data-testid="file-preview-item"]')[0].text()).toContain('b.png')
  })

  it('removing the last attachment by keyboard moves focus to the one before it', async () => {
    const w = mountList([file('a.png', 0), file('b.png', 0)])
    const removeB = w.findAll('.remove-file-btn')[1].element as HTMLButtonElement
    removeB.focus()

    removeB.click()
    await flushPromises()

    expect(document.activeElement).toBe(w.findAll('.remove-file-btn')[0].element)
  })
})
