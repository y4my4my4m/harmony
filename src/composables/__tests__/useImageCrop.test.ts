import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { useImageCrop } from '../useImageCrop'

vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn() }) }))

import Avatar from '@/components/common/Avatar.vue'

const file = (name: string) => new File(['x'], name, { type: 'image/png' })

describe('useImageCrop', () => {
  it('resolves with the file the dialog settles on', async () => {
    const { cropImage, cropRequest, settle } = useImageCrop()
    const pending = cropImage(file('a.png'), 'avatar')
    expect(cropRequest.value).toMatchObject({ kind: 'avatar' })
    const out = file('a.webp')
    settle(out)
    expect(await pending).toBe(out)
    expect(cropRequest.value).toBeNull()
  })

  it('resolves null on cancel and when a newer request replaces it', async () => {
    const { cropImage, cropRequest, settle } = useImageCrop()
    const first = cropImage(file('a.png'), 'avatar')
    const second = cropImage(file('b.png'), 'server_banner')
    expect(await first).toBeNull()
    expect(cropRequest.value).toMatchObject({ kind: 'server_banner' })
    settle(null)
    expect(await second).toBeNull()
  })
})

describe('editable Avatar', () => {
  it('uploads the cropped file, not the picked one', async () => {
    const { cropRequest, settle } = useImageCrop()
    const wrapper = mount(Avatar, { props: { editable: true } })
    const input = wrapper.get('input[type="file"]')
    const picked = file('me.png')
    Object.defineProperty(input.element, 'files', { value: [picked], configurable: true })
    await input.trigger('change')
    await flushPromises()

    expect(cropRequest.value).toMatchObject({ file: picked, kind: 'avatar' })
    const cropped = file('me.webp')
    settle(cropped)
    await flushPromises()
    expect(wrapper.emitted('upload')?.[0]).toEqual([cropped])
  })

  it('uploads nothing when the crop is cancelled', async () => {
    const { settle } = useImageCrop()
    const wrapper = mount(Avatar, { props: { editable: true } })
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [file('me.png')], configurable: true })
    await input.trigger('change')
    await flushPromises()
    settle(null)
    await flushPromises()
    expect(wrapper.emitted('upload')).toBeUndefined()
  })
})
