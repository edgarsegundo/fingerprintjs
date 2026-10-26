/** Why the collector of a page did not do its job, as told by the loader that runs in the visitor's browser */
export const reportReasons = [
  'ok',
  'script_unreachable',
  'script_blocked',
  'script_broken',
  'request_unreachable',
  'request_blocked',
  'timeout',
  'server_refused',
  'server_error',
  'collect_error',
] as const
export type ReportReason = typeof reportReasons[number]

export const reportPhases = ['script', 'nonce', 'collect', 'send'] as const
export type ReportPhase = typeof reportPhases[number]

export const probeResults = ['reachable', 'unreachable', 'skipped'] as const
export type ProbeResult = typeof probeResults[number]

export const connectionTypes = ['slow-2g', '2g', '3g', '4g'] as const
export type ConnectionType = typeof connectionTypes[number]

/** The only fields that are ever kept. Whatever else arrives in the body is dropped, not stored. */
export interface Report {
  reason: ReportReason
  phase: ReportPhase
  probe: ProbeResult
  /** The HTTP status when the server answered with a refusal or an error */
  status?: number
  elapsedMs: number
  online?: boolean
  connection?: ConnectionType
  /** The public key of the tenant, only to tell sites apart when one receiver serves several */
  site?: string
}

const maxElapsedMs = 10 * 60 * 1000
const sitePattern = /^pk_[A-Za-z0-9_-]{4,64}$/

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value)

/**
 * Checks the body of a report. The shape is strict on purpose: the endpoint is public and anyone can post to it, so
 * every field is checked against a closed list or a range, and nothing that was not asked for is kept.
 * Returns `undefined` for anything that is not a report of version 1.
 */
export function parseReport(input: unknown): Report | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined
  }
  const raw = input as Record<string, unknown>
  if (raw.v !== 1 || !isOneOf(reportReasons, raw.reason) || !isOneOf(reportPhases, raw.phase)) {
    return undefined
  }
  if (!isOneOf(probeResults, raw.probe)) {
    return undefined
  }
  const elapsed = raw.elapsedMs
  if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > maxElapsedMs) {
    return undefined
  }
  const report: Report = {
    reason: raw.reason,
    phase: raw.phase,
    probe: raw.probe,
    elapsedMs: Math.round(elapsed),
  }
  if (raw.status !== undefined) {
    if (typeof raw.status !== 'number' || !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599) {
      return undefined
    }
    report.status = raw.status
  }
  if (raw.online !== undefined) {
    if (typeof raw.online !== 'boolean') {
      return undefined
    }
    report.online = raw.online
  }
  if (raw.connection !== undefined) {
    // A connection type this list doesn't know is not worth refusing the whole report for
    if (isOneOf(connectionTypes, raw.connection)) {
      report.connection = raw.connection
    }
  }
  if (raw.site !== undefined) {
    if (typeof raw.site !== 'string' || !sitePattern.test(raw.site)) {
      return undefined
    }
    report.site = raw.site
  }
  return report
}

export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'samsung' | 'opera' | 'other'

export interface BrowserHint {
  family: BrowserFamily
  mobile: boolean
}

/**
 * The family of the browser and whether it is a phone, from the `User-Agent`. The header is read and thrown away:
 * it is a fingerprinting signal of its own, and only these two coarse facts are kept. It is a hint, as the header can
 * say anything.
 */
export function browserHint(userAgent: string | undefined): BrowserHint {
  const ua = (userAgent ?? '').slice(0, 512)
  const mobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua)
  let family: BrowserFamily = 'other'
  if (/Edg(e|A|iOS)?\//.test(ua)) {
    family = 'edge'
  } else if (/OPR\/|Opera/.test(ua)) {
    family = 'opera'
  } else if (/SamsungBrowser\//.test(ua)) {
    family = 'samsung'
  } else if (/Firefox\/|FxiOS\//.test(ua)) {
    family = 'firefox'
  } else if (/Chrome\/|CriOS\//.test(ua)) {
    family = 'chrome'
  } else if (/Safari\//.test(ua)) {
    family = 'safari'
  }
  return { family, mobile }
}
