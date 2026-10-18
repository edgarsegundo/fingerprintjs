import getAutomationHints from './automation_hints'
import getMediaSupport from './media_support'
import getNativeIntegrity from './native_integrity'
import getNotificationPermission from './notification_permission'
import getSpeechVoices from './speech_voices'
import getStorageQuota from './storage_quota'
import getWebGpu from './webgpu'
import getWorkerContext from './worker_context'

/**
 * The signals that exist only in the collector. They aren't part of the legacy visitor identifier, which keeps
 * `sources` (and therefore the identifiers of the original library) unchanged.
 *
 * They follow the same rules as the built-in entropy sources (see `contributing.md`): no side effects, fast, and
 * a failure of one source never affects the others. Unlike the built-in sources they aren't stabilized:
 * the collector sends raw values and the server decides which of them are stable enough to identify a visitor.
 */
/**
 * The signals that are off by default because collecting them has a visible side effect.
 * `collect({ include: [...] })` turns them on.
 *
 * - `webGpu`: asking for an adapter makes Chrome print "Failed to create WebGPU Context Provider" in the console
 *   when the machine has no usable GPU (servers, virtual machines, blocklisted GPUs). The browser prints it itself,
 *   so the only way to avoid it is not to ask.
 */
export const optInSourceNames: readonly string[] = ['webGpu']

export const extendedSources = {
  // The asynchronous sources are at the start to run in parallel with the other sources
  workerContext: getWorkerContext,
  speechVoices: getSpeechVoices,
  webGpu: getWebGpu,
  storageQuota: getStorageQuota,
  notificationPermission: getNotificationPermission,

  mediaSupport: getMediaSupport,
  nativeIntegrity: getNativeIntegrity,
  automationHints: getAutomationHints,
}
