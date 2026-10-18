import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

export interface TenantConfig {
  id: string
  name?: string
  /** Goes into the page of the customer. It identifies the tenant and is not a secret. */
  publicKey: string
  /** SHA-256 (hex) of each valid secret key. The secret itself is never stored on the server. */
  secretKeySha256: string[]
  /** Origins allowed to call the browser endpoints with credentials. Empty means no browser origin check. */
  allowedOrigins: string[]
}

export interface Config {
  listen: { host: string; port: number }
  tenants: TenantConfig[]
  /** Signs the nonces. At least 32 characters. */
  nonceSecret: string
  nonceTtlSeconds: number
  requireNonce: boolean
  maxBodyBytes: number
  /** Ranges of the proxies whose forwarding headers are believed */
  trustedProxies: string[]
  /** Header with the client address set by the trusted proxy */
  clientIpHeader: string
  /** Header with the JA4 computed by a TLS-terminating proxy in front. Believed only from trusted proxies. */
  ja4Header?: string
  retentionDays: number
  rateLimit: { collectPerMinutePerIp: number; collectPerMinutePerTenant: number; noncePerMinutePerIp: number }
  /** SQLite file, or `:memory:` */
  databasePath: string
  /** If set, this server terminates TLS and reads the ClientHello itself (JA4) */
  tls?: { keyFile: string; certFile: string }
  /** Lists of IP ranges, one range per line, labelled with a tag */
  ipLists: Array<{ tag: string; file: string }>
  /** A folder with the collection page (see tools/calibration). If set, this server also serves that page. */
  calibrationDir?: string
  /** The matching engine, which gives every visit a visitor id */
  identity: {
    enabled: boolean
    /** A model file written by `fit-model`. Without one, provisional parameters are used and the answers say so. */
    modelFile?: string
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function positiveInt(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined) {
    return fallback
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`Config: ${name} must be a positive integer`)
  }
  return raw
}

/** A safety switch must be a real boolean. Something like "false" in quotes must not silently turn a check off. */
function booleanOption(raw: unknown, name: string, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback
  }
  if (typeof raw !== 'boolean') {
    throw new Error(`Config: ${name} must be true or false (without quotes)`)
  }
  return raw
}

function stringList(raw: unknown, name: string): string[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    throw new Error(`Config: ${name} must be a list of strings`)
  }
  return raw as string[]
}

