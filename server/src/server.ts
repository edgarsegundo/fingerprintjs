import { readFileSync } from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import net from 'node:net'

import { createApp } from './app'
import { Config } from './config'
import { IdentityEngine } from './identity/engine'
import { MemoryIdentityStore } from './identity/memory_store'
import { defaultModel, Model, parseModel } from './identity/model'
import { SqliteIdentityStore } from './identity/sqlite_store'
import type { IdentityStore } from './identity/store'
import { CidrListProvider, IpIntelProvider, noIpIntel } from './net/ip_intel'
import { loadCalibrationFiles } from './static_files'
import { SqliteEventStore } from './store/sqlite'
import { EventStore } from './store/types'
import { ConnectionRegistry, createTlsFront } from './tls/tls_front'

export interface RunningServer {
  /** The public port, useful when 0 was asked */
  port: number
  store: EventStore
  /** The matching engine, or `undefined` when it is turned off */
  identity?: IdentityEngine
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
  const store = options.store ?? new SqliteEventStore(config.databasePath)
  const intel = options.intel ?? (config.ipLists.length > 0 ? CidrListProvider.fromFiles(config.ipLists) : noIpIntel)
  const registry = new ConnectionRegistry()
  const staticFiles = config.calibrationDir ? loadCalibrationFiles(config.calibrationDir) : undefined

  let identityStore: IdentityStore | undefined
  let identity: IdentityEngine | undefined
  if (config.identity.enabled) {
    // The identity tables live in the same file as the events when the store is SQLite
    identityStore =
      store instanceof SqliteEventStore
        ? new SqliteIdentityStore(store.connection)
        : new MemoryIdentityStore((tenantId, requestId) => store.getEvent(tenantId, requestId) !== undefined)
    const model =
      options.model ??
      (config.identity.modelFile
        ? parseModel(JSON.parse(readFileSync(config.identity.modelFile, 'utf8')))
        : defaultModel())
    identity = new IdentityEngine(identityStore, model)
    options.log?.({ route: 'identity_ready', calibrated: model.calibrated })
  }
  const app = createApp({ config, store, intel, registry, staticFiles, identity, log: options.log })

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
    port = await listen(front, options.port ?? config.listen.port, config.listen.host)
    servers.push(front, inner)
  } else {
    const plain = http.createServer(app)
    plain.headersTimeout = 15_000
    plain.requestTimeout = 30_000
    plain.keepAliveTimeout = 5_000
    port = await listen(plain, options.port ?? config.listen.port, config.listen.host)
    servers.push(plain)
  }

  // Retention: events older than the configured period are deleted, once at start and then every hour
  const purge = () => {
    const deleted = store.purge(Date.now(), config.retentionDays * day)
    // A device with no event left is forgotten too
    const devices = identityStore ? identityStore.removeOrphans() : 0
    options.log?.({ route: 'purge', ...deleted, devices })
  }
  purge()
  const purgeTimer = setInterval(purge, hour)
  purgeTimer.unref()

  return {
    port,
    store,
    identity,
    reloadCertificates: () => reloadCertificates(),
    async close() {
      clearInterval(purgeTimer)
      clearInterval(certTimer)
      for (const server of servers) {
        await close(server)
      }
      store.close()
    },
  }
}
