import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

const router = Router();

export interface RoleActivity {
  '@context': string | string[];
  id: string;
  type: 'Create' | 'Update' | 'Delete' | 'Add' | 'Remove';
  actor: string;
  object: RoleObject | RoleAssignment;
  published: string;
  to?: string[];
  cc?: string[];
}

export interface RoleObject {
  type: 'Role';
  id: string;
  name: string;
  color?: string;
  hoist?: boolean;
  mentionable?: boolean;
  position: number;
  permissions: Record<string, boolean>;
  icon?: {
    type: 'Image';
    url: string;
  };
  unicodeEmoji?: string;
  attributedTo: string; // Server AP ID
}

export interface RoleAssignment {
  type: 'Relationship';
  subject: string; // User AP ID
  object: string; // Role AP ID
  relationship: 'hasRole';
}

export function roleToActivityPub(
  role: any,
  serverApId: string
): RoleObject {
  const roleApId = role.ap_id || `${serverApId}/roles/${role.id}`;
  
  const apRole: RoleObject = {
    type: 'Role',
    id: roleApId,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    position: role.position,
    permissions: role.permissions || {},
    attributedTo: serverApId,
  };

  if (role.icon_url) {
    apRole.icon = {
      type: 'Image',
      url: role.icon_url,
    };
  }

  if (role.unicode_emoji) {
    apRole.unicodeEmoji = role.unicode_emoji;
  }

  return apRole;
}

export function activityPubToRole(
  apRole: RoleObject,
  serverId: string
): any {
  return {
    server_id: serverId,
    name: apRole.name,
    color: apRole.color || '#99AAB5',
    hoist: apRole.hoist || false,
    mentionable: apRole.mentionable || false,
    position: apRole.position || 0,
    permissions: apRole.permissions || {},
    icon_url: apRole.icon?.url,
    unicode_emoji: apRole.unicodeEmoji,
    ap_id: apRole.id,
    is_default: apRole.name === '@everyone',
  };
}

