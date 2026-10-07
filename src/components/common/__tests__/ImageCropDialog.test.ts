/**
 * ImageCropDialog: static images crop to the preset size, animated images pass
 * through uncropped with a note, undecodable images can go up as they are;
 * Escape cancels, Enter applies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'

const { inspectImageFile, loadCropSource, exportCrop } = vi.hoisted(() => ({
  inspectImageFile: vi.fn(),
  loadCropSource: vi.fn(),
  exportCrop: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/utils/imageCrop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/imageCrop')>()),
  inspectImageFile,
  loadCropSource,
  exportCrop,
}))

import ImageCropDialog from '../ImageCropDialog.vue'

const picked = new File(['pixels'], 'me.png', { type: 'image/png' })
const cropped = new File(['cropped'], 'me.webp', { type: 'image/webp' })

function fakeSource() {
  return { image: {}, preview: {}, width: 800, height: 600, format: 'png', close: vi.fn() }
}

function mountDialog(kind: 'avatar' | 'profile_banner' | 'group_icon' = 'avatar') {
  return mount(ImageCropDialog, {
    props: { file: picked, kind },
    attachTo: document.body,
  })
}

// The dialog teleports to <body>.
const body = () => new DOMWrapper(document.body)

describe('ImageCropDialog', () => {
  beforeEach(() => {
    inspectImageFile.mockResolvedValue({ format: 'png', animated: false })
    loadCropSource.mockImplementation(async () => fakeSource())
    exportCrop.mockResolvedValue(cropped)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:anim')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('is a labelled modal dialog', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const dialog = body().get('[role="dialog"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    const title = body().get(`#${dialog.attributes('aria-labelledby')}`)
    expect(title.text()).toBe('imageEditor.title.avatar')
    wrapper.unmount()
  })

  it('exports the centred crop at the preset size and confirms with the cropped file', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    expect(body().find('[data-testid="cropper-stage"]').exists()).toBe(true)

    await body().get('[data-testid="crop-apply"]').trigger('click')
    await flushPromises()

    expect(exportCrop).toHaveBeenCalledTimes(1)
    const [source, state, aspect, target, name] = exportCrop.mock.calls[0]
    expect(source).toMatchObject({ width: 800, height: 600 })
    expect(state).toEqual({ rotation: 0, zoom: 1, cx: 400, cy: 300 })
    expect(aspect).toBe(1)
    expect(target).toEqual({ width: 512, height: 512 })
    expect(name).toBe('me.png')
    expect(wrapper.emitted('confirm')?.[0]).toEqual([cropped])
    wrapper.unmount()
  })

  it('uses the banner aspect and size', async () => {
    const wrapper = mountDialog('profile_banner')
    await flushPromises()
    await body().get('[data-testid="crop-apply"]').trigger('click')
    await flushPromises()
    expect(exportCrop.mock.calls[0][2]).toBe(3)
    expect(exportCrop.mock.calls[0][3]).toEqual({ width: 1500, height: 500 })
    wrapper.unmount()
  })

  it('zooms with + and rotates, then Enter on the crop area applies that crop', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const stage = body().get('[data-testid="cropper-stage"]')
    await stage.trigger('keydown', { key: '+' })
    await body().get('[data-testid="cropper-rotate-right"]').trigger('click')
    await stage.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const state = exportCrop.mock.calls[0][1]
    expect(state.rotation).toBe(90)
    expect(state.zoom).toBeCloseTo(1.1)
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    wrapper.unmount()
  })

  it('moves the crop window with the arrow keys', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const stage = body().get('[data-testid="cropper-stage"]')
    await stage.trigger('keydown', { key: '+' })
    await stage.trigger('keydown', { key: '+' })
    await stage.trigger('keydown', { key: 'ArrowRight' })
    await body().get('[data-testid="crop-apply"]').trigger('click')
    await flushPromises()
    expect(exportCrop.mock.calls[0][1].cx).toBeGreaterThan(400)
    wrapper.unmount()
  })

  it('cancels on Escape without exporting', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    await body().get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(exportCrop).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('stops Escape from reaching the modal underneath', async () => {
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    const wrapper = mountDialog()
    await flushPromises()
    await body().get('[role="dialog"]').trigger('keydown', { key: 'Escape' })
    expect(outer).not.toHaveBeenCalled()
    document.removeEventListener('keydown', outer)
    wrapper.unmount()
  })

  it('passes animated images through uncropped with a note', async () => {
    inspectImageFile.mockResolvedValue({ format: 'gif', animated: true })
    const wrapper = mountDialog()
    await flushPromises()

    expect(body().find('[data-testid="crop-animated-note"]').text()).toBe('imageEditor.animatedNote')
    expect(loadCropSource).not.toHaveBeenCalled()
    await body().get('[data-testid="crop-apply"]').trigger('click')
    expect(wrapper.emitted('confirm')?.[0]).toEqual([picked])
    expect(exportCrop).not.toHaveBeenCalled()

    wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:anim')
  })

  it('offers the original when the image cannot be decoded', async () => {
    loadCropSource.mockResolvedValue(null)
    const wrapper = mountDialog()
    await flushPromises()
    expect(body().find('[role="alert"]').text()).toBe('imageEditor.decodeFailed')
    expect(body().get('[data-testid="crop-apply"]').attributes('disabled')).toBeDefined()
    const useOriginal = body().findAll('button').find((b) => b.text() === 'imageEditor.useOriginal')
    await useOriginal!.trigger('click')
    expect(wrapper.emitted('confirm')?.[0]).toEqual([picked])
    wrapper.unmount()
  })

  it('releases the decoded image on close', async () => {
    const source = fakeSource()
    loadCropSource.mockResolvedValue(source)
    const wrapper = mountDialog()
    await flushPromises()
    wrapper.unmount()
    expect(source.close).toHaveBeenCalledTimes(1)
  })

  it('keeps Tab focus inside the dialog', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const dialog = body().get('[role="dialog"]')
    const buttons = dialog.findAll('button')
    const last = buttons[buttons.length - 1].element as HTMLButtonElement
    last.focus()
    await dialog.trigger('keydown', { key: 'Tab' })
    const first = dialog.element.querySelector('button, input, [tabindex]:not([tabindex="-1"])')
    expect(document.activeElement).toBe(first)
    wrapper.unmount()
  })
})