/** Validates the configuration and fills the defaults. It fails loudly: a server must not start half-configured. */
export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) {
    throw new Error('Config: the file must contain a JSON object')
  }

  const nonceSecret = raw.nonceSecret
  if (typeof nonceSecret !== 'string' || nonceSecret.length < 32) {
    throw new Error('Config: nonceSecret must be a string of at least 32 characters')
  }

  if (!Array.isArray(raw.tenants) || raw.tenants.length === 0) {
    throw new Error('Config: tenants must be a non-empty list')
  }
  const tenants = raw.tenants.map((item, index): TenantConfig => {
    if (!isObject(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id)) {
      throw new Error(`Config: tenants[${index}].id must match [A-Za-z0-9_-]{1,64}`)
    }
    if (typeof item.publicKey !== 'string' || !/^pk_[A-Za-z0-9_-]{16,}$/.test(item.publicKey)) {
      throw new Error(`Config: tenants[${index}].publicKey must look like pk_...`)
    }
    const hashes = stringList(item.secretKeySha256, `tenants[${index}].secretKeySha256`)
    if (hashes.length === 0 || hashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
      throw new Error(`Config: tenants[${index}].secretKeySha256 must list SHA-256 hashes in lower-case hex`)
    }
    return {
      id: item.id,
      name: typeof item.name === 'string' ? item.name : undefined,
      publicKey: item.publicKey,
      secretKeySha256: hashes,
      allowedOrigins: stringList(item.allowedOrigins, `tenants[${index}].allowedOrigins`),
    }
  })
  for (const field of ['id', 'publicKey'] as const) {
    if (new Set(tenants.map((tenant) => tenant[field])).size !== tenants.length) {
      throw new Error(`Config: tenant ${field} values must be unique`)
    }
  }

  const listen = isObject(raw.listen) ? raw.listen : {}
  const rate = isObject(raw.rateLimit) ? raw.rateLimit : {}
  const identity = isObject(raw.identity) ? raw.identity : {}
  const tls = raw.tls
  if (tls !== undefined && (!isObject(tls) || typeof tls.keyFile !== 'string' || typeof tls.certFile !== 'string')) {
    throw new Error('Config: tls must be { keyFile, certFile }')
  }

  const ipLists = raw.ipLists === undefined ? [] : raw.ipLists
  if (
    !Array.isArray(ipLists) ||
    ipLists.some((item) => !isObject(item) || typeof item.tag !== 'string' || typeof item.file !== 'string')
  ) {
    throw new Error('Config: ipLists must be a list of { tag, file }')
  }

  return {
    listen: {
      host: typeof listen.host === 'string' ? listen.host : '127.0.0.1',
      port: positiveInt(listen.port, 'listen.port', 8080),
    },
    tenants,
    nonceSecret,
    nonceTtlSeconds: positiveInt(raw.nonceTtlSeconds, 'nonceTtlSeconds', 300),
    requireNonce: booleanOption(raw.requireNonce, 'requireNonce', true),
    maxBodyBytes: positiveInt(raw.maxBodyBytes, 'maxBodyBytes', 512 * 1024),
    trustedProxies: stringList(raw.trustedProxies, 'trustedProxies'),
    clientIpHeader: typeof raw.clientIpHeader === 'string' ? raw.clientIpHeader.toLowerCase() : 'x-forwarded-for',
    ja4Header: typeof raw.ja4Header === 'string' ? raw.ja4Header.toLowerCase() : undefined,
    retentionDays: positiveInt(raw.retentionDays, 'retentionDays', 30),
    rateLimit: {
      collectPerMinutePerIp: positiveInt(rate.collectPerMinutePerIp, 'rateLimit.collectPerMinutePerIp', 30),
      collectPerMinutePerTenant: positiveInt(
        rate.collectPerMinutePerTenant,
        'rateLimit.collectPerMinutePerTenant',
        6000,
      ),
      noncePerMinutePerIp: positiveInt(rate.noncePerMinutePerIp, 'rateLimit.noncePerMinutePerIp', 60),
    },
    databasePath: typeof raw.databasePath === 'string' ? raw.databasePath : ':memory:',
    tls:
      tls === undefined
        ? undefined
        : { keyFile: (tls as Record<string, string>).keyFile, certFile: (tls as Record<string, string>).certFile },
    ipLists: ipLists as Array<{ tag: string; file: string }>,
    calibrationDir: typeof raw.calibrationDir === 'string' ? raw.calibrationDir : undefined,
    identity: {
      enabled: booleanOption(identity.enabled, 'identity.enabled', true),
      modelFile: typeof identity.modelFile === 'string' ? identity.modelFile : undefined,
    },
  }
}

export function loadConfig(file: string): Config {
  return parseConfig(JSON.parse(readFileSync(file, 'utf8')))
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

export function findTenantByPublicKey(config: Config, publicKey: string | null | undefined): TenantConfig | undefined {
  return publicKey ? config.tenants.find((tenant) => tenant.publicKey === publicKey) : undefined
}

/** Finds the tenant that owns a secret key. The comparison takes the same time for any wrong key. */
export function authenticateSecret(config: Config, secret: string): TenantConfig | undefined {
  const given = Buffer.from(sha256Hex(secret), 'hex')
  let found: TenantConfig | undefined
  for (const tenant of config.tenants) {
    for (const stored of tenant.secretKeySha256) {
      if (timingSafeEqual(given, Buffer.from(stored, 'hex'))) {
        found = tenant
      }
    }
  }
  return found
}
