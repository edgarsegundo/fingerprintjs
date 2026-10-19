import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { IpListFile } from './net/ip_intel'
import { suggestion } from './settings/kinds'
import { SettingsRegistry } from './settings/settings'

export interface TenantConfig {
  id: string
  name?: string
  /** Goes into the page of the customer. It identifies the tenant and is not a secret. */
  publicKey: string
  /** SHA-256 (hex) of each valid secret key. The secret itself is never stored on the server. */
  secretKeySha256: string[]
  /** Origins allowed to call the browser endpoints with credentials. Empty means no browser origin check. */
  allowedOrigins: string[]
  /** Settings of this tenant only, over the defaults. See docs/configuracao.md for every setting. */
  settings: Record<string, unknown>
  /** A name from `plans`: a set of settings that sits between `defaults` and the settings of the tenant */
  plan?: string
  /** A suspended tenant cannot collect. It can still read what it has. */
  status?: 'active' | 'suspended'
  /** Where the tenant comes from: the configuration file, or the admin API */
  source?: 'file' | 'database'
}

export type DatabaseConfig =
  | { type: 'sqlite'; path: string }
  | {
      type: 'mysql'
      host: string
      port: number
      user: string
      /** In the file, if you must. Better in the environment variable named by `passwordEnv`. */
      password?: string
      passwordEnv: string
      database: string
      connectionLimit: number
      /**
       * Connections kept apart for the locks that make several instances of the server take turns on one tenant. A
       * lock holds its connection while the work runs, so these never compete with the ones that do the work.
       */
      lockConnections: number
      /** How long a visit waits for its turn on the tenant, in seconds, before it gives up */
      lockWaitSeconds: number
      /** Use TLS and check the certificate of the server */
      ssl: boolean
      connectTimeoutMs: number
    }

export interface Config {
  listen: { host: string; port: number }
  tenants: TenantConfig[]
  /** Signs the nonces. At least 32 characters. */
  nonceSecret: string
  /**
   * Settings for all tenants, over the defaults of the code. A tenant can override each one with its own `settings`.
   * The same settings can be given with the old top-level names below; they are kept so that old files still work.
   */
  defaults: Record<string, unknown>
  /** The old top-level fields that the file set explicitly, in the shape of settings. Lower than `defaults`. */
  legacySettings: Record<string, unknown>
  /** @deprecated use `defaults.nonce.ttlSeconds`. The settings of a tenant are read through `SettingsRegistry`. */
  nonceTtlSeconds: number
  /** @deprecated use `defaults.nonce.required` */
  requireNonce: boolean
  /** @deprecated use `defaults.limits.maxBodyBytes` */
  maxBodyBytes: number
  /** Ranges of the proxies whose forwarding headers are believed */
  trustedProxies: string[]
  /** Header with the client address set by the trusted proxy */
  clientIpHeader: string
  /** Header with the JA4 computed by a TLS-terminating proxy in front. Believed only from trusted proxies. */
  ja4Header?: string
  /** @deprecated use `defaults.retention.eventsDays` */
  retentionDays: number
  /** @deprecated use `defaults.limits` */
  rateLimit: { collectPerMinutePerIp: number; collectPerMinutePerTenant: number; noncePerMinutePerIp: number }
  /** Where everything is kept: a SQLite file (the default), or MySQL */
  database: DatabaseConfig
  /** The SQLite file, or `:memory:`. Kept for the tools that open a SQLite file. Use `database`. */
  databasePath: string
  /** If set, this server terminates TLS and reads the ClientHello itself (JA4) */
  tls?: { keyFile: string; certFile: string }
  /** Lists of IP ranges, one range per line, labelled with a tag */
  ipLists: IpListFile[]
  /** Secret for the keyed hashes of addresses (`privacy.ipStorage: hash`). Else one is made from `nonceSecret`. */
  ipHashSecret?: string
  /** Sets of settings that tenants can be placed on (`plan` of a tenant), between `defaults` and the tenant's own */
  plans: Record<string, Record<string, unknown>>
  /**
   * The shared graph between tenants (decision D3). OFF unless `enabled`, and it refuses to start without a reference
   * to a legal opinion. See docs/plano/privacidade/grafo-compartilhado.md before turning it on.
   */
  sharedGraph: {
    enabled: boolean
    /** Where the legal opinion that allows it is kept (a reference, such as a document number and date) */
    legalOpinionRef: string
    /** Secret of the keys of the graph, at least 32 characters, different from the other secrets */
    secret: string
    /** How long what a tenant contributed is kept, in days. Shorter than the events, on purpose. */
    retentionDays: number
    /** A count is shown only if at least this many tenants are behind it (k-anonymity). At least 2. */
    minTenants: number
  }
  /** SHA-256 (hex) of each key that may read `/metrics`. Without any, `/metrics` is off. */
  metricsKeySha256: string[]
  /**
   * Count the rate limits in the database, so that they hold across all the instances of the server that share it.
   * Needs MySQL. Off by default: each instance then counts for itself, and the real limit is the limit times the
   * number of instances.
   */
  sharedLimits: boolean
  /** The most connections held at once. More are closed at once, so that one flood cannot use all the memory. */
  maxConnections: number
  /** SHA-256 (hex) of each key that may use the admin API (`/admin/v1/...`). Without any, the admin API is off. */
  adminKeySha256: string[]
  /** CSV of IP ranges with their country (see `docs/configuracao.md`). Read at start. */
  ipGeoFile?: string
  /** The `zone.tab` of the IANA time zone database, to compare the browser time zone with the country of the IP */
  timezoneTable?: string
  /**
   * Serves the whole server under this path, such as `/fp`. For a first-party proxy that forwards `/fp/...` without
   * taking the prefix off. Without it, the server answers at the root.
   */
  basePath?: string
  /** Serves the dashboard at `/dashboard/`. It still needs a secret key to show anything. */
  dashboard: boolean
  /** The browser script (dist/fp.min.js) to serve from this server, so that it is first-party */
  collectorFile?: string
  /** Where `collectorFile` is served. A name of your choice is harder for a blocklist to learn. */
  collectorPath: string
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

/** An object that may be left out. If it is there, it must be an object: a wrong shape is never ignored. */
function optionalObject(raw: unknown, name: string): Record<string, unknown> {
  if (raw === undefined) {
    return {}
  }
  if (!isObject(raw)) {
    throw new Error(`Config: ${name} must be an object`)
  }
  return raw
}

function optionalPath(raw: unknown, name: string): string | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string' || raw === '') {
    throw new Error(`Config: ${name} must be a file path`)
  }
  return raw
}

