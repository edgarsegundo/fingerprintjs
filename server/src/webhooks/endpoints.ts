import { isIP } from 'node:net'

import type { VisitSummary } from '../risk/assess'
import { decisionPattern } from '../risk/rules'

/** Where a tenant wants to be told about visits, and which visits */
export interface WebhookEndpoint {
  id: string
  url: string
  /** The secrets that sign the calls. Two while one is being replaced: the receiver accepts either. */
  secrets: string[]
  /** Only visits with a risk score from this on. 0 sends all, including when the risk is off. */
  minRiskScore: number
  /** Only visits whose decision is one of these. Empty sends all. */
  decisions: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** What is wrong with the list of endpoints, or `undefined` */
export function validateEndpoints(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return 'must be a list of endpoints'
  }
  if (value.length > 20) {
    return 'must have at most 20 endpoints'
  }
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return `endpoint ${index} must be an object`
    }
    const extra = Object.keys(item).filter(
      (key) => !['id', 'url', 'secrets', 'minRiskScore', 'decisions'].includes(key),
    )
    if (extra.length > 0) {
      return `endpoint ${index} has an unknown key "${extra[0].slice(0, 40)}"`
    }
    if (typeof item.id !== 'string' || !idPattern.test(item.id)) {
      return `endpoint ${index} needs an id of lower-case letters, digits, "_" or "-"`
    }
    if (seen.has(item.id)) {
      return `endpoint "${item.id}" appears twice`
    }
    seen.add(item.id)
    if (typeof item.url !== 'string' || item.url.length > 2000) {
      return `endpoint "${item.id}": url must be text`
    }
    let url: URL
    try {
      url = new URL(item.url)
    } catch {
      return `endpoint "${item.id}": url is not a valid address`
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return `endpoint "${item.id}": url must start with https:// (or http:// if webhooks.allowHttp is on)`
    }
    if (url.username !== '' || url.password !== '') {
      return `endpoint "${item.id}": url must not carry a user name or password; the call is signed instead`
    }
    if (
      !Array.isArray(item.secrets) ||
      item.secrets.length < 1 ||
      item.secrets.length > 3 ||
      item.secrets.some((secret) => typeof secret !== 'string' || secret.length < 16 || secret.length > 200)
    ) {
      return `endpoint "${item.id}": secrets must be a list of 1 to 3 texts of 16 to 200 characters`
    }
    if (
      item.minRiskScore !== undefined &&
      (typeof item.minRiskScore !== 'number' || !(item.minRiskScore >= 0 && item.minRiskScore <= 100))
    ) {
      return `endpoint "${item.id}": minRiskScore must be a number from 0 to 100`
    }
    if (
      item.decisions !== undefined &&
      (!Array.isArray(item.decisions) ||
        item.decisions.length > 20 ||
        item.decisions.some((word) => typeof word !== 'string' || !decisionPattern.test(word)))
    ) {
      return `endpoint "${item.id}": decisions must be a list of lower-case words`
    }
  }
  return undefined
}

/** The endpoints as the dispatcher uses them, with the optional fields filled */
export function normalizeEndpoints(list: readonly unknown[]): WebhookEndpoint[] {
  return list.map((item) => {
    const endpoint = item as Record<string, unknown>
    return {
      id: endpoint.id as string,
      url: endpoint.url as string,
      secrets: endpoint.secrets as string[],
      minRiskScore: (endpoint.minRiskScore as number | undefined) ?? 0,
      decisions: (endpoint.decisions as string[] | undefined) ?? [],
    }
  })
}

/** Whether a visit is one that the endpoint asked for */
export function endpointWants(endpoint: WebhookEndpoint, visit: VisitSummary): boolean {
  if (endpoint.minRiskScore > 0 && (visit.risk === null || visit.risk.score < endpoint.minRiskScore)) {
    return false
  }
  return endpoint.decisions.length === 0 || (visit.decision !== null && endpoint.decisions.includes(visit.decision))
}

/** A problem that depends on two settings: the scheme and the kind of address, against `allowHttp` and the network */
export function endpointProblems(
  endpoints: readonly WebhookEndpoint[],
  allow: { http: boolean; privateNetworks: boolean },
  isBlocked: (address: string) => boolean,
): string[] {
  const problems: string[] = []
  for (const endpoint of endpoints) {
    const url = new URL(endpoint.url)
    if (url.protocol === 'http:' && !allow.http) {
      problems.push(`webhook endpoint "${endpoint.id}" uses http://; turn on webhooks.allowHttp or use https://`)
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (!allow.privateNetworks && isIP(host) !== 0 && isBlocked(host)) {
      problems.push(
        `webhook endpoint "${endpoint.id}" points to a private address; ` +
          'turn on webhooks.allowPrivateNetworks to allow it',
      )
    }
  }
  return problems
}
