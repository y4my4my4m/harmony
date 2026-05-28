/** Mirrors `AudioAction` in src/types.ts — keep in sync when adding sounds. */

export type AudioActionId =
  | 'mention'
  | 'dm'
  | 'reaction'
  | 'reply'
  | 'server_invite'
  | 'friend_request'
  | 'server_update'
  | 'emoji_added'
  | 'voice_channel_activity'
  | 'voice_connect'
  | 'voice_disconnect'
  | 'call_incoming'
  | 'call_outgoing'
  | 'call_ended'
  | 'mic_on'
  | 'mic_off'
  | 'deafen_on'
  | 'deafen_off'
  | 'camera_on'
  | 'camera_off'
  | 'screenshare_on'
  | 'screenshare_off'
  | 'ui_click'
  | 'ui_hover'
  | 'ui_success'
  | 'ui_error'
  | 'ui_notification'

export type SoundCategory = 'message' | 'social' | 'system' | 'voice' | 'call' | 'toggle' | 'ui'

export interface SoundSlotMeta {
  id: AudioActionId
  label: string
  hint: string
  category: SoundCategory
  /** Suggested export filename (Harmony pack convention). */
  exportName: string
}

export const PACK_FORMAT = 'harmony-audio-pack' as const
export const PACK_VERSION = 1
export const PACK_MAX_BYTES = 10 * 1024 * 1024

export const CATEGORY_LABELS: Record<SoundCategory, string> = {
  message: 'Messages & notifications',
  social: 'Social',
  system: 'System',
  voice: 'Voice channels',
  call: 'Calls',
  toggle: 'Mic / deafen / camera / screenshare',
  ui: 'UI feedback',
}

/** Legacy filenames used in built-in themes (e.g. invite.mp3 → server_invite). */
export const FILE_ALIASES: Record<string, AudioActionId> = {
  invite: 'server_invite',
  request: 'friend_request',
  update: 'server_update',
  emoji: 'emoji_added',
  voice_activity: 'voice_channel_activity',
  click: 'ui_click',
  hover: 'ui_hover',
  success: 'ui_success',
  error: 'ui_error',
  notification: 'ui_notification',
}

export const SOUND_SLOTS: SoundSlotMeta[] = [
  { id: 'mention', label: 'Mention', hint: '@mention in a channel', category: 'message', exportName: 'mention.mp3' },
  { id: 'dm', label: 'Direct message', hint: 'New DM received', category: 'message', exportName: 'dm.mp3' },
  { id: 'reaction', label: 'Reaction', hint: 'Someone reacted to your message', category: 'message', exportName: 'reaction.mp3' },
  { id: 'reply', label: 'Reply', hint: 'Thread / reply notification', category: 'message', exportName: 'reply.mp3' },
  { id: 'server_invite', label: 'Server invite', hint: 'Invite to a server', category: 'social', exportName: 'server_invite.mp3' },
  { id: 'friend_request', label: 'Friend request', hint: 'Incoming friend request', category: 'social', exportName: 'friend_request.mp3' },
  { id: 'server_update', label: 'Server update', hint: 'Server settings / announcement', category: 'system', exportName: 'server_update.mp3' },
  { id: 'emoji_added', label: 'Emoji added', hint: 'Custom emoji added to server', category: 'social', exportName: 'emoji_added.mp3' },
  {
    id: 'voice_channel_activity',
    label: 'Voice activity',
    hint: 'Activity in a voice channel you are in',
    category: 'voice',
    exportName: 'voice_channel_activity.mp3',
  },
  { id: 'voice_connect', label: 'Voice connect', hint: 'Joined voice channel', category: 'voice', exportName: 'voice_connect.mp3' },
  { id: 'voice_disconnect', label: 'Voice disconnect', hint: 'Left voice channel', category: 'voice', exportName: 'voice_disconnect.mp3' },
  { id: 'call_incoming', label: 'Incoming call', hint: 'Ringtone / incoming call', category: 'call', exportName: 'call_incoming.mp3' },
  { id: 'call_outgoing', label: 'Outgoing call', hint: 'Placing a call', category: 'call', exportName: 'call_outgoing.mp3' },
  { id: 'call_ended', label: 'Call ended', hint: 'Call hung up', category: 'call', exportName: 'call_ended.mp3' },
  { id: 'mic_on', label: 'Mic on', hint: 'Unmuted microphone', category: 'toggle', exportName: 'mic_on.mp3' },
  { id: 'mic_off', label: 'Mic off', hint: 'Muted microphone', category: 'toggle', exportName: 'mic_off.mp3' },
  { id: 'deafen_on', label: 'Deafen on', hint: 'Deafened', category: 'toggle', exportName: 'deafen_on.mp3' },
  { id: 'deafen_off', label: 'Deafen off', hint: 'Undeafened', category: 'toggle', exportName: 'deafen_off.mp3' },
  { id: 'camera_on', label: 'Camera on', hint: 'Video enabled', category: 'toggle', exportName: 'camera_on.mp3' },
  { id: 'camera_off', label: 'Camera off', hint: 'Video disabled', category: 'toggle', exportName: 'camera_off.mp3' },
  { id: 'screenshare_on', label: 'Screenshare on', hint: 'Started sharing screen', category: 'toggle', exportName: 'screenshare_on.mp3' },
  { id: 'screenshare_off', label: 'Screenshare off', hint: 'Stopped sharing screen', category: 'toggle', exportName: 'screenshare_off.mp3' },
  { id: 'ui_click', label: 'UI click', hint: 'Button / control click', category: 'ui', exportName: 'ui_click.mp3' },
  { id: 'ui_hover', label: 'UI hover', hint: 'Hover feedback', category: 'ui', exportName: 'ui_hover.mp3' },
  { id: 'ui_success', label: 'UI success', hint: 'Action succeeded', category: 'ui', exportName: 'ui_success.mp3' },
  { id: 'ui_error', label: 'UI error', hint: 'Action failed', category: 'ui', exportName: 'ui_error.mp3' },
  { id: 'ui_notification', label: 'UI notification', hint: 'Generic in-app toast', category: 'ui', exportName: 'ui_notification.mp3' },
]

export const ALL_ACTION_IDS = new Set(SOUND_SLOTS.map((s) => s.id))

export function slotById(id: AudioActionId): SoundSlotMeta {
  const slot = SOUND_SLOTS.find((s) => s.id === id)
  if (!slot) throw new Error(`Unknown action: ${id}`)
  return slot
}

/** Map a dropped filename to an action id, or null if unrecognized. */
export function matchFilenameToAction(filename: string): AudioActionId | null {
  const base = filename.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g, '_')
  if (ALL_ACTION_IDS.has(base as AudioActionId)) return base as AudioActionId
  const alias = FILE_ALIASES[base]
  if (alias) return alias
  return null
}
