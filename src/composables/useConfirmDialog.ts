import { ref, readonly } from 'vue'

interface ConfirmDialogOptions {
  title: string
  message: string
  confirmButtonText?: string
  dangerAction?: boolean
}

const visible = ref(false)
const dialogTitle = ref('')
const dialogMessage = ref('')
const dialogConfirmText = ref('Confirm')
const dialogDanger = ref(false)

let resolvePromise: ((value: boolean) => void) | null = null

/**
 * Promise-based replacement for window.confirm().
 *
 * Usage in a component:
 *   1. Import and destructure: const { confirm, ...confirmState } = useConfirmDialog()
 *   2. Add <ConfirmationModal v-bind="confirmState" /> to the template
 *   3. Replace `if (window.confirm('...'))` with `if (await confirm({ title, message }))`
 */
export function useConfirmDialog() {
  async function confirm(opts: ConfirmDialogOptions): Promise<boolean> {
    dialogTitle.value = opts.title
    dialogMessage.value = opts.message
    dialogConfirmText.value = opts.confirmButtonText ?? 'Confirm'
    dialogDanger.value = opts.dangerAction ?? false
    visible.value = true

    return new Promise<boolean>((resolve) => {
      resolvePromise = resolve
    })
  }

  function handleConfirm() {
    visible.value = false
    resolvePromise?.(true)
    resolvePromise = null
  }

  function handleClose() {
    visible.value = false
    resolvePromise?.(false)
    resolvePromise = null
  }

  return {
    confirm,
    confirmDialogVisible: readonly(visible),
    confirmDialogTitle: readonly(dialogTitle),
    confirmDialogMessage: readonly(dialogMessage),
    confirmDialogConfirmText: readonly(dialogConfirmText),
    confirmDialogDanger: readonly(dialogDanger),
    handleConfirm,
    handleClose,
  }
}
