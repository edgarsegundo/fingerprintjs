import { suppressUnhandledRejectionWarning } from '../../utils/async'
import { isGecko } from '../../utils/browser'

const workerTimeoutMs = 2000

/**
 * Values of `navigator` and `Intl` as seen from one JavaScript context (the page or a worker).
 * Only the values that exist in both contexts are here. For example, `navigator.webdriver` isn't available
 * in workers, so it is collected by `automationHints` instead.
 */
export type ContextSnapshot = {
  userAgent: string
  platform: string
  hardwareConcurrency?: number
  deviceMemory?: number
  language?: string
  languages?: string[]
  timezone?: string
  locale?: string
  uaData?: { brands: string[]; mobile: boolean; platform: string }
}

export type WorkerSnapshot = ContextSnapshot & {
  /** The WebGL strings seen by the worker. `null` means no WebGL in the worker. */
  webgl?: { vendor: string; renderer: string; unmaskedVendor?: string; unmaskedRenderer?: string } | null
}

export type WorkerContext = {
  page: ContextSnapshot
  /** Either the worker's view, or the reason why the worker couldn't run (a CSP block is a legitimate reason) */
  worker: WorkerSnapshot | { unavailable: string }
}

/**
 * Spoofing tools often patch `navigator` only in the page, because patching workers is harder.
 * Comparing the page's view with the worker's view exposes the difference.
 *
 * The signal is raw evidence, not a verdict: the server decides what a difference means.
 * The worker code is a plain string, so that the bundler can't change it in a way that breaks it.
 * It must be kept in sync with `getPageSnapshot`.
 *
 * Note: a strict Content Security Policy without `worker-src blob:` blocks the worker and the browser prints a CSP
 * error in the console. Exclude this source with the `exclude` option of `collect` if that matters.
 */
const workerCode = `
self.onmessage = function (event) {
  var n = self.navigator
  var r = {
    userAgent: n.userAgent,
    platform: n.platform,
    hardwareConcurrency: n.hardwareConcurrency,
    deviceMemory: n.deviceMemory,
    language: n.language,
    languages: n.languages ? Array.prototype.slice.call(n.languages) : undefined,
  }
  try {
    var o = Intl.DateTimeFormat().resolvedOptions()
    r.timezone = o.timeZone
    r.locale = o.locale
  } catch (e) {}
  try {
    var d = n.userAgentData
    if (d) {
      r.uaData = {
        brands: d.brands.map(function (b) { return b.brand + '/' + b.version }),
        mobile: d.mobile,
        platform: d.platform,
      }
    }
  } catch (e) {}
  r.webgl = null
  try {
    if (typeof OffscreenCanvas === 'function') {
      var gl = new OffscreenCanvas(1, 1).getContext('webgl')
      if (gl) {
        r.webgl = { vendor: String(gl.getParameter(gl.VENDOR)), renderer: String(gl.getParameter(gl.RENDERER)) }
        var ext = event.data && event.data.avoidDebugRenderer ? null : gl.getExtension('WEBGL_debug_renderer_info')
        if (ext) {
          r.webgl.unmaskedVendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL))
          r.webgl.unmaskedRenderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
        }
      }
    }
  } catch (e) {}
  self.postMessage(r)
}
`

export function getPageSnapshot(): ContextSnapshot {
  const n = navigator
  const snapshot: ContextSnapshot = {
    userAgent: n.userAgent,
    platform: n.platform,
    hardwareConcurrency: n.hardwareConcurrency,
    deviceMemory: n.deviceMemory,
    language: n.language,
    languages: n.languages ? Array.prototype.slice.call(n.languages) : undefined,
  }

  try {
    const options = Intl.DateTimeFormat().resolvedOptions()
    snapshot.timezone = options.timeZone
    snapshot.locale = options.locale
  } catch {
    // Intl isn't available
  }

  const uaData = (
    n as unknown as {
      userAgentData?: { brands: Array<{ brand: string; version: string }>; mobile: boolean; platform: string }
    }
  ).userAgentData
  if (uaData) {
    snapshot.uaData = {
      brands: uaData.brands.map(({ brand, version }) => `${brand}/${version}`),
      mobile: uaData.mobile,
      platform: uaData.platform,
    }
  }

  return snapshot
}

function runWorker(): Promise<WorkerSnapshot> {
  return new Promise<WorkerSnapshot>((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }))
    let worker: Worker | undefined
    // The worker must be stopped in every outcome, otherwise a hung worker lives until the page is closed
    const finish = (settle: () => void) => {
      clearTimeout(timeoutId)
      worker?.terminate()
      URL.revokeObjectURL(url)
      settle()
    }
    const timeoutId = setTimeout(() => {
      const error = new Error(`Timed out after ${workerTimeoutMs}ms`)
      error.name = 'timeout'
      finish(() => reject(error))
    }, workerTimeoutMs)

    try {
      worker = new Worker(url)
    } catch (error) {
      finish(() => reject(error))
      return
    }

    worker.onmessage = (event: MessageEvent<WorkerSnapshot>) => finish(() => resolve(event.data))
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'worker error')))
    worker.onmessageerror = () => finish(() => reject(new Error('worker message error')))
    worker.postMessage({ avoidDebugRenderer: isGecko() })
  })
}

export default function getWorkerContext(): undefined | (() => Promise<WorkerContext>) {
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') {
    return undefined
  }

  // The worker starts in the "load" phase to run in parallel with the other sources
  const workerPromise = suppressUnhandledRejectionWarning(
    runWorker().then(
      (worker): WorkerContext['worker'] => worker,
      (error): WorkerContext['worker'] => ({
        unavailable: error instanceof Error && error.name ? error.name : 'Error',
      }),
    ),
  )

  return async () => ({ page: getPageSnapshot(), worker: await workerPromise })
}
