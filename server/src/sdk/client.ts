/**
 * A small client for the query API of the server. It has no dependency and uses the `fetch` of Node 18 or later (or one
 * that you pass). It belongs to the backend of your site: it holds the secret key, which must never reach a browser.
 */

export interface ClientOptions {
  /** The address of the server, such as `https://fp.example.com:8443` (no path unless a proxy adds one) */
  baseUrl: string
  /** The secret key of the tenant (`sk_...`) */
  secretKey: string
  /** Milliseconds before a call gives up. Default 10000. */
  timeoutMs?: number
  /** A replacement for `fetch`, for tests or a custom agent */
  fetch?: typeof fetch
}

export interface VisitSummary {
  requestId: string
  receivedAt: number
  linkedId: string | null
  ip: string
  country: string | null
  visitorId: string | null
  matched: boolean | null
  risk: { score: number; level: 'low' | 'medium' | 'high' } | null
  decision: string | null
  tamper: { high: number; medium: number; low: number } | null
}

export interface EventPage {
  events: VisitSummary[]
  /** Pass it as `after` for the next page. `null` at the end. */
  next: string | null
}

export interface ListParams {
  /** Events from this time on: milliseconds since 1970 or an ISO date */
  since?: number | string
  /** Events before this time */
  until?: number | string
  linkedId?: string
  ip?: string
  /** Default `desc` (newest first) */
  order?: 'asc' | 'desc'
  limit?: number
  after?: string
}

export interface Explanation {
  feature: string
  outcome: 'agree' | 'disagree'
  weight: number
  probabilityWithoutIt: number
}

/** The whole answer for one visit. Fields not listed here may exist; the server may add some. */
export interface EventResult {
  requestId: string
  tenantId: string
  receivedAt: number
  identity: {
    visitorId: string
    matched: boolean
    ambiguous: boolean
    learned: boolean
    calibrated: boolean
    /** `null` until the model is calibrated on labelled data */
    probability: number | null
    provisionalProbability: number | null
    explanation: Explanation[]
    possibleLink?: { visitorId: string }
    /** Devices that look like the same machine in another browser. Evidence only: the ids are not joined. */
    sameMachine?: { links: Array<{ visitorId: string; logOdds: number; browsers: string[] }>; skipped?: 'shared_ip' }
  } | null
  tamper: { signals: Array<{ id: string; severity: string; detail: string }>; counts: Record<string, number> } | null
  risk: {
    score: number
    level: 'low' | 'medium' | 'high'
    factors: Array<{ id: string; weight: number; detail: string }>
    heuristic: true
    calibrated: false
  } | null
  decision: { action: string; ruleId: string | null; reason: string; matchedRules: string[] } | null
  [field: string]: unknown
}

export interface VisitorResult {
  visitorId: string
  firstSeen: number
  lastSeen: number
  visits: number
  events: VisitSummary[]
}

/** The server answered with an error. `status` is the HTTP status and `body` what it said. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`The server answered ${status}${typeof body === 'object' && body ? `: ${JSON.stringify(body)}` : ''}`)
  }
}

export class FingerprintClient {
  private readonly baseUrl: string
  private readonly doFetch: typeof fetch

  constructor(private readonly options: ClientOptions) {
    if (!options.secretKey.startsWith('sk_')) {
      throw new Error('The secret key looks wrong: it should start with sk_')
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.doFetch = options.fetch ?? fetch
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const params = new URLSearchParams()
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(name, String(value))
      }
    }
    const suffix = params.size > 0 ? `?${params}` : ''
    const response = await this.doFetch(`${this.baseUrl}${path}${suffix}`, {
      headers: { Authorization: `Bearer ${this.options.secretKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new ApiError(response.status, body)
    }
    return body as T
  }

  /** The whole answer for a visit, using the `requestId` that the browser sent you */
  getEvent(requestId: string): Promise<EventResult> {
    return this.get(`/v1/events/${encodeURIComponent(requestId)}`)
  }

  listEvents(params: ListParams = {}): Promise<EventPage> {
    return this.get('/v1/events', { ...params })
  }

  /** Every visit that matches, page after page, until the end. Stop reading when you have enough. */
  async *iterateEvents(params: Omit<ListParams, 'after'> = {}): AsyncGenerator<VisitSummary, void, undefined> {
    let after: string | undefined
    for (;;) {
      const page = await this.listEvents({ ...params, after })
      yield* page.events
      if (!page.next) {
        return
      }
      after = page.next
    }
  }

  getVisitor(visitorId: string, options: { limit?: number } = {}): Promise<VisitorResult> {
    return this.get(`/v1/visitors/${encodeURIComponent(visitorId)}`, { limit: options.limit })
  }
}