export async function handleRoleActivity(
  activity: RoleActivity,
  targetServerId: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();

  try {
    logger.info(`📋 Processing ${activity.type} role activity: ${activity.id}`);

    switch (activity.type) {
      case 'Create': {
        const roleObject = activity.object as RoleObject;
        const roleData = activityPubToRole(roleObject, targetServerId);

        const { error } = await supabase
          .from('server_roles')
          .upsert(roleData, {
            onConflict: 'ap_id',
          });

        if (error) {
          logger.error('Failed to create federated role:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Created federated role: ${roleObject.name}`);
        return { success: true };
      }

      case 'Update': {
        const roleObject = activity.object as RoleObject;
        
        const { error } = await supabase
          .from('server_roles')
          .update({
            name: roleObject.name,
            color: roleObject.color,
            hoist: roleObject.hoist,
            mentionable: roleObject.mentionable,
            position: roleObject.position,
            permissions: roleObject.permissions,
            icon_url: roleObject.icon?.url,
            unicode_emoji: roleObject.unicodeEmoji,
          })
          .eq('ap_id', roleObject.id);

        if (error) {
          logger.error('Failed to update federated role:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Updated federated role: ${roleObject.name}`);
        return { success: true };
      }

      case 'Delete': {
        const roleObject = activity.object as RoleObject;

        // Don't allow deleting @everyone role
        const { data: existingRole } = await supabase
          .from('server_roles')
          .select('is_default')
          .eq('ap_id', roleObject.id)
          .single();

        if (existingRole?.is_default) {
          logger.warn('Cannot delete @everyone role via federation');
          return { success: false, error: 'Cannot delete default role' };
        }

        const { error } = await supabase
          .from('server_roles')
          .delete()
          .eq('ap_id', roleObject.id);

        if (error) {
          logger.error('Failed to delete federated role:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Deleted federated role: ${roleObject.id}`);
        return { success: true };
      }

      case 'Add': {
        const assignment = activity.object as RoleAssignment;
        
        const [{ data: role }, { data: user }] = await Promise.all([
          supabase
            .from('server_roles')
            .select('id, server_id')
            .eq('ap_id', assignment.object)
            .single(),
          supabase
            .from('profiles')
            .select('id')
            .eq('federated_id', assignment.subject)
            .single(),
        ]);

        if (!role || !user) {
          logger.warn('Role or user not found for assignment');
          return { success: false, error: 'Role or user not found' };
        }

        const { error } = await supabase
          .from('user_roles')
          .upsert({
            user_id: user.id,
            role_id: role.id,
            server_id: role.server_id,
          }, {
            onConflict: 'user_id,role_id',  // Column names, not constraint name
          });

        if (error) {
          logger.error('Failed to assign federated role:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Assigned role ${role.id} to user ${user.id}`);
        return { success: true };
      }

      case 'Remove': {
        const assignment = activity.object as RoleAssignment;

        const [{ data: role }, { data: user }] = await Promise.all([
          supabase
            .from('server_roles')
            .select('id')
            .eq('ap_id', assignment.object)
            .single(),
          supabase
            .from('profiles')
            .select('id')
            .eq('federated_id', assignment.subject)
            .single(),
        ]);

        if (!role || !user) {
          return { success: true }; // Already removed or doesn't exist
        }

        const { error } = await supabase
          .from('user_roles')
          .delete()
          .eq('user_id', user.id)
          .eq('role_id', role.id);

        if (error) {
          logger.error('Failed to remove federated role:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Removed role ${role.id} from user ${user.id}`);
        return { success: true };
      }

      default:
        logger.warn(`Unknown role activity type: ${activity.type}`);
        return { success: false, error: 'Unknown activity type' };
    }
  } catch (error: any) {
    logger.error('Error handling role activity:', error);
    return { success: false, error: error.message };
  }
}

export function createRoleActivity(
  type: 'Create' | 'Update' | 'Delete',
  role: any,
  serverApId: string,
  actorApId: string
): RoleActivity {
  const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
  const roleObject = roleToActivityPub(role, serverApId);

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        Role: 'harmony:Role',
        permissions: 'harmony:permissions',
        hoist: 'harmony:hoist',
        mentionable: 'harmony:mentionable',
      },
    ],
    id: `${baseUrl}/activities/${crypto.randomUUID()}`,
    type,
    actor: actorApId,
    object: roleObject,
    published: new Date().toISOString(),
    to: [`${serverApId}/followers`],
    cc: ['https://www.w3.org/ns/activitystreams#Public'],
  };
}

export function createRoleAssignmentActivity(
  type: 'Add' | 'Remove',
  userApId: string,
  roleApId: string,
  actorApId: string,
  serverApId: string
): RoleActivity {
  const baseUrl = `https://${config.INSTANCE_DOMAIN}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${baseUrl}/activities/${crypto.randomUUID()}`,
    type,
    actor: actorApId,
    object: {
      type: 'Relationship',
      subject: userApId,
      object: roleApId,
      relationship: 'hasRole',
    },
    published: new Date().toISOString(),
    to: [userApId, `${serverApId}/followers`],
  };
}

/**
 * GET /servers/:serverId/roles
 * Get all roles for a federated server
 */
router.get(
  '/servers/:serverId/roles',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId } = req.params;
    const supabase = getSupabaseClient();

    const { data: server, error: serverError } = await supabase
      .from('servers')
      .select('id, ap_id, is_local_server')
      .eq('id', serverId)
      .single();

    if (serverError || !server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const { data: roles, error: rolesError } = await supabase
      .from('server_roles')
      .select('*')
      .eq('server_id', serverId)
      .order('position', { ascending: false });

    if (rolesError) {
      logger.error('Failed to fetch server roles:', rolesError);
      return res.status(500).json({ error: 'Failed to fetch roles' });
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const serverApId = server.ap_id || `${baseUrl}/servers/${serverId}`;
    const collectionUrl = `${serverApId}/roles`;

    res.setHeader('Content-Type', 'application/activity+json');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: collectionUrl,
      type: 'OrderedCollection',
      totalItems: roles?.length || 0,
      orderedItems: (roles || []).map(role => roleToActivityPub(role, serverApId)),
    });
  })
);

/**
 * GET /servers/:serverId/roles/:roleId
 * Get a specific role
 */
router.get(
  '/servers/:serverId/roles/:roleId',
  asyncHandler(async (req: Request, res: Response) => {
    const { serverId, roleId } = req.params;
    const supabase = getSupabaseClient();

    const { data: role, error } = await supabase
      .from('server_roles')
      .select('*')
      .eq('id', roleId)
      .eq('server_id', serverId)
      .single();

    if (error || !role) {
      return res.status(404).json({ error: 'Role not found' });
    }

    const { data: server } = await supabase
      .from('servers')
      .select('ap_id')
      .eq('id', serverId)
      .single();

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const serverApId = server?.ap_id || `${baseUrl}/servers/${serverId}`;

    res.setHeader('Content-Type', 'application/activity+json');
    res.json(roleToActivityPub(role, serverApId));
  })
);

export default router;

