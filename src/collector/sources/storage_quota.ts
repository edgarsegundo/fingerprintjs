import { withTimeout } from '../utils'

const estimateTimeoutMs = 1500

/**
 * The storage quota of the origin in bytes. Only the quota is collected, not the usage: the usage describes what
 * the site stored and isn't needed. The quota depends on the disk size and drops sharply in private browsing in
 * some browsers, so the server can use it as an evidence of the private mode. The exact value changes
 * little over time, but the server should compare it in buckets.
 */
export default function getStorageQuota(): Promise<number | undefined> | undefined {
  const storage = navigator.storage
  if (!storage || typeof storage.estimate !== 'function') {
    return undefined
  }
  return withTimeout(storage.estimate(), estimateTimeoutMs).then((estimate) => estimate.quota)
}
