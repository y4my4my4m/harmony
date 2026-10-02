/**
 * Account data export: request_my_data_export() returns the account document and opens an
 * export valid for an hour; export_my_messages() pages the caller's own messages under it.
 * Both run server-side with the caller bound and rate-limited (migration
 * 20261005400001_account_security.sql). The archive is assembled here.
 */

import { supabase } from '@/supabase'

export type ExportProgress =
  | { phase: 'account' }
  | { phase: 'messages'; done: number; total: number }
  | { phase: 'packaging' }

interface ExportDocument {
  export_id: string
  generated_at: string
  message_count: number
  profile?: { username?: string | null } | null
  media?: Array<{ bucket: string; name: string; created_at?: string; size?: string | null; mimetype?: string | null }>
  [section: string]: unknown
}

interface MessagePage {
  messages: unknown[]
  next: { created_at: string; id: string } | null
}

const PAGE_SIZE = 2000

const FILES: Array<{ name: string; sections: string[] }> = [
  { name: 'account.json', sections: ['account', 'two_factor', 'sessions'] },
  { name: 'profile.json', sections: ['profile', 'notification_preferences', 'notification_overrides', 'server_folders'] },
  { name: 'servers.json', sections: ['servers', 'servers_owned'] },
  { name: 'conversations.json', sections: ['conversations'] },
  { name: 'posts.json', sections: ['posts', 'post_interactions'] },
  { name: 'reactions.json', sections: ['reactions'] },
  { name: 'social.json', sections: ['following', 'followers', 'blocks', 'mutes'] },
  { name: 'reports.json', sections: ['reports_filed'] },
  { name: 'bots.json', sections: ['bots'] },
]

function readme(doc: ExportDocument, messageCount: number): string {
  return [
    'Harmony account export',
    `Generated: ${doc.generated_at}`,
    `Export id: ${doc.export_id}`,
    '',
    'account.json        sign-in email, two-factor status, signed-in sessions',
    'profile.json        profile and notification settings',
    'servers.json        server memberships and servers you own',
    'conversations.json  direct and group conversations you are in, with participants',
    `messages.json       the ${messageCount} messages you sent, in servers and conversations`,
    'posts.json          your posts, likes, boosts and bookmarks',
    'reactions.json      reactions you added to messages',
    'social.json         who you follow, who follows you, blocks and mutes',
    'reports.json        reports you filed',
    'bots.json           bots you own (tokens are not exported)',
    'media.json          files you uploaded, with download links',
    '',
    'Messages in end-to-end encrypted channels are exported as stored: ciphertext.',
    'Other people\'s messages, key material, push endpoints and recovery code hashes',
    'are not part of the export.',
    '',
  ].join('\n')
}

export async function exportAccountData(
  onProgress: (progress: ExportProgress) => void = () => {},
): Promise<{ blob: Blob; filename: string }> {
  onProgress({ phase: 'account' })
  const { data, error } = await supabase.rpc('request_my_data_export')
  if (error) throw error
  const doc = data as ExportDocument

  const messages: unknown[] = []
  let cursor: MessagePage['next'] = null
  onProgress({ phase: 'messages', done: 0, total: doc.message_count })
  do {
    const { data: pageData, error: pageError } = await supabase.rpc('export_my_messages', {
      p_export_id: doc.export_id,
      p_after_created_at: cursor?.created_at ?? null,
      p_after_id: cursor?.id ?? null,
      p_limit: PAGE_SIZE,
    })
    if (pageError) throw pageError
    const page = pageData as MessagePage
    messages.push(...page.messages)
    cursor = page.next
    onProgress({ phase: 'messages', done: messages.length, total: Math.max(doc.message_count, messages.length) })
  } while (cursor)

  onProgress({ phase: 'packaging' })
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  zip.file('README.txt', readme(doc, messages.length))
  for (const file of FILES) {
    const content = Object.fromEntries(file.sections.map((section) => [section, doc[section] ?? null]))
    zip.file(file.name, JSON.stringify(content, null, 2))
  }
  zip.file('messages.json', JSON.stringify(messages, null, 2))
  zip.file('media.json', JSON.stringify((doc.media ?? []).map((object) => ({
    ...object,
    url: supabase.storage.from(object.bucket).getPublicUrl(object.name).data.publicUrl,
  })), null, 2))

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  const who = (doc.profile?.username || 'account').replace(/[^A-Za-z0-9_-]/g, '')
  const date = doc.generated_at.slice(0, 10)
  return { blob, filename: `harmony-export-${who}-${date}.zip` }
}
