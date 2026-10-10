/**
 * The poll composer: 2 to 10 answers, validation before the call, create_message_poll's
 * arguments, and its refusals shown in the dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('@/supabase', () => ({ supabase: { rpc } }))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string) => key } } }))
vi.mock('@/composables/useHapticSettings', () => ({ useHapticSettings: () => ({ triggerToggle: vi.fn() }) }))

import PollCreateModal from '../PollCreateModal.vue'

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const qa = <T extends Element = HTMLInputElement>(sel: string) => Array.from(document.body.querySelectorAll<T>(sel))

async function type(input: HTMLInputElement | null, text: string) {
  input!.value = text
  input!.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}

async function click(el: Element | null) {
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

function render(props: Record<string, unknown> = {}) {
  return mount(PollCreateModal, {
    props: { show: true, channelId: 'c1', ...props },
    attachTo: document.body,
    global: { stubs: { Icon: true, transition: false } },
  })
}

beforeEach(() => rpc.mockReset())
afterEach(() => { document.body.innerHTML = '' })

describe('PollCreateModal', () => {
  it('starts with two answers and adds up to ten', async () => {
    const w = render()
    await flushPromises()
    expect(qa('[data-testid="poll-answer"]')).toHaveLength(2)
    expect(q('[data-testid="poll-answer-remove"]')).toBeNull()
    for (let i = 0; i < 8; i++) await click(q('[data-testid="poll-add-answer"]'))
    expect(qa('[data-testid="poll-answer"]')).toHaveLength(10)
    expect(q('[data-testid="poll-add-answer"]')).toBeNull()
    await click(q('[data-testid="poll-answer-remove"]'))
    expect(qa('[data-testid="poll-answer"]')).toHaveLength(9)
    w.unmount()
  })

  it('posts the trimmed draft to create_message_poll and emits the message', async () => {
    const message = { id: 'm1', channel_id: 'c1', content: [], created_at: '2026-10-10T00:00:00Z' }
    rpc.mockResolvedValue({ data: message, error: null })
    const w = render({ replyTo: 'r1' })
    await flushPromises()
    await type(q<HTMLInputElement>('[data-testid="poll-question"]'), '  Lunch?  ')
    const [a, b] = qa('[data-testid="poll-answer"]')
    await type(a, ' Pizza ')
    await type(b, 'Sushi')
    const duration = q<HTMLSelectElement>('[data-testid="poll-duration"]')!
    duration.value = '72'
    duration.dispatchEvent(new Event('change', { bubbles: true }))
    await click(q('[data-testid="poll-allow-multiple"]'))

    q<HTMLFormElement>('[data-testid="poll-create-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()

    expect(rpc).toHaveBeenCalledWith('create_message_poll', {
      p_channel_id: 'c1',
      p_conversation_id: null,
      p_question: 'Lunch?',
      p_options: ['Pizza', 'Sushi'],
      p_allow_multiple: true,
      p_duration_hours: 72,
      p_reply_to: 'r1',
    })
    expect(w.emitted('created')?.[0]).toEqual([message])
    w.unmount()
  })

  it('refuses an incomplete draft without calling the server', async () => {
    const w = render()
    await flushPromises()
    await type(q<HTMLInputElement>('[data-testid="poll-question"]'), 'Lunch?')
    await type(qa('[data-testid="poll-answer"]')[0], 'Pizza')
    expect(q<HTMLButtonElement>('[data-testid="poll-post"]')!.disabled).toBe(true)
    q<HTMLFormElement>('[data-testid="poll-create-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(rpc).not.toHaveBeenCalled()
    expect(q('[data-testid="poll-error"]')?.textContent).toBe('polls.errors.answers')
    w.unmount()
  })

  it('shows why the server refused the poll', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: '23514', message: 'POLL_ENCRYPTED: polls are not available in end-to-end encrypted conversations' },
    })
    const w = render({ channelId: null, conversationId: 'd1' })
    await flushPromises()
    await type(q<HTMLInputElement>('[data-testid="poll-question"]'), 'Lunch?')
    const [a, b] = qa('[data-testid="poll-answer"]')
    await type(a, 'Pizza')
    await type(b, 'Sushi')
    q<HTMLFormElement>('[data-testid="poll-create-form"]')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushPromises()
    expect(rpc).toHaveBeenCalledWith('create_message_poll', expect.objectContaining({
      p_channel_id: null, p_conversation_id: 'd1',
    }))
    expect(q('[data-testid="poll-error"]')?.textContent).toBe('polls.errors.encrypted')
    expect(w.emitted('created')).toBeUndefined()
    w.unmount()
  })

  it('reads a dropped poll as an AutoMod block', async () => {
    rpc.mockImplementation(async (fn: string) => fn === 'create_message_poll'
      ? { data: null, error: null }
      : { data: { rule_type: 'keyword', message: 'Keep it clean.' }, error: null })
    const w = render()
    await flushPromises()
    await type(q<HTMLInputElement>('[data-testid="poll-question"]'), 'Lunch?')
    const [a, b] = qa('[data-testid="poll-answer"]')
    await type(a, 'Pizza')
    await type(b, 'Sushi')
    await click(q('[data-testid="poll-post"]'))
    expect(rpc).toHaveBeenCalledWith('get_automod_block_notice', { p_channel_id: 'c1' })
    expect(q('[data-testid="poll-error"]')?.textContent).toBe('Keep it clean.')
    w.unmount()
  })
})
