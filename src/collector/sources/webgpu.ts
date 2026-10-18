import { withTimeout } from '../utils'

const adapterTimeoutMs = 2000

// Only the parts of the WebGPU API that are used. The full types would be an extra dependency.
type GpuAdapterInfo = { vendor?: string; architecture?: string; device?: string; description?: string }
type GpuAdapter = {
  info?: GpuAdapterInfo
  requestAdapterInfo?: () => Promise<GpuAdapterInfo>
  features: Iterable<string>
  limits: Record<string, unknown>
}
type Gpu = {
  requestAdapter(): Promise<GpuAdapter | null>
  getPreferredCanvasFormat?: () => string
}

export type WebGpuInfo =
  | { adapter: false }
  | {
      adapter: true
      info: GpuAdapterInfo
      features: string[]
      limits: Record<string, number>
      preferredCanvasFormat?: string
    }

/**
 * The WebGPU adapter description, features and limits. WebGPU exposes the GPU more precisely than WebGL
 * and it is a newer, less filtered API. `adapter: false` means that the browser has WebGPU but no adapter,
 * which is common in headless and virtual machines.
 */
export default async function getWebGpu(): Promise<WebGpuInfo | undefined> {
  const gpu = (navigator as unknown as { gpu?: Gpu }).gpu
  if (!gpu || typeof gpu.requestAdapter !== 'function') {
    return undefined
  }

  const adapter = await withTimeout(gpu.requestAdapter(), adapterTimeoutMs)
  if (!adapter) {
    return { adapter: false }
  }

  // `adapter.info` is the current API, `requestAdapterInfo` is the older one
  const rawInfo = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {})
  const info: GpuAdapterInfo = {}
  for (const key of ['vendor', 'architecture', 'device', 'description'] as const) {
    info[key] = rawInfo?.[key]
  }

  // Limits are getters on the prototype, so they are read with `for...in`
  const limits: Record<string, number> = {}
  for (const key in adapter.limits) {
    const value = adapter.limits[key]
    if (typeof value === 'number') {
      limits[key] = value
    }
  }

  return {
    adapter: true,
    info,
    features: Array.from(adapter.features).sort(),
    limits: Object.fromEntries(
      Object.keys(limits)
        .sort()
        .map((key) => [key, limits[key]]),
    ),
    preferredCanvasFormat: gpu.getPreferredCanvasFormat?.(),
  }
}
