import { ref, readonly } from 'vue'

interface ConfirmDialogOptions {
  title: string
  message: string
  confirmButtonText?: string
  dangerAction?: boolean
}

interface PromptDialogOptions extends ConfirmDialogOptions {
  label?: string
  placeholder?: string
  initialValue?: string
}

const visible = ref(false)
const dialogTitle = ref('')
const dialogMessage = ref('')
const dialogConfirmText = ref('Confirm')
const dialogDanger = ref(false)
/** Set while a prompt() is open: the modal shows a text field. */
const dialogInput = ref<{ label: string; placeholder: string; initialValue: string } | null>(null)

let resolvePromise: ((value: any) => void) | null = null

function open(opts: ConfirmDialogOptions) {
  // A dialog still open resolves as cancelled.
  if (resolvePromise) resolvePromise(dialogInput.value ? null : false)
  dialogTitle.value = opts.title
  dialogMessage.value = opts.message
  dialogConfirmText.value = opts.confirmButtonText ?? 'Confirm'
  dialogDanger.value = opts.dangerAction ?? false
  visible.value = true
}

/**
 * Promise-based replacements for window.confirm() and window.prompt(); prompt() is absent
 * from Tauri's webviews. The dialog is mounted once, in App.vue.
 *
 *   if (await confirm({ title, message })) ...
 *   const reason = await prompt({ title, message, label })   // null when cancelled
 */
export function useConfirmDialog() {
  async function confirm(opts: ConfirmDialogOptions): Promise<boolean> {
    open(opts)
    dialogInput.value = null
    return new Promise<boolean>((resolve) => {
      resolvePromise = resolve
    })
  }

  async function prompt(opts: PromptDialogOptions): Promise<string | null> {
    open(opts)
    dialogInput.value = {
      label: opts.label ?? '',
      placeholder: opts.placeholder ?? '',
      initialValue: opts.initialValue ?? '',
    }
    return new Promise<string | null>((resolve) => {
      resolvePromise = resolve
    })
  }

  function handleConfirm(value?: string) {
    visible.value = false
    resolvePromise?.(dialogInput.value ? (value ?? '') : true)
    resolvePromise = null
  }

  function handleClose() {
    visible.value = false
    resolvePromise?.(dialogInput.value ? null : false)
    resolvePromise = null
  }

  return {
    confirm,
    prompt,
    confirmDialogVisible: readonly(visible),
    confirmDialogTitle: readonly(dialogTitle),
    confirmDialogMessage: readonly(dialogMessage),
    confirmDialogConfirmText: readonly(dialogConfirmText),
    confirmDialogDanger: readonly(dialogDanger),
    confirmDialogInput: readonly(dialogInput),
    handleConfirm,
    handleClose,
  }
}