const reservedPaths = /^\/(healthz|dashboard)(\/|$)|^\/v1\/(?!collector\.js$)/

/** A path made only of safe characters, with no `..`, no empty part and no trailing slash */
function cleanPath(raw: unknown, name: string): string | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (
    typeof raw !== 'string' ||
    !/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(raw) ||
    /(^|\/)\.{1,2}(\/|$)/.test(raw)
  ) {
    throw new Error(
      `Config: ${name} must be a path such as /fp, with letters, digits and . _ ~ - only, and no trailing slash`,
    )
  }
  return raw
}

function optionalSecret(raw: unknown, name: string): string | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string' || raw.length < 32) {
    throw new Error(`Config: ${name} must be a text of at least 32 characters`)
  }
  return raw
}

function parseSharedGraph(raw: unknown, nonceSecret: string): Config['sharedGraph'] {
  const graph = optionalObject(raw, 'sharedGraph')
  const enabled = booleanOption(graph.enabled, 'sharedGraph.enabled', false)
  const result = {
    enabled,
    legalOpinionRef: typeof graph.legalOpinionRef === 'string' ? graph.legalOpinionRef.trim() : '',
    secret: typeof graph.secret === 'string' ? graph.secret : '',
    retentionDays: positiveInt(graph.retentionDays, 'sharedGraph.retentionDays', 14),
    minTenants: positiveInt(graph.minTenants, 'sharedGraph.minTenants', 3),
  }
  if (result.retentionDays > 90) {
    throw new Error('Config: sharedGraph.retentionDays must be at most 90')
  }
  if (result.minTenants < 2 || result.minTenants > 50) {
    throw new Error('Config: sharedGraph.minTenants must be from 2 to 50: a count of one tenant would name it')
  }
  if (enabled) {
    if (result.legalOpinionRef === '' || result.legalOpinionRef.length > 200) {
      throw new Error(
        'Config: sharedGraph.enabled needs sharedGraph.legalOpinionRef (the reference of the legal opinion)',
      )
    }
    if (result.secret.length < 32 || result.secret === nonceSecret) {
      throw new Error('Config: sharedGraph.secret must be at least 32 characters and different from nonceSecret')
    }
  }
  return result
}

