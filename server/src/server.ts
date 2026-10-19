import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'

import { createApp } from './app'
import { Config } from './config'
import { IdentityEngine } from './identity/engine'
import { defaultModel, Model } from './identity/model'
import { ModelCatalog } from './identity/tuning'
import { createServerMetrics } from './metrics'
import { CrawlerVerifier } from './net/bots'
import { CompositeIntel, GeoProvider, loadCountryTable } from './net/geo'
import { CidrListProvider, IpIntelProvider, noIpIntel } from './net/ip_intel'
import { loadZoneTab } from './net/timezones'
import { SettingsRegistry } from './settings/settings'
import { collectorFiles, dashboardFiles, loadCalibrationFiles, StaticFile } from './static_files'
import { openStorage, storageAround } from './storage'
import { EventStore } from './store/types'
import { ConnectionRegistry, createTlsFront } from './tls/tls_front'
import { WebhookDispatcher } from './webhooks/dispatcher'

export interface RunningServer {
  /** The public port, useful when 0 was asked */
  port: number
  store: EventStore
  /**
   * Puts a new configuration to work without restarting: tenants, keys and every setting.
   * If it has a problem, it throws
   * and the old one stays. The address, TLS, trusted proxies and database path are read only at start.
   */
  reloadConfig(next: Config): Promise<void>
  /** The matching engine. Each tenant turns it on or off with its `identity.enabled`. */
  identity: IdentityEngine
  /**
   * Reads the certificate and key again and uses them for new connections if they changed.
   * Returns `true` if it switched. A failed read (for example a half-renewed pair) keeps the old ones.
   */
  reloadCertificates(): boolean
  close(): Promise<void>
}

export interface StartOptions {
  /** Overrides `config.listen.port`. Use 0 for any free port. */
  port?: number
  store?: EventStore
  intel?: IpIntelProvider
  /** Overrides the model that the configuration points to */
  model?: Model
  /** The clock, in ms. For tests that need to move through months. */
  now?: () => number
  /** How often the queue of webhooks is looked at, in ms. Default: 1 second. */
  webhookIntervalMs?: number
  /** How often the certificate files are checked for a renewal, in ms. Default: 10 minutes. */
  certCheckIntervalMs?: number
  log?: (entry: Record<string, unknown>) => void
}

const hour = 60 * 60 * 1000
const day = 24 * hour

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve((server.address() as net.AddressInfo).port))
  })
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    ;(server as http.Server).closeAllConnections?.()
  })
}

/**
 * Starts the server. Two modes:
 * - without `tls`: plain HTTP, meant to sit behind a proxy that terminates TLS (and that may tell the JA4 by header);
 * - with `tls`: this process terminates TLS itself. A small TCP front reads the ClientHello of each connection
 *   to compute the JA4, then passes the bytes to an inner HTTPS/HTTP2 server that listens on the loopback only.
 */
