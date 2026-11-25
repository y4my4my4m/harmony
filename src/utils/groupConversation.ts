import type { DMConversation, DMUser } from '@/stores/useDM'

/** Participants of a group conversation, its creator included: 20261116100001_group_conversation_limit.sql. */
export const GROUP_CONVERSATION_LIMIT = 10

/** The people of a conversation, the viewer excluded. */
export function conversationOthers(
  conversation: Pick<DMConversation, 'type' | 'other_user' | 'participants'> | null | undefined,
): DMUser[] {
  if (conversation?.type === 'group') return conversation.participants ?? []
  return conversation?.other_user ? [conversation.other_user] : []
}
