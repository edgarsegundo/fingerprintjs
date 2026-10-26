import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'

import { AsnColumns, AsnTable, loadAsnTable } from '../net/asn'
import { Cidr, parseCidr } from '../net/cidr'

import { createReceiverServer, receiverDefaults } from './receiver'
import { ReportStore } from './store'

export interface ReceiverSettings {
  db: string
  port: number
  host: string
  path?: string
  allowedOrigins: readonly string[]
  /** Addresses or ranges of the proxies whose `X-Forwarded-For` is believed */
  trustForwardedFrom: readonly string[]
  asnFile?: string
  asnColumns?: AsnColumns
  keepDays: number
  ratePerIp?: number
  rateTotal?: number
  /** File with the key of the network hash. Made on the first start if it does not exist. */
  secretFile?: string
}

export interface RunningReceiver {
  server: Server
  store: ReportStore
  port: number
  close(): Promise<void>
}

/** The key of the hash, read from its file, or made there with permission for the owner only if the file is new */
export function loadOrCreateSecret(file: string): Buffer {
  if (existsSync(file)) {
    const secret = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
    if (secret.length < 16) {
      throw new Error(`The secret file ${file} must hold at least 16 bytes in hexadecimal`)
    }
    return secret
  }
  const secret = randomBytes(32)
  writeFileSync(file, `${secret.toString('hex')}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return secret
}

export function parseTrusted(ranges: readonly string[]): Cidr[] {
  return ranges.map((range) => {
    const cidr = parseCidr(range)
    if (!cidr) {
      throw new Error(`"${range}" is not an address or a range such as 172.16.0.0/12`)
    }
    return cidr
  })
}

/** Opens the store, loads the networks, starts the server and the daily clean-up. Resolves once it listens. */
export async function startReceiver(
  settings: ReceiverSettings,
  now: () => number = Date.now,
): Promise<RunningReceiver> {
  if (!Number.isInteger(settings.keepDays) || settings.keepDays < 1 || settings.keepDays > 3650) {
    throw new Error('--keep-days must be a whole number from 1 to 3650')
  }
  let asn: AsnTable | undefined
  if (settings.asnFile !== undefined) {
    if (settings.asnColumns === undefined) {
      throw new Error(
        '--asn-file needs --asn-from (and --asn-to for first and last address columns), and --asn-number or --asn-name',
      )
    }
    asn = loadAsnTable(settings.asnFile, settings.asnColumns)
  }
  const trustedProxies = parseTrusted(settings.trustForwardedFrom)
  const secretFile = settings.secretFile ?? (settings.db === ':memory:' ? undefined : `${settings.db}.secret`)
  const secret = secretFile === undefined ? randomBytes(32) : loadOrCreateSecret(secretFile)
  const store = new ReportStore(settings.db)
  const keepMs = settings.keepDays * 86_400_000
  const purge = () => store.purge(now() - keepMs)
  purge()
  const timer = setInterval(purge, 3_600_000)
  timer.unref()

  const server = createReceiverServer({
    store,
    secret,
    path: settings.path ?? receiverDefaults.path,
    allowedOrigins: settings.allowedOrigins,
    trustedProxies,
    asn,
    ratePerIp: settings.ratePerIp,
    rateTotal: settings.rateTotal,
    now,
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(settings.port, settings.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  return {
    server,
    store,
    port: typeof address === 'object' && address ? address.port : settings.port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer)
        server.close(() => {
          store.close()
          resolve()
        })
        server.closeAllConnections()
      }),
  }
}
