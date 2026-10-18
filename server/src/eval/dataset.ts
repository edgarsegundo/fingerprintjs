import { createHmac, randomBytes } from 'node:crypto'

import type { SerializedSignal } from '../ingest/validate'
import type { StoredEvent } from '../store/types'

/** What the evaluation needs from one visit. It is a copy, not a view, so a dataset file is self-contained. */
export interface EvalEvent {
  requestId: string
  /** Server time in ms */
  receivedAt: number
  /** The truth: visits with the same label are the same device. It comes from `linkedId`. */
  label: string
  /** The built-in components. Hashing them gives the visitor id of the original library. */
  components: Record<string, SerializedSignal>
  extended: Record<string, SerializedSignal>
  network: {
    /** A keyed hash of the address, or the address itself when the export was asked to keep it */
    ip?: string
    ipPrefix?: string
    ja4?: string
    /** The unhashed lists behind the JA4 (ciphers, extensions, signature algorithms). Not personal data. */
    ja4r?: string
    headerFp?: string
    http2Fp?: string
    viaProxy: boolean
    httpVersion: string
    ipTags: string[]
  }
  userAgent?: string
}

export interface DatasetMeta {
  format: 1
  /** `synthetic` data is made up by a program and says nothing about real accuracy */
  source: 'export' | 'synthetic'
  createdAt: number
  tenantId?: string
  /** True when addresses were replaced by keyed hashes */
  ipPseudonymized: boolean
  note?: string
}

export interface Dataset {
  meta: DatasetMeta
  events: EvalEvent[]
}

export function serializeDataset(dataset: Dataset): string {
  const lines = [JSON.stringify({ type: 'meta', ...dataset.meta })]
  for (const event of dataset.events) {
    lines.push(JSON.stringify({ type: 'event', ...event }))
  }
  return `${lines.join('\n')}\n`
}

export function parseDataset(text: string): Dataset {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) {
    throw new Error('The dataset file is empty')
  }
  const first = JSON.parse(lines[0])
  if (first.type !== 'meta' || first.format !== 1) {
    throw new Error('The first line of the dataset must be { "type": "meta", "format": 1, ... }')
  }
  const meta = { ...first }
  delete meta.type
  const events: EvalEvent[] = []
  for (const [index, line] of lines.slice(1).entries()) {
    const parsed = JSON.parse(line)
    if (parsed.type !== 'event' || typeof parsed.label !== 'string' || typeof parsed.receivedAt !== 'number') {
      throw new Error(`Line ${index + 2} of the dataset is not a valid event`)
    }
    const event = { ...parsed }
    delete event.type
    events.push(event as EvalEvent)
  }
  return { meta: meta as DatasetMeta, events }
}

export interface ExportOptions {
  /** Keep the real addresses. By default they are replaced by hashes that cannot be reversed. */
  keepIp?: boolean
  tenantId?: string
  now?: number
  /** The key of the address hashes. Pass the same key for every page of one export; by default a new one is made. */
  hashKey?: Buffer
}

/**
 * Turns stored events into a dataset. Events without a `linkedId` are left out, because without a label they cannot
 * be used to measure anything; the number left out is returned so that it can be reported.
 * Addresses are hashed with a key that is made for this export and thrown away, so the file does not contain them
 * and two exports cannot be joined on them.
 */
export function buildDataset(
  events: readonly StoredEvent[],
  options: ExportOptions = {},
): { dataset: Dataset; skipped: number } {
  const key = options.hashKey ?? randomBytes(16)
  const hide = (value: string) => `h_${createHmac('sha256', key).update(value).digest('hex').slice(0, 12)}`
  const converted: EvalEvent[] = []
  let skipped = 0

  for (const event of events) {
    const label = event.payload.linkedId
    if (label === undefined) {
      skipped++
      continue
    }
    const { network } = event
    converted.push({
      requestId: event.requestId,
      receivedAt: event.receivedAt,
      label,
      components: event.payload.components,
      extended: event.payload.extended,
      network: {
        ip: options.keepIp ? network.ip : hide(network.ip),
        ipPrefix: options.keepIp ? network.ipPrefix : hide(network.ipPrefix),
        ja4: network.tls?.ja4,
        ja4r: network.tls?.ja4_r,
        headerFp: network.headers.fp,
        http2Fp: network.http2?.fp,
        viaProxy: network.viaProxy,
        httpVersion: network.httpVersion,
        ipTags: network.ipIntel.tags,
      },
      userAgent: network.headers.values['user-agent'],
    })
  }

  return {
    dataset: {
      meta: {
        format: 1,
        source: 'export',
        createdAt: options.now ?? Date.now(),
        tenantId: options.tenantId,
        ipPseudonymized: !options.keepIp,
      },
      events: converted,
    },
    skipped,
  }
}
