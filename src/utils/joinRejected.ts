/**
 * A server on another instance refused a join after the join request had answered (its Reject,
 * federation-backend processReject) or removed the user (its Remove: federation turned off, a
 * kick, a ban; processGroupMemberRemove). The backend has removed the membership. The server
 * leaves the list, and a view on it moves to the chat home.
 */
export async function forgetRejectedServer(serverId: string | undefined): Promise<void> {
  if (!serverId) return
  const { useServerChannelStore } = await import('@/stores/useServerChannel')
  useServerChannelStore()._handleUserServerLeave({ old: { server_id: serverId } })
  const { default: router } = await import('@/router')
  if (router.currentRoute.value.params.serverId === serverId) await router.push('/chat')
}
