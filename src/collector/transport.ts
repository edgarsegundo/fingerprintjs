import { CollectPayload } from './payload'

const defaultTimeoutMs = 10000

export interface SendOptions {
  /**
   * The URL that receives the payload. Use an endpoint of your own domain (or subdomain): a first-party endpoint
   * isn't blocked by ad blockers and can set a first-party cookie.
   */
  endpoint: string
  /**
   * How long to wait for the server in milliseconds.
   * @default 10000
   */
  timeoutMs?: number
  /**
   * Whether the browser sends and accepts cookies. Use `include` if the endpoint is on another subdomain.
   * @default 'same-origin'
   */
  credentials?: RequestCredentials
  /** Extra request headers */
  headers?: Record<string, string>
  /** A custom `fetch` implementation. By default, the global `fetch` is used. */
  fetch?: typeof fetch
}

/**
 * The only thing the browser learns from the server.
 * The identification result stays on the server and the website backend reads it with the request id.
 * It keeps the decision away from a tampered browser.
 */
export interface SendResult {
  requestId: string
}

/**
 * Sends the collected signals to the server with `POST` and a JSON body.
 * Throws if the server is unreachable, answers with an error status, or doesn't return a request id.
 */
export async function send(payload: CollectPayload, options: Readonly<SendOptions>): Promise<SendResult> {
  const fetchFunction = options.fetch ?? (typeof fetch === 'function' ? fetch.bind(window) : undefined)
  if (!fetchFunction) {
    throw new Error('fetch is not available')
  }

  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(), options.timeoutMs ?? defaultTimeoutMs)

  try {
    const response = await fetchFunction(options.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify(payload),
      credentials: options.credentials ?? 'same-origin',
      signal: abortController.signal,
    })
    if (!response.ok) {
      throw new Error(`The collector endpoint answered with HTTP ${response.status}`)
    }

    const data: unknown = await response.json()
    const requestId = (data as { requestId?: unknown } | null)?.requestId
    if (typeof requestId !== 'string' || requestId === '') {
      throw new Error('The collector endpoint response has no request id')
    }
    return { requestId }
  } finally {
    clearTimeout(timeoutId)
  }
}