export async function startServer(config: Config, options: StartOptions = {}): Promise<RunningServer> {
  const storage = options.store ? storageAround(options.store) : await openStorage(config)
  const store = storage.events
  const intel =
    options.intel ??
    new CompositeIntel([
      config.ipLists.length > 0 ? CidrListProvider.fromFiles(config.ipLists) : noIpIntel,
      config.ipGeoFile ? new GeoProvider(loadCountryTable(config.ipGeoFile)) : noIpIntel,
    ])
  const timezones = config.timezoneTable ? loadZoneTab(config.timezoneTable) : undefined
  const registry = new ConnectionRegistry()
  const staticFiles: Record<string, StaticFile> = {
    ...(config.calibrationDir ? loadCalibrationFiles(config.calibrationDir) : {}),
    ...(config.dashboard ? dashboardFiles() : {}),
  }
  if (config.collectorFile) {
    const collector = collectorFiles(config.collectorFile, config.collectorPath)
    if (config.collectorPath in staticFiles) {
      throw new Error(`Config: collectorPath "${config.collectorPath}" is already served by another file`)
    }
    Object.assign(staticFiles, collector)
    // The hash goes in the `integrity` attribute of the script tag, so that a changed file is not run
    const sha384 = createHash('sha384').update(collector[config.collectorPath].body).digest('base64')
    options.log?.({ route: 'collector_ready', path: config.collectorPath, integrity: `sha384-${sha384}` })
  }

  // The engine always exists: each tenant turns it on or off with `identity.enabled`
  const identityStore = storage.identity
  const webhookQueue = storage.webhooks
  const auditLog = storage.audit
  const tenantStore = storage.tenants
  const usage = storage.usage
  const graph = storage.graph
  const metrics = createServerMetrics()
  const startedAt = Date.now()
  metrics.gauge('fp_process_uptime_seconds', 'Seconds since the process started.', () => [
    { labels: {}, value: Math.round((Date.now() - startedAt) / 1000) },
  ])
  metrics.gauge('fp_process_memory_bytes', 'Memory of the process, by kind.', () => {
    const memory = process.memoryUsage()
    return [
      { labels: { kind: 'rss' }, value: memory.rss },
      { labels: { kind: 'heap_used' }, value: memory.heapUsed },
    ]
  })
  metrics.gauge('fp_webhook_pending', 'Webhook deliveries waiting to be sent.', async () => [
    { labels: {}, value: (await webhookQueue.backlog((options.now ?? Date.now)())).pending },
  ])
  metrics.gauge('fp_webhook_oldest_due_seconds', 'How long the oldest due webhook delivery has waited.', async () => [
    { labels: {}, value: Math.round((await webhookQueue.backlog((options.now ?? Date.now)())).oldestDueAgeMs / 1000) },
  ])
  metrics.gauge('fp_tenants', 'Tenants that can use the server.', () => [
    { labels: {}, value: settings.tenants.all().length },
  ])
  const baseModel = options.model ?? defaultModel()
  const identity = new IdentityEngine(identityStore, baseModel)
  const models = new ModelCatalog(baseModel)
  const settings = new SettingsRegistry(config, tenantStore)
  await settings.load()
  // A wrong model file is found now, not at the first visit of the tenant that uses it
  models.preload(settings.tenants.all().map((tenant) => settings.for(tenant.id).identity))
  options.log?.({ route: 'identity_ready', calibrated: baseModel.calibrated })
  if (config.sharedGraph.enabled) {
    options.log?.({
      route: 'shared_graph_on',
      note: `Tenants that join share counts of devices. Legal opinion: ${config.sharedGraph.legalOpinionRef}`,
    })
  }
  const botSettings = settings.global().bots
  const crawlers = new CrawlerVerifier({
    maxConcurrent: botSettings.maxConcurrent,
    maxCacheEntries: botSettings.cacheEntries,
  })
  const app = createApp({
    config,
    settings,
    store,
    intel,
    registry,
    staticFiles,
    identity,
    crawlers,
    sharedLimits: storage.sharedLimits,
    models,
    timezones,
    webhooks: webhookQueue,
    audit: auditLog,
    graph,
    usage,
    metrics,
    ready: async () => {
      const lag = (await webhookQueue.backlog((options.now ?? Date.now)())).oldestDueAgeMs
      if (lag > 10 * 60 * 1000) {
        throw new Error(`The oldest webhook due has waited ${Math.round(lag / 1000)} seconds`)
      }
    },
    tenantStore,
    now: options.now,
    log: options.log,
  })
  const dispatcher = new WebhookDispatcher({
    onOutcome: (outcome) => metrics.inc('fp_webhook_deliveries_total', { result: outcome }),
    queue: webhookQueue,
    settings,
    usage,
    now: options.now,
    log: options.log,
  })
  dispatcher.start(options.webhookIntervalMs)

  const servers: net.Server[] = []
  let port: number
  let reloadCertificates = (): boolean => false
  let certTimer: ReturnType<typeof setInterval> | undefined

  if (config.tls) {
    // `app` is written for the common part of both request classes, which TypeScript can't see through their overloads
    const { keyFile, certFile } = config.tls
    let currentKey = readFileSync(keyFile)
    let currentCert = readFileSync(certFile)
    const inner = http2.createSecureServer({ key: currentKey, cert: currentCert, allowHTTP1: true }, app as never)
    reloadCertificates = () => {
      try {
        const key = readFileSync(keyFile)
        const cert = readFileSync(certFile)
        if (key.equals(currentKey) && cert.equals(currentCert)) {
          return false
        }
        // Throws if the key and the certificate do not belong together, which happens in the middle of a renewal
        inner.setSecureContext({ key, cert })
        currentKey = key
        currentCert = cert
        options.log?.({ route: 'certificates_reloaded' })
        return true
      } catch (error) {
        options.log?.({
          route: 'certificates_reload_failed',
          error: error instanceof Error ? error.message : 'unknown',
        })
        return false
      }
    }
    certTimer = setInterval(() => reloadCertificates(), options.certCheckIntervalMs ?? 10 * 60 * 1000)
    certTimer.unref()
    inner.setTimeout(30_000)
    const innerPort = await listen(inner, 0, '127.0.0.1')
    const front = createTlsFront({ innerPort, registry })
    front.maxConnections = config.maxConnections
    port = await listen(front, options.port ?? config.listen.port, config.listen.host)
    servers.push(front, inner)
  } else {
    const plain = http.createServer(app)
    plain.headersTimeout = 15_000
    plain.requestTimeout = 30_000
    plain.keepAliveTimeout = 5_000
    plain.maxConnections = config.maxConnections
    port = await listen(plain, options.port ?? config.listen.port, config.listen.host)
    servers.push(plain)
  }

  // Retention: events older than the configured period are deleted, once at start and then every hour
  let purging: Promise<void> | undefined
  const purge = (): Promise<void> => {
    // A pass that is still running is not started again
    purging ??= (async () => {
      // Each tenant keeps its events for as long as its own settings say
      const now = (options.now ?? Date.now)()
      let events = 0
      let deliveries = 0
      let audits = 0
      for (const tenant of settings.tenants.all()) {
        const s = settings.for(tenant.id)
        events += await store.purgeTenant(tenant.id, now, s.retention.eventsDays * day)
        deliveries += await webhookQueue.purgeTenant(
          tenant.id,
          now - s.webhooks.keepDoneHours * hour,
          now - s.webhooks.keepFailedDays * day,
        )
        audits += await auditLog.purgeTenant(tenant.id, now - s.audit.retentionDays * day)
      }
      // What was given to the shared graph is kept for less time than the events, whatever the tenant wishes
      const edges = await graph.purge(now - config.sharedGraph.retentionDays * day)
      const nonces = await store.purgeNonces(now)
      // The counters of rate limits only matter for the window they belong to; two minutes back is more than enough
      await storage.sharedLimits?.purge(now - 2 * 60 * 1000)
      // A device with no event left is forgotten too
      const devices = await identityStore.removeOrphans()
      options.log?.({ route: 'purge', events, nonces, devices, deliveries, audits, edges })
    })().finally(() => {
      purging = undefined
    })
    return purging
  }
  await purge()
  const purgeTimer = setInterval(() => {
    purge().catch((error: unknown) =>
      options.log?.({ route: 'purge_failed', error: error instanceof Error ? error.message : 'unknown' }),
    )
  }, hour)
  purgeTimer.unref()

  // Tenants made through the admin API of another instance appear here too, within this many seconds
  const refreshSeconds = settings.global().tenants.refreshSeconds
  const tenantTimer =
    refreshSeconds > 0
      ? setInterval(() => {
          settings.reloadTenants().catch((error: unknown) =>
            options.log?.({
              route: 'tenants_refresh_failed',
              error: error instanceof Error ? error.message : 'unknown',
            }),
          )
        }, refreshSeconds * 1000)
      : undefined
  tenantTimer?.unref()

  return {
    port,
    store,
    identity,
    reloadConfig: async (next) => {
      // Both are checked before anything changes, so a bad file leaves the running configuration as it was
      const probe = new SettingsRegistry(next, tenantStore)
      await probe.load()
      models.preload(probe.tenants.all().map((tenant) => probe.for(tenant.id).identity))
      await settings.reload(next)
    },
    reloadCertificates: () => reloadCertificates(),
    async close() {
      clearInterval(purgeTimer)
      clearInterval(tenantTimer)
      clearInterval(certTimer)
      for (const server of servers) {
        await close(server)
      }
      await dispatcher.stop()
      await purging?.catch(() => undefined)
      await storage.close()
    },
  }
}
