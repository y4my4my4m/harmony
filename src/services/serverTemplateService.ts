import { supabase } from '@/supabase'
import type { ServerTemplate } from '@/utils/serverTemplate'

/** export_server_template: owner, instance admin or MANAGE_SERVER on a local server. */
export async function exportServerTemplate(serverId: string): Promise<ServerTemplate> {
  const { data, error } = await supabase.rpc('export_server_template', { p_server_id: serverId })
  if (error) throw error
  return data as ServerTemplate
}

/** create_server_from_template: the new server's id. The caller owns it and is its only member. */
export async function createServerFromTemplate(name: string, template: ServerTemplate): Promise<string> {
  const { data, error } = await supabase.rpc('create_server_from_template', {
    p_name: name,
    p_template: template,
  })
  if (error) throw error
  return data as string
}