function parseDatabase(raw: Record<string, unknown>): DatabaseConfig {
  const given = optionalObject(raw.database, 'database')
  const type = given.type ?? 'sqlite'
  if (type === 'sqlite') {
    const path = given.path ?? raw.databasePath ?? ':memory:'
    if (typeof path !== 'string' || path === '') {
      throw new Error('Config: database.path must be the path of a file, or :memory:')
    }
    return { type: 'sqlite', path }
  }
  if (type !== 'mysql') {
    throw new Error('Config: database.type must be sqlite or mysql')
  }
  const text = (value: unknown, name: string, fallback?: string, pattern = /^[^\s'"`\\]{1,128}$/): string => {
    const chosen = value ?? fallback
    if (typeof chosen !== 'string' || !pattern.test(chosen)) {
      throw new Error(`Config: database.${name} is missing or has characters that are not allowed`)
    }
    return chosen
  }
  const ranged = (value: unknown, name: string, fallback: number, max: number): number => {
    const chosen = positiveInt(value, `database.${name}`, fallback)
    if (chosen > max) {
      throw new Error(`Config: database.${name} must be at most ${max}`)
    }
    return chosen
  }
  return {
    type: 'mysql',
    host: text(given.host, 'host', '127.0.0.1', /^[A-Za-z0-9._:-]{1,255}$/),
    port: ranged(given.port, 'port', 3306, 65535),
    user: text(given.user, 'user'),
    password: given.password === undefined ? undefined : text(given.password, 'password', undefined, /^[\s\S]{1,256}$/),
    passwordEnv: text(given.passwordEnv, 'passwordEnv', 'FP_MYSQL_PASSWORD', /^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
    database: text(given.database, 'database', undefined, /^[A-Za-z0-9_$]{1,64}$/),
    connectionLimit: ranged(given.connectionLimit, 'connectionLimit', 10, 100),
    lockConnections: ranged(given.lockConnections, 'lockConnections', 16, 100),
    lockWaitSeconds: ranged(given.lockWaitSeconds, 'lockWaitSeconds', 15, 600),
    ssl: booleanOption(given.ssl, 'database.ssl', false),
    connectTimeoutMs: ranged(given.connectTimeoutMs, 'connectTimeoutMs', 10_000, 120_000),
  }
}

function planName(raw: unknown, plans: Record<string, unknown>, name: string): string | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(plans, raw)) {
    throw new Error(
      `Config: ${name} must be the name of one of the plans${suggestion(String(raw), Object.keys(plans))}`,
    )
  }
  return raw
}

