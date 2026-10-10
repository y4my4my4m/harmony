/**
 * Create Server from a template file: the file is read and summarized, the form is prefilled,
 * and the submit goes to create_server_from_template with the form's server fields.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const store = vi.hoisted(() => ({
  createServer: vi.fn(),
  createServerFromTemplate: vi.fn(),
}))
const openServer = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string, arg?: unknown) => (typeof arg === 'number' ? `${key}:${arg}` : key) }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }) }))
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => store }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ session: { user: { id: 'user-1' } } }) }))
vi.mock('@/stores/usePublicServers', () => ({ usePublicServersStore: () => ({ markStale: vi.fn() }) }))
vi.mock('@/composables/useOpenServer', () => ({ useOpenServer: () => openServer }))
vi.mock('@/composables/useImageCrop', () => ({ useImageCrop: () => ({ cropImage: vi.fn() }) }))

import CreateServer from '../CreateServer.vue'

const TEMPLATE = {
  format: 'harmony.server-template',
  version: 1,
  server: { name: 'Book Club', description: 'Reading together', public: true, rules: [], category: 'community' },
  roles: [
    { ref: 'r1', name: 'everyone', position: 0, permissions: '462850', is_default: true },
    { ref: 'r2', name: 'Admin', position: 999, permissions: '1073741823', is_admin: true },
    { ref: 'r3', name: 'mods', position: 1000, permissions: '132' },
  ],
  categories: [{ ref: 'c1', name: 'info', order: 0 }],
  channels: [
    { ref: 'ch1', name: 'welcome', type: 0, category: 'c1' },
    { ref: 'ch2', name: 'lounge', type: 1, category: 'c1' },
  ],
}

const global = {
  mocks: { $t: (key: string) => key },
  stubs: { Icon: true, ServerCategoryPicker: true },
}

function pick(wrapper: ReturnType<typeof mount>, contents: string) {
  const input = wrapper.get<HTMLInputElement>('[data-testid="create-server-template-input"]').element
  const file = new File([contents], 'club.harmony-template.json', { type: 'application/json' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change'))
}

beforeEach(() => {
  store.createServer.mockReset()
  store.createServerFromTemplate.mockReset()
  openServer.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Create Server from a template', () => {
  it('summarizes the file and prefills the form', async () => {
    const wrapper = mount(CreateServer, { global, attachTo: document.body })
    pick(wrapper, JSON.stringify(TEMPLATE))
    await flushPromises()

    const summary = wrapper.get('[data-testid="create-server-template-summary"]').text()
    expect(summary).toContain('serverTemplate.fromTemplateNamed')
    expect(summary).toContain('serverTemplate.roles:1 · serverTemplate.categories:1 · serverTemplate.channels:2')
    expect(summary).toContain('serverTemplate.structureOnly')
    expect(wrapper.get<HTMLInputElement>('[data-testid="create-server-name-input"]').element.value).toBe('Book Club')
    expect(wrapper.get<HTMLTextAreaElement>('#create-server-description').element.value).toBe('Reading together')
    wrapper.unmount()
  })

  it('creates the server through the template RPC with the form fields', async () => {
    store.createServerFromTemplate.mockResolvedValue({ id: 'srv-t', name: 'Readers' })
    const wrapper = mount(CreateServer, { global, attachTo: document.body })
    pick(wrapper, JSON.stringify(TEMPLATE))
    await flushPromises()

    await wrapper.get('[data-testid="create-server-name-input"]').setValue('Readers')
    await wrapper.get('input[name="create-server-visibility"][type="radio"]').setValue(true)
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(store.createServer).not.toHaveBeenCalled()
    expect(store.createServerFromTemplate).toHaveBeenCalledTimes(1)
    const [name, sent] = store.createServerFromTemplate.mock.calls[0]
    expect(name).toBe('Readers')
    expect(sent.server).toEqual({
      name: 'Book Club', description: 'Reading together', public: false, rules: [], category: 'community',
    })
    expect(sent.channels).toEqual(TEMPLATE.channels)
    expect(openServer).toHaveBeenCalledWith('srv-t')
    expect(wrapper.emitted('created')?.[0]).toEqual([{ id: 'srv-t', name: 'Readers' }])
    wrapper.unmount()
  })

  it('shows why a file is refused and keeps the plain form', async () => {
    const wrapper = mount(CreateServer, { global, attachTo: document.body })
    pick(wrapper, JSON.stringify({ format: 'discord', version: 1 }))
    await flushPromises()

    expect(wrapper.get('.template-error').text()).toBe('serverTemplate.errors.notTemplate')
    expect(wrapper.find('[data-testid="create-server-template-summary"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the database refusal', async () => {
    store.createServerFromTemplate.mockRejectedValue({
      message: 'AUTOMOD_INVALID_RULE: unknown rule type bogus', code: '22023',
    })
    const wrapper = mount(CreateServer, { global, attachTo: document.body })
    pick(wrapper, JSON.stringify(TEMPLATE))
    await flushPromises()
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('.error-banner').text()).toContain('serverTemplate.errors.rejected')
    expect(openServer).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('removing the template returns to a plain server', async () => {
    store.createServer.mockResolvedValue({ id: 'srv-p', name: 'Book Club' })
    const wrapper = mount(CreateServer, { global, attachTo: document.body })
    pick(wrapper, JSON.stringify(TEMPLATE))
    await flushPromises()
    await wrapper.get('[data-testid="create-server-template-summary"] .btn-ghost').trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(store.createServerFromTemplate).not.toHaveBeenCalled()
    expect(store.createServer).toHaveBeenCalledWith(expect.objectContaining({ name: 'Book Club', owner: 'user-1' }))
    wrapper.unmount()
  })
})
