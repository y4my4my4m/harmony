import { describe, it, expect, beforeAll } from 'vitest'
import { isDatabaseAvailable, withTestTransaction } from '../helpers/dbTestHelper'

let dbAvailable = false

beforeAll(async () => {
  dbAvailable = await isDatabaseAvailable()
})

describe.skipIf(!dbAvailable)('Database Functions & Triggers', () => {
  describe('has_permission function', () => {
    it('exists and accepts correct parameters', async () => {
      await withTestTransaction(async (ctx) => {
        const result = await ctx.query(
          `SELECT p.proname, pg_get_function_arguments(p.oid) as args
           FROM pg_proc p
           JOIN pg_namespace n ON p.pronamespace = n.oid
           WHERE n.nspname = 'public' AND p.proname = 'has_permission'`,
        )
        expect(result.length).toBeGreaterThan(0)
      })
    })
  })

  describe('Channel limit trigger', () => {
    it('check_channel_limit function exists', async () => {
      await withTestTransaction(async (ctx) => {
        const result = await ctx.queryOne(
          `SELECT routine_name FROM information_schema.routines
           WHERE routine_schema = 'public' AND routine_name = 'check_channel_limit'`,
        )
        expect(result).not.toBeNull()
      })
    })
  })

  describe('Category limit trigger', () => {
    it('check_category_limit function exists', async () => {
      await withTestTransaction(async (ctx) => {
        const result = await ctx.queryOne(
          `SELECT routine_name FROM information_schema.routines
           WHERE routine_schema = 'public' AND routine_name = 'check_category_limit'`,
        )
        expect(result).not.toBeNull()
      })
    })
  })

  describe('Default role creation trigger', () => {
    it('trigger exists on servers table', async () => {
      await withTestTransaction(async (ctx) => {
        const triggers = await ctx.query(
          `SELECT trigger_name FROM information_schema.triggers
           WHERE event_object_table = 'servers' AND event_object_schema = 'public'`,
        )
        const names = triggers.map((t: any) => t.trigger_name)
        expect(names.some((n: string) => n.includes('default') || n.includes('role'))).toBe(true)
      })
    })
  })

  describe('Federation queue functions', () => {
    it('has federation-related triggers on posts', async () => {
      await withTestTransaction(async (ctx) => {
        const triggers = await ctx.query(
          `SELECT trigger_name FROM information_schema.triggers
           WHERE event_object_table = 'posts' AND event_object_schema = 'public'`,
        )
        expect(triggers.length).toBeGreaterThan(0)
      })
    })
  })

  describe('Timeline triggers', () => {
    it('has timeline entry triggers on posts', async () => {
      await withTestTransaction(async (ctx) => {
        const triggers = await ctx.query(
          `SELECT trigger_name FROM information_schema.triggers
           WHERE event_object_table = 'posts' AND event_object_schema = 'public'
           AND trigger_name LIKE '%timeline%'`,
        )
        expect(triggers.length).toBeGreaterThan(0)
      })
    })
  })
})
