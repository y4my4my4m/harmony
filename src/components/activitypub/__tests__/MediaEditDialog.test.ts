/**
 * Composer media editing: MediaEditDialog crops with aspect presets, sets the
 * focal point and holds the single alt text field; MonyMediaUpload opens it
 * from Edit and ALT and reports the result per attachment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'

const { inspectImageFile, loadCropSource, exportCrop, renderCropPreview } = vi.hoisted(() => ({
  inspectImageFile: vi.fn(),
  loadCropSource: vi.fn(),
  exportCrop: vi.fn(),
  renderCropPreview: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/utils/imageCrop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/imageCrop')>()),
  inspectImageFile,
  loadCropSource,
  exportCrop,
  renderCropPreview,
}))

import MediaEditDialog from '../MediaEditDialog.vue'
import MonyMediaUpload from '../MonyMediaUpload.vue'

const original = new File(['pixels'], 'IMG_1.jpg', { type: 'image/jpeg' })
const cropped = new File(['cropped'], 'IMG_1.webp', { type: 'image/webp' })

const body = () => new DOMWrapper(document.body)

function imageAttachment(extra: Record<string, unknown> = {}) {
  return { type: 'image' as const, url: 'blob:original', preview_url: 'blob:original', file: original, ...extra }
}

function mountDialog(attachment: Record<string, unknown>, initialFocus?: 'crop' | 'focus' | 'alt') {
  return mount(MediaEditDialog, {
    props: { attachment: attachment as any, ...(initialFocus ? { initialFocus } : {}) },
    attachTo: document.body,
  })
}

describe('MediaEditDialog', () => {
  beforeEach(() => {
    inspectImageFile.mockResolvedValue({ format: 'jpeg', animated: false })
    loadCropSource.mockImplementation(async () => ({ image: {}, preview: {}, width: 1600, height: 1200, format: 'jpeg', close: vi.fn() }))
    exportCrop.mockResolvedValue(cropped)
    renderCropPreview.mockResolvedValue(new Blob(['p'], { type: 'image/webp' }))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('saves alt text and focal point without re-encoding an uncropped image', async () => {
    const wrapper = mountDialog(imageAttachment())
    await flushPromises()

    await body().get('[data-testid="media-edit-tab-focus"]').trigger('click')
    await flushPromises()
    expect(renderCropPreview).toHaveBeenCalledTimes(1)
    const stage = body().get('[data-testid="focal-stage"]')
    await stage.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    await stage.trigger('keydown', { key: 'ArrowUp' })
    await body().get('[data-testid="media-alt-input"]').setValue('  A heron on a post  ')
    await body().get('[data-testid="media-edit-save"]').trigger('click')
    await flushPromises()

    expect(exportCrop).not.toHaveBeenCalled()
    expect(wrapper.emitted('save')?.[0]).toEqual([{ description: 'A heron on a post', focus: { x: 0.2, y: 0.05 }, crop: null }])
    wrapper.unmount()
  })

  it('crops to a preset aspect at source resolution and keeps the original for later edits', async () => {
    const wrapper = mountDialog(imageAttachment())
    await flushPromises()

    await body().get('[data-testid="media-aspect-square"]').setValue(true)
    await body().get('[data-testid="media-edit-save"]').trigger('click')
    await flushPromises()

    const [, state, aspect, target, name] = exportCrop.mock.calls[0]
    expect(aspect).toBe(1)
    expect(target).toBeNull()
    expect(name).toBe('IMG_1.jpg')
    expect(state).toMatchObject({ rotation: 0, zoom: 1, cx: 800, cy: 600 })
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({
      file: cropped,
      originalFile: original,
      crop: { aspect: 'square', state: { rotation: 0, zoom: 1 } },
      focus: null,
    })
    wrapper.unmount()
  })

  it('reverts to the original file when an earlier crop is undone', async () => {
    const earlier = { aspect: 'square', state: { rotation: 0, zoom: 1, cx: 800, cy: 600 } }
    const wrapper = mountDialog(imageAttachment({ file: cropped, originalFile: original, crop: earlier }))
    await flushPromises()
    expect(loadCropSource).toHaveBeenCalledWith(original)

    await body().get('[data-testid="media-aspect-original"]').setValue(true)
    await body().get('[data-testid="media-edit-save"]').trigger('click')
    await flushPromises()

    expect(exportCrop).not.toHaveBeenCalled()
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ file: original, crop: null })
    wrapper.unmount()
  })

  it('keeps the focal point on the same pixel when the crop changes', async () => {
    const wrapper = mountDialog(imageAttachment({ focus: { x: 0.5, y: 0 } }))
    await flushPromises()
    // Square crop of the 1600×1200 image keeps x in [200, 1400]: source x 1200 is 5/6 across.
    await body().get('[data-testid="media-aspect-square"]').setValue(true)
    await body().get('[data-testid="media-edit-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('save')?.[0]?.[0]).toMatchObject({ focus: { x: 0.67, y: 0 } })
    wrapper.unmount()
  })

  it('offers only the focal point for animated images', async () => {
    inspectImageFile.mockResolvedValue({ format: 'gif', animated: true })
    const wrapper = mountDialog(imageAttachment())
    await flushPromises()
    expect(body().find('[data-testid="media-edit-tab-crop"]').exists()).toBe(false)
    expect(body().get('[data-testid="media-animated-note"]').text()).toBe('imageEditor.animatedMediaNote')
    expect(body().get('[data-testid="focal-stage"] img').attributes('src')).toBe('blob:original')
    wrapper.unmount()
  })

  it('edits a published image by focal point and alt text', async () => {
    const wrapper = mountDialog({ type: 'image', url: 'https://s/u/posts/1.png', description: 'old', meta: { focus: { x: -0.5, y: 0.5 } } })
    await flushPromises()
    expect(loadCropSource).not.toHaveBeenCalled()
    expect(body().find('[data-testid="media-edit-tab-crop"]').exists()).toBe(false)
    const crosshair = body().get('[data-testid="focal-crosshair"]')
    expect(crosshair.attributes('style')).toContain('left: 25%')
    expect(crosshair.attributes('style')).toContain('top: 25%')
    await body().get('[data-testid="media-edit-save"]').trigger('click')
    expect(wrapper.emitted('save')?.[0]).toEqual([{ description: 'old', focus: { x: -0.5, y: 0.5 } }])
    wrapper.unmount()
  })

  it('shows only the description for video and focuses it', async () => {
    const wrapper = mountDialog({ type: 'video', url: 'blob:video', file: new File(['v'], 'v.mp4', { type: 'video/mp4' }) })
    await flushPromises()
    expect(body().find('[role="tablist"]').exists()).toBe(false)
    expect(document.activeElement).toBe(body().get('[data-testid="media-alt-input"]').element)
    await body().get('[data-testid="media-alt-input"]').setValue('Waves')
    await body().get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('save')).toBeUndefined()
    wrapper.unmount()
  })

  it('applies with Enter outside text fields', async () => {
    const wrapper = mountDialog(imageAttachment())
    await flushPromises()
    await body().get('[data-testid="media-alt-input"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('save')).toBeUndefined()
    await body().get('[data-testid="cropper-stage"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(wrapper.emitted('save')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('MonyMediaUpload', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  const stubs = { MediaEditDialog: { name: 'MediaEditDialog', props: ['attachment', 'initialFocus'], template: '<div class="edit-dialog-stub" />' } }

  it('opens the editor from Edit and from ALT, and reports the edit by index', async () => {
    const attachments = [
      { id: 'a', type: 'image' as const, url: 'blob:a', filename: 'a.png' },
      { id: 'b', type: 'video' as const, url: 'blob:b', filename: 'b.mp4' },
    ]
    const wrapper = mount(MonyMediaUpload, { props: { attachments }, global: { stubs } })

    expect(wrapper.findAll('[data-testid="media-edit-open"]')).toHaveLength(1)
    await wrapper.get('[data-testid="media-edit-open"]').trigger('click')
    let dialog = wrapper.findComponent({ name: 'MediaEditDialog' })
    expect(dialog.props()).toMatchObject({ attachment: attachments[0], initialFocus: 'crop' })

    dialog.vm.$emit('save', { description: 'alt', focus: { x: 0.1, y: 0.2 } })
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('edit')?.[0]).toEqual([0, { description: 'alt', focus: { x: 0.1, y: 0.2 } }])
    expect(wrapper.findComponent({ name: 'MediaEditDialog' }).exists()).toBe(false)

    await wrapper.findAll('.alt-btn')[1].trigger('click')
    dialog = wrapper.findComponent({ name: 'MediaEditDialog' })
    expect(dialog.props()).toMatchObject({ attachment: attachments[1], initialFocus: 'alt' })
  })

  it('positions the thumbnail on the focal point', () => {
    const wrapper = mount(MonyMediaUpload, {
      props: { attachments: [{ id: 'a', type: 'image' as const, url: 'blob:a', focus: { x: 0.5, y: -0.5 } }] },
      global: { stubs },
    })
    expect(wrapper.get('.preview-image').attributes('style')).toContain('object-position: 75% 75%')
  })
})
