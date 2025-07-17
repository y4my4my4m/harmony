// Handler for Note/Post activities (Create activities with Note objects)

import { ActivityPubActivity } from '../common/index.ts'

export interface NoteActivity {
  '@context': string | string[]
  id: string
  type: 'Create'
  actor: string
  object: {
    id: string
    type: 'Note'
    attributedTo: string
    content: string
    published: string
    to: string[]
    cc?: string[]
    tag?: any[]
    attachment?: any[]
    inReplyTo?: string
    conversation?: string
  }
  published: string
  to: string[]
  cc?: string[]
}

/**
 * Create a Note activity for a post
 */
export function createNoteActivity(params: {
  actorUrl: string
  noteId: string
  activityId: string
  content: string
  published: string
  to: string[]
  cc?: string[]
  tags?: any[]
  attachments?: any[]
  inReplyTo?: string
  conversation?: string
}): NoteActivity {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: params.activityId,
    type: 'Create',
    actor: params.actorUrl,
    object: {
      id: params.noteId,
      type: 'Note',
      attributedTo: params.actorUrl,
      content: params.content,
      published: params.published,
      to: params.to,
      cc: params.cc || [],
      tag: params.tags || [],
      attachment: params.attachments || [],
      ...(params.inReplyTo && { inReplyTo: params.inReplyTo }),
      ...(params.conversation && { conversation: params.conversation })
    },
    published: params.published,
    to: params.to,
    cc: params.cc || []
  }
}

/**
 * Validate a Note activity
 */
export function validateNoteActivity(activity: any): activity is NoteActivity {
  return (
    activity &&
    activity.type === 'Create' &&
    activity.object &&
    activity.object.type === 'Note' &&
    typeof activity.object.content === 'string' &&
    Array.isArray(activity.to)
  )
}
