import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import type { MessageMediaUploadState } from '@/services/messageMediaUpload'

const states = new Map<string, MessageMediaUploadState>()
vi.mock('@/services/messageMediaUpload', () => ({
  messageMediaUploadState: (path: string) => states.get(path),
}))

import MediaUploadProgress from '../MediaUploadProgress.vue'

const mountProgress = (state: MessageMediaUploadState) => {
  states.set('p', reactive(state))
  return mount(MediaUploadProgress, {
    props: { path: 'p' },
    global: { mocks: { $t: (key: string) => key } },
  })
}

describe('MediaUploadProgress', () => {
  it('reports progress and offers a Cancel button that calls the upload owner', async () => {
    const cancel = vi.fn()
    const wrapper = mountProgress({ progress: 0.4, status: 'uploading', error: null, cancel })

    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('40')
    const button = wrapper.get('button')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('message.upload.cancel')

    await button.trigger('click')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('offers no Cancel for an upload without an owner', () => {
    const wrapper = mountProgress({ progress: 0.4, status: 'uploading', error: null })
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('announces a failed upload as an alert instead of a progressbar', () => {
    const wrapper = mountProgress({ progress: 0.4, status: 'error', error: 'x', cancel: vi.fn() })
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(wrapper.get('[role="alert"]').text()).toBe('message.upload.failed')
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