function tenantSuspended(raw: unknown, index: number): 'suspended' {
  if (raw !== 'suspended') {
    throw new Error(`Config: tenants[${index}].status must be active or suspended`)
  }
  return 'suspended'
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

/** The old top-level fields that were set in the file, written as settings so that they take part in the layers */
function legacyLayer(raw: Record<string, unknown>): Record<string, unknown> {
  const layer: Record<string, Record<string, unknown>> = {}
  const put = (section: string, name: string, value: unknown) => {
    if (value !== undefined) {
      layer[section] = { ...layer[section], [name]: value }
    }
  }
  put('nonce', 'ttlSeconds', raw.nonceTtlSeconds)
  put('nonce', 'required', raw.requireNonce)
  put('limits', 'maxBodyBytes', raw.maxBodyBytes)
  put('retention', 'eventsDays', raw.retentionDays)
  if (isObject(raw.rateLimit)) {
    put('limits', 'collectPerMinutePerIp', raw.rateLimit.collectPerMinutePerIp)
    put('limits', 'collectPerMinutePerTenant', raw.rateLimit.collectPerMinutePerTenant)
    put('limits', 'noncePerMinutePerIp', raw.rateLimit.noncePerMinutePerIp)
  }
  if (isObject(raw.identity)) {
    put('identity', 'enabled', raw.identity.enabled)
    put('identity', 'modelFile', raw.identity.modelFile)
  }
  return layer
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

  const adminKeys = stringList(raw.adminKeySha256, 'adminKeySha256')
  if (adminKeys.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error('Config: adminKeySha256 must list SHA-256 hashes in lower-case hex')
  }
  // Tenants may all come from the admin API, but then there has to be a way to use it
  if (!Array.isArray(raw.tenants) || (raw.tenants.length === 0 && adminKeys.length === 0)) {
    throw new Error('Config: tenants must be a non-empty list (or leave it empty and set adminKeySha256)')
  }
  const metricsKeys = stringList(raw.metricsKeySha256, 'metricsKeySha256')
  if (metricsKeys.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error('Config: metricsKeySha256 must list SHA-256 hashes in lower-case hex')
  }
  const plans = optionalObject(raw.plans, 'plans')
  for (const [name, layer] of Object.entries(plans)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name) || !isObject(layer)) {
      throw new Error(
        `Config: plans.${name.slice(0, 40)} must have a name of lower-case letters, digits, _ or - and be an object`,
      )
    }
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
      settings: optionalObject(item.settings, `tenants[${index}].settings`),
      plan: planName(item.plan, plans, `tenants[${index}].plan`),
      status: item.status === undefined || item.status === 'active' ? 'active' : tenantSuspended(item.status, index),
      source: 'file',
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

  const database = parseDatabase(raw)
  const ipLists = raw.ipLists === undefined ? [] : raw.ipLists
  if (
    !Array.isArray(ipLists) ||
    ipLists.some((item) => !isObject(item) || typeof item.tag !== 'string' || typeof item.file !== 'string')
  ) {
    throw new Error('Config: ipLists must be a list of { tag, file, ranges? }')
  }
  const lists = (ipLists as Array<Record<string, unknown>>).map((item, index): IpListFile => {
    const where = `ipLists[${index}]`
    if (item.ranges === undefined) {
      return { tag: item.tag as string, file: item.file as string }
    }
    if (!isObject(item.ranges)) {
      throw new Error(`Config: ${where}.ranges must be an object`)
    }
    const column = (value: unknown, name: string): number => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 50) {
        throw new Error(`Config: ${where}.ranges.${name} must be a column number from 0 to 50`)
      }
      return value
    }
    const given = item.ranges as Record<string, unknown>
    const match = given.match
    if (match !== undefined) {
      if (
        !isObject(match) ||
        !Array.isArray(match.equals) ||
        match.equals.length === 0 ||
        match.equals.some((value) => typeof value !== 'string')
      ) {
        throw new Error(`Config: ${where}.ranges.match must be { column, equals: [text, ...] }`)
      }
    }
    return {
      tag: item.tag as string,
      file: item.file as string,
      ranges: {
        from: column(given.from, 'from'),
        to: column(given.to, 'to'),
        numeric: booleanOption(given.numeric, `${where}.ranges.numeric`, false),
        ...(match === undefined
          ? {}
          : {
              match: {
                column: column((match as Record<string, unknown>).column, 'match.column'),
                equals: (match as { equals: string[] }).equals,
              },
            }),
      },
    }
  })

  const config: Config = {
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
    database,
    databasePath: database.type === 'sqlite' ? database.path : ':memory:',
    tls:
      tls === undefined
        ? undefined
        : { keyFile: (tls as Record<string, string>).keyFile, certFile: (tls as Record<string, string>).certFile },
    ipLists: lists,
    calibrationDir: typeof raw.calibrationDir === 'string' ? raw.calibrationDir : undefined,
    ipHashSecret: optionalSecret(raw.ipHashSecret, 'ipHashSecret'),
    basePath: cleanPath(raw.basePath, 'basePath'),
    dashboard: booleanOption(raw.dashboard, 'dashboard', false),
    collectorFile: optionalPath(raw.collectorFile, 'collectorFile'),
    collectorPath: cleanPath(raw.collectorPath, 'collectorPath') ?? '/v1/collector.js',
    ipGeoFile: optionalPath(raw.ipGeoFile, 'ipGeoFile'),
    timezoneTable: optionalPath(raw.timezoneTable, 'timezoneTable'),
    identity: {
      enabled: booleanOption(identity.enabled, 'identity.enabled', true),
      modelFile: typeof identity.modelFile === 'string' ? identity.modelFile : undefined,
    },
    plans: plans as Config['plans'],
    adminKeySha256: adminKeys,
    metricsKeySha256: metricsKeys,
    sharedGraph: parseSharedGraph(raw.sharedGraph, nonceSecret),
    sharedLimits: booleanOption(raw.sharedLimits, 'sharedLimits', false),
    maxConnections: positiveInt(raw.maxConnections, 'maxConnections', 10_000),
    defaults: optionalObject(raw.defaults, 'defaults'),
    legacySettings: legacyLayer(raw),
  }

  if (config.sharedLimits && config.database.type !== 'mysql') {
    throw new Error('Config: sharedLimits needs database.type mysql, because the limits are counted in the database')
  }
  if (reservedPaths.test(config.collectorPath)) {
    throw new Error(`Config: collectorPath "${config.collectorPath}" is used by the server itself; choose another`)
  }

  // Every setting, of every tenant and plan, is checked now: a server must not start with one that would fail later
  const registry = new SettingsRegistry(config)
  const problems: string[] = []
  for (const scope of [
    undefined,
    ...config.tenants.map((tenant) => tenant.id),
    ...Object.keys(config.plans).map((plan) => ({ plan })),
  ]) {
    try {
      if (scope === undefined) {
        registry.global()
      } else if (typeof scope === 'string') {
        registry.for(scope)
      } else {
        registry.forPlan(scope.plan)
      }
    } catch (error) {
      problems.push((error instanceof Error ? error.message : String(error)).replace(/^Config: /, ''))
    }
  }
  if (problems.length > 0) {
    throw new Error(`Config: ${[...new Set(problems)].join('; ')}`)
  }
  return config
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
