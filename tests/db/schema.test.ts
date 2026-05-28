import { describe, it, expect, beforeAll } from 'vitest'
import { isDatabaseAvailable, withTestTransaction } from '../helpers/dbTestHelper'

const EXPECTED_TABLES = [
  'profiles', 'posts', 'follows', 'post_interactions',
  'servers', 'channels', 'messages', 'threads', 'thread_members',
  'reactions', 'user_servers', 'server_roles', 'user_roles',
  'conversations', 'conversation_participants', 'invites',
  'federated_instances', 'blocked_instances', 'ap_activities',
  'notifications', 'notification_preferences', 'push_subscriptions',
  'unread_counts', 'emojis', 'reports', 'bots', 'bot_tokens',
  'user_blocks', 'hashtags', 'post_hashtags', 'timeline_entries',
  'voice_channel_participants', 'channel_categories',
]

const EXPECTED_FUNCTIONS = [
  'get_current_profile_id',
  'has_permission',
  'create_or_get_direct_conversation',
  'is_blocked_by',
  'has_blocked',
]

let dbAvailable = false

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable()
})

describe.skipIf(!dbAvailable)('Database Schema', () => {
  describe('Table existence', () => {
    it('has all expected tables', async () => {
      await withTestTransaction(async (ctx) => {
        const tables = await ctx.query(
          `SELECT table_name FROM information_schema.tables 
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
        )
        const tableNames = tables.map((t: any) => t.table_name)

        for (const expected of EXPECTED_TABLES) {
          expect(tableNames, `Missing table: ${expected}`).toContain(expected)
        }
      })
    })
  })

  describe('Profiles table', () => {
    it('has required columns', async () => {
      await withTestTransaction(async (ctx) => {
        const columns = await ctx.query(
          `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns 
           WHERE table_schema = 'public' AND table_name = 'profiles'`,
        )
        const colNames = columns.map((c: any) => c.column_name)

        expect(colNames).toContain('id')
        expect(colNames).toContain('auth_user_id')
        expect(colNames).toContain('username')
        expect(colNames).toContain('display_name')
        expect(colNames).toContain('avatar_url')
        expect(colNames).toContain('bio')
        expect(colNames).toContain('domain')
        expect(colNames).toContain('is_admin')
        expect(colNames).toContain('created_at')
      })
    })
  })

  describe('Servers table', () => {
    it('has required columns', async () => {
      await withTestTransaction(async (ctx) => {
        const columns = await ctx.query(
          `SELECT column_name FROM information_schema.columns 
           WHERE table_schema = 'public' AND table_name = 'servers'`,
        )
        const colNames = columns.map((c: any) => c.column_name)

        expect(colNames).toContain('id')
        expect(colNames).toContain('name')
        expect(colNames).toContain('owner')
        expect(colNames).toContain('created_at')
      })
    })
  })

  describe('Foreign keys', () => {
    it('has foreign keys on messages table', async () => {
      await withTestTransaction(async (ctx) => {
        const fks = await ctx.query(
          `SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
           JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
           WHERE tc.table_name = 'messages' AND tc.constraint_type = 'FOREIGN KEY'`,
        )
        const fkColumns = fks.map((f: any) => f.column_name)
        expect(fkColumns).toContain('user_id')
      })
    })
  })

  describe('Functions', () => {
    it('has expected RPC functions', async () => {
      await withTestTransaction(async (ctx) => {
        const functions = await ctx.query(
          `SELECT routine_name FROM information_schema.routines
           WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'`,
        )
        const funcNames = functions.map((f: any) => f.routine_name)

        for (const expected of EXPECTED_FUNCTIONS) {
          expect(funcNames, `Missing function: ${expected}`).toContain(expected)
        }
      })
    })
  })

  describe('RLS is enabled', () => {
    it('profiles table has RLS enabled', async () => {
      await withTestTransaction(async (ctx) => {
        const result = await ctx.queryOne(
          `SELECT relrowsecurity FROM pg_class WHERE relname = 'profiles'`,
        )
        expect(result?.relrowsecurity).toBe(true)
      })
    })

    it('messages table has RLS enabled', async () => {
      await withTestTransaction(async (ctx) => {
        const result = await ctx.queryOne(
          `SELECT relrowsecurity FROM pg_class WHERE relname = 'messages'`,
        )
        expect(result?.relrowsecurity).toBe(true)
      })
    })
  })
})
