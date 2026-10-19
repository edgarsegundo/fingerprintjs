import { randomBytes } from 'node:crypto'

import { signatureHeader, signWebhook } from '../sdk/signature'
import type { Settings, SettingsRegistry } from '../settings/settings'
import type { UsageMeter } from '../usage/meter'

import type { Delivery, WebhookQueue } from './queue'
import { BlockedAddressError, postJson, PostOptions, PostResult } from './safe_http'

type Post = (url: string, body: string, headers: Record<string, string>, options: PostOptions) => Promise<PostResult>

export interface DispatcherOptions {
  queue: WebhookQueue
  settings: SettingsRegistry
  now?: () => number
  log?: (entry: Record<string, unknown>) => void
  /** Replaces the network call. For tests. */
  post?: Post
  /** Told of each attempt that ended a try: delivered, to be retried, or given up */
  onOutcome?: (outcome: 'delivered' | 'retry' | 'failed') => void
  /** Counts the deliveries that went through or gave up, for the usage of the tenant */
  usage?: UsageMeter
  /** How many deliveries are sent at the same time */
  concurrency?: number
}

/** Whether another attempt could help: the receiver or the network may recover, a refusal will not change */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

/**
 * The time to wait after the `attempt`-th failed attempt: the base delay doubled each time, up to the maximum.
 * The exact times are not random on purpose, so that the behavior can be tested and explained. A receiver that is
 * down for a long time still gets the deliveries spread by their own creation times.
 */
export function backoffMs(attempt: number, webhooks: Settings['webhooks']): number {
  return Math.min(webhooks.maxDelaySeconds, webhooks.baseDelaySeconds * 2 ** (attempt - 1)) * 1000
}

/**
 * Sends the deliveries that are due. One attempt per delivery per pass: a failure schedules the next one in the queue,
 * which is persistent, so nothing depends on the memory of this process.
 */
export class WebhookDispatcher {
  private readonly now: () => number
  private readonly log: (entry: Record<string, unknown>) => void
  private readonly post: Post
  private readonly inFlight = new Set<string>()
  private readonly owner = `i_${randomBytes(8).toString('hex')}`
  private readonly leaseMs = 120_000
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(private readonly options: DispatcherOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
    this.post = options.post ?? postJson
  }

  /** Sends what is due. Returns how many deliveries were attempted. */
  async tick(): Promise<number> {
    if (this.running) {
      return 0
    }
    this.running = true
    try {
      const concurrency = this.options.concurrency ?? 5
      const { queue } = this.options
      // With a queue that several instances read, each delivery is reserved before it is sent; the reservation is long
      // enough for the attempts of one pass and ends by itself if this instance dies
      let attempted = 0
      if (queue.claimDue) {
        // A batch at a time, so that the reservation of a delivery never has to outlast the attempts that come before
        // it: with a hundred reserved at once and a slow receiver, the last would be taken by another instance while
        // it still waited here
        while (attempted < 100) {
          const batch = (await queue.claimDue(this.now(), concurrency, this.owner, this.leaseMs)).filter(
            (item) => !this.inFlight.has(item.id),
          )
          if (batch.length === 0) {
            break
          }
          await Promise.all(batch.map((item) => this.attempt(item)))
          attempted += batch.length
        }
        return attempted
      }
      const due = (await queue.due(this.now(), 100)).filter((item) => !this.inFlight.has(item.id))
      for (let start = 0; start < due.length; start += concurrency) {
        const batch = due.slice(start, start + concurrency)
        await Promise.all(batch.map((item) => this.attempt(item)))
        attempted += batch.length
      }
      return attempted
    } finally {
      this.running = false
    }
  }

  private async attempt(delivery: Delivery): Promise<void> {
    const { queue } = this.options
    this.inFlight.add(delivery.id)
    try {
      const settings = this.options.settings.for(delivery.tenantId).webhooks
      const endpoint = settings.endpoints.find((item) => item.id === delivery.endpointId)
      if (!endpoint) {
        await queue.markFailed(delivery.id, this.now(), 'The endpoint is no longer in the configuration')
        this.log({
          route: 'webhook_failed',
          tenantId: delivery.tenantId,
          endpointId: delivery.endpointId,
          reason: 'removed',
        })
        return
      }
      const attempt = delivery.attempts + 1
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'fingerprint-server-webhook',
        'X-Fingerprint-Delivery': delivery.id,
        'X-Fingerprint-Attempt': String(attempt),
        [signatureHeader]: signWebhook(endpoint.secrets, delivery.body, Math.floor(this.now() / 1000)),
      }
      let failure: string
      let retryable: boolean
      try {
        const result = await this.post(endpoint.url, delivery.body, headers, {
          timeoutMs: settings.timeoutSeconds * 1000,
          allowPrivateNetworks: settings.allowPrivateNetworks,
        })
        if (result.status >= 200 && result.status < 300) {
          await queue.markDone(delivery.id, this.now())
          await this.options.usage?.add(delivery.tenantId, 'webhooksDelivered', this.now())
          this.options.onOutcome?.('delivered')
          this.log({ route: 'webhook_delivered', tenantId: delivery.tenantId, endpointId: endpoint.id, attempt })
          return
        }
        failure = `The receiver answered ${result.status}`
        retryable = isRetryable(result.status)
      } catch (error) {
        failure = error instanceof Error ? error.message : 'unknown error'
        // A blocked address is not going to be allowed by waiting. A name that resolves elsewhere later can, so it only
        // counts as final for an address that is blocked right now.
        retryable = !(error instanceof BlockedAddressError)
      }
      if (retryable && attempt < settings.maxAttempts) {
        await queue.markRetry(delivery.id, this.now() + backoffMs(attempt, settings), failure)
        this.options.onOutcome?.('retry')
        this.log({ route: 'webhook_retry', tenantId: delivery.tenantId, endpointId: endpoint.id, attempt, failure })
      } else {
        await queue.markFailed(delivery.id, this.now(), failure)
        await this.options.usage?.add(delivery.tenantId, 'webhooksFailed', this.now())
        this.options.onOutcome?.('failed')
        this.log({ route: 'webhook_failed', tenantId: delivery.tenantId, endpointId: endpoint.id, attempt, failure })
      }
    } catch (error) {
      // Not even the settings could be read. Try again later rather than lose the delivery.
      await queue.markRetry(delivery.id, this.now() + 60_000, error instanceof Error ? error.message : 'unknown error')
      this.log({
        route: 'webhook_error',
        tenantId: delivery.tenantId,
        error: error instanceof Error ? error.message : '',
      })
    } finally {
      this.inFlight.delete(delivery.id)
    }
  }

  start(intervalMs = 1000): void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.tick().catch((error: unknown) =>
          this.log({ route: 'webhook_tick_failed', error: error instanceof Error ? error.message : '' }),
        )
      }, intervalMs)
      this.timer.unref()
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
    // Let a pass that is running finish, so that the database is not closed under it
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}
