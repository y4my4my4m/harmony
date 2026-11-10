import { readFileSync } from 'node:fs'
import { z } from 'zod'

const httpUrl = z.url().refine(value => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
}, 'Expected an HTTP(S) URL without credentials, query or fragment')
const matrixId = z.string().max(255).regex(/^@[^\s:\u0000-\u001f\u007f]+:[^\s/\u0000-\u001f\u007f]+$/)
const pairSchema = z.object({
  harmonyChannelId: z.uuid(),
  // Room IDs are opaque: room version 12+ IDs need not contain a homeserver suffix.
  matrixRoomId: z.string().min(2).max(255).regex(/^![^\s/]+$/),
  direction: z.enum(['both', 'to_harmony', 'to_matrix']).default('both'),
  senderMode: z.enum(['ghost', 'relay']).default('relay'),
}).strict()

export const configSchema = z.object({
  harmony: z.object({
    apiUrl: httpUrl,
    gatewayUrl: z.url().refine(value => {
      const url = new URL(value)
      return ['ws:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    }),
    // An additional source restriction, never a substitute for native per-member consent.
    allowedUserIds: z.array(z.uuid()).min(1).max(1000),
  }).strict(),
  matrix: z.object({
    homeserverUrl: httpUrl,
    serverName: z.string().regex(/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/),
    senderLocalpart: z.string().regex(/^[a-z0-9._=-]+$/).default('harmony_relay'),
    applicationServiceUrl: httpUrl,
    allowedUserIds: z.array(matrixId).min(1).max(1000),
  }).strict(),
  listen: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(9009),
  }).strict().default({ host: '127.0.0.1', port: 9009 }),
  database: z.string().min(1).default('./data/bridge.sqlite'),
  pairs: z.array(pairSchema).min(1).max(100),
}).strict().superRefine((config, context) => {
  for (const field of ['harmonyChannelId', 'matrixRoomId'] as const) {
    const values = config.pairs.map(pair => pair[field])
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: `Each ${field} may be paired only once`, path: ['pairs'] })
    }
  }
})

export type Config = z.infer<typeof configSchema>
export type Pair = Config['pairs'][number]
export interface Secrets { harmonyToken: string; asToken: string; hsToken: string }

export function loadConfig(path: string): Config {
  // Do not print parser input: config may contain personal user/room IDs.
  try { return configSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  catch { throw new Error('Invalid bridge configuration; check config.example.json and the documented schema') }
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const harmonyToken = env.HARMONY_TOKEN ?? ''
  const asToken = env.MATRIX_AS_TOKEN ?? ''
  const hsToken = env.MATRIX_HS_TOKEN ?? ''
  if (!/^harmony_bot_[a-f0-9]{64}$/.test(harmonyToken)) throw new Error('HARMONY_TOKEN must be a Harmony bot token')
  if (!/^[a-zA-Z0-9_-]{32,}$/.test(asToken) || !/^[a-zA-Z0-9_-]{32,}$/.test(hsToken) || asToken === hsToken) {
    throw new Error('MATRIX_AS_TOKEN and MATRIX_HS_TOKEN must be distinct random tokens of at least 32 URL-safe characters')
  }
  return { harmonyToken, asToken, hsToken }
}

export function botUserId(config: Config): string {
  return `@${config.matrix.senderLocalpart}:${config.matrix.serverName}`
}

export function ghostUserId(config: Config, harmonyId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(harmonyId)) throw new Error('Invalid ghost owner UUID')
  const id = `@${config.matrix.senderLocalpart}_h_${harmonyId.replaceAll('-', '').toLowerCase()}:${config.matrix.serverName}`
  if (id.length > 255) throw new Error('Ghost MXID exceeds Matrix limit')
  return id
}

export function ghostOwner(config: Config, matrixId: string): string | null {
  const prefix = `@${config.matrix.senderLocalpart}_h_`
  const suffix = `:${config.matrix.serverName}`
  if (!matrixId.startsWith(prefix) || !matrixId.endsWith(suffix)) return null
  const hex = matrixId.slice(prefix.length, -suffix.length)
  return /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null
}

export function registration(config: Config, secrets: Pick<Secrets, 'asToken' | 'hsToken'>): Record<string, unknown> {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escaped = escape(botUserId(config))
  const ghostNamespace = `^@${escape(config.matrix.senderLocalpart)}_h_[0-9a-f]{32}:${escape(config.matrix.serverName)}$`
  return {
    id: 'harmony-matrix-relay',
    url: config.matrix.applicationServiceUrl,
    as_token: secrets.asToken,
    hs_token: secrets.hsToken,
    sender_localpart: config.matrix.senderLocalpart,
    namespaces: { users: [{ exclusive: true, regex: `^${escaped}$` }, { exclusive: true, regex: ghostNamespace }], aliases: [], rooms: [] },
    rate_limited: false,
    'de.sorunome.msc2409.push_ephemeral': false,
  }
}
