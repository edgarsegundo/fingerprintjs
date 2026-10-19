import type { StoredEvent } from '../store/types'

import type { EnvironmentCheckId } from './ids'

/**
 * What the visit says about the place it comes from: a private window, a virtual machine, a graphics card made of
 * software. None of this is tampering and none of it is wrong. People use private windows to protect themselves, and
 * developers and companies run virtual machines every day. So it is reported as plain facts, and the weight in the risk
 * is zero until the tenant decides that it is worth something for their flow.
 */
export interface EnvironmentSignal {
  id: EnvironmentCheckId
  detail: string
}

export interface EnvironmentReport {
  /** What was found. An empty list means that nothing was found, not that the place is an ordinary one. */
  signals: EnvironmentSignal[]
}

export interface EnvironmentOptions {
  /** Checks that are not run */
  disabledChecks?: readonly string[]
  /** A storage quota below this many bytes is taken as a sign of a private window */
  privateQuotaBytes?: number
}

export const defaultPrivateQuotaBytes = 134_217_728

type Check = (
  event: StoredEvent,
  options: Required<Pick<EnvironmentOptions, 'privateQuotaBytes'>>,
) => EnvironmentSignal | undefined

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The name of the graphics card as the page read it, in lower case, or an empty string when it did not read one */
function rendererOf(event: StoredEvent): string {
  const signal = event.payload.components.webGlBasics
  const basics = signal && !signal.error ? signal.value : undefined
  return isObject(basics)
    ? `${String(basics.rendererUnmasked ?? '')} ${String(basics.renderer ?? '')}`.toLowerCase()
    : ''
}

const virtualMachines = /vmware|virtualbox|vbox|parallels|qemu|virtio|virgl|hyper-v/
const softwareRenderers = /swiftshader|llvmpipe|softpipe|software rasterizer|mesa offscreen|microsoft basic render/

const privateMode: Check = (event, { privateQuotaBytes }) => {
  const signal = event.payload.extended.storageQuota
  const quota = signal && !signal.error ? signal.value : undefined
  if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0 || quota >= privateQuotaBytes) {
    return undefined
  }
  return {
    id: 'private_mode_likely',
    detail: `The storage quota (${Math.round(quota / 1_048_576)} MiB) is below ${Math.round(
      privateQuotaBytes / 1_048_576,
    )} MiB, which some browsers give to a private window.`,
  }
}

const virtualMachine: Check = (event) => {
  const renderer = rendererOf(event)
  return virtualMachines.test(renderer)
    ? { id: 'virtual_machine_gpu', detail: `The graphics card is a virtual one (${renderer.trim().slice(0, 80)}).` }
    : undefined
}

const softwareRenderer: Check = (event) => {
  const renderer = rendererOf(event)
  return softwareRenderers.test(renderer)
    ? { id: 'software_renderer', detail: `The graphics are drawn by software (${renderer.trim().slice(0, 80)}).` }
    : undefined
}

const checks: Record<EnvironmentCheckId, Check> = {
  private_mode_likely: privateMode,
  virtual_machine_gpu: virtualMachine,
  software_renderer: softwareRenderer,
}

export function checkEnvironment(event: StoredEvent, options: EnvironmentOptions = {}): EnvironmentReport {
  const disabled = new Set(options.disabledChecks ?? [])
  const signals: EnvironmentSignal[] = []
  for (const [id, check] of Object.entries(checks)) {
    if (disabled.has(id)) {
      continue
    }
    try {
      const signal = check(event, { privateQuotaBytes: options.privateQuotaBytes ?? defaultPrivateQuotaBytes })
      if (signal) {
        signals.push(signal)
      }
    } catch {
      // A check that cannot read the visit says nothing; it never stops the others
    }
  }
  return { signals }
}
