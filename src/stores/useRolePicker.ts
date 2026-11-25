import { defineStore } from 'pinia'

/** The server whose role picker (RolePickerModal, mounted in BaseLayout) is open. */
export const useRolePickerStore = defineStore('rolePicker', {
  state: () => ({
    modalServerId: null as string | null,
  }),
  actions: {
    openModal(serverId: string): void {
      this.modalServerId = serverId
    },
    closeModal(): void {
      this.modalServerId = null
    },
  },
})
