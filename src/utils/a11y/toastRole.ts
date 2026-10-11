/** Live-region role for a vue-toastification toast type: errors interrupt, the rest wait. */
export function toastRole(type: string | undefined): 'alert' | 'status' {
  return type === 'error' || type === 'warning' ? 'alert' : 'status'
}
