/**
 * Activity states on the call's data channel: LiveKit data on topic ACTIVITY_TOPIC.
 *
 *   { "type": "activity", "v": 1, "channelId": uuid, "activity": VoiceActivity | null }
 *
 * The database row (voice_activities) is the authority; a peer message only moves a client
 * ahead while its revision is higher than the one it holds, and the next read of the row
 * settles it. Participants from other instances, who cannot read the row, follow these.
 */

export const ACTIVITY_TOPIC = 'harmony-activity'

/** Larger payloads are dropped unparsed; a state with a full queue encodes to under 16 KB. */
export const ACTIVITY_MESSAGE_MAX_BYTES = 16 * 1024
