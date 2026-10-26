import type { TenantConfig } from '../config'

import { SettingsRegistry, validateLayer } from './settings'

/** Where the value of a parameter comes from, for one tenant. The last layer that sets it wins. */
export type Origin = 'tenant' | 'plan' | 'defaults' | 'built-in'

export interface TenantSettingsView {
  /** What the tenant sets itself, one entry per parameter */
  overrides: Record<string, unknown>
  /** The value in force for every parameter, after every layer */
  effective: Record<string, unknown>
  /** The value that the tenant would have without its own settings (the plan, the defaults of the file, the table) */
  inherited: Record<string, unknown>
  origins: Record<string, Origin>
}

function valueAt(source: unknown, path: string): unknown {
  let node = source
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) {
      return undefined
    }
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

/** Copies the value of each of the paths from one settings object into another, when the source has it */
export function copyPaths(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  paths: Iterable<string>,
): Record<string, unknown> {
  const result = structuredClone(to)
  for (const path of paths) {
    const value = valueAt(from, path)
    if (value === undefined) {
      continue
    }
    const parts = path.split('.')
    let node = result
    for (const part of parts.slice(0, -1)) {
      const next = node[part]
      node[part] = typeof next === 'object' && next !== null && !Array.isArray(next) ? next : {}
      node = node[part] as Record<string, unknown>
    }
    node[parts[parts.length - 1]] = structuredClone(value)
  }
  return result
}

const flat = (layer: unknown): Map<string, unknown> => new Map(validateLayer(layer, 'settings').flat)

/**
 * Splits the settings of a tenant by layer, so that the settings panel can show each value with where it comes from,
 * the value it falls back to, and what the tenant changed.
 */
export function tenantSettingsView(
  registry: SettingsRegistry,
  tenant: TenantConfig,
  paths: readonly string[],
): TenantSettingsView {
  const config = registry.config
  const plan = tenant.plan !== undefined && Object.prototype.hasOwnProperty.call(config.plans, tenant.plan)
  const tenantLayer = flat(tenant.settings)
  const planLayer = plan ? flat(config.plans[tenant.plan as string]) : new Map<string, unknown>()
  const fileLayers = [flat(config.legacySettings), flat(config.defaults)]

  const overrides: Record<string, unknown> = {}
  const origins: Record<string, Origin> = {}
  for (const path of paths) {
    if (tenantLayer.has(path)) {
      overrides[path] = tenantLayer.get(path)
      origins[path] = 'tenant'
    } else if (planLayer.has(path)) {
      origins[path] = 'plan'
    } else if (fileLayers.some((layer) => layer.has(path))) {
      origins[path] = 'defaults'
    } else {
      origins[path] = 'built-in'
    }
  }

  const effective: Record<string, unknown> = {}
  const inherited: Record<string, unknown> = {}
  const settingsOfTenant = registry.for(tenant.id)
  // The settings of a tenant that sets nothing of its own: the same layers, without the last one
  let bare: ReturnType<SettingsRegistry['forPlan']> | undefined
  try {
    bare = registry.forPlan(tenant.plan ?? '')
  } catch {
    bare = undefined
  }
  for (const path of paths) {
    effective[path] = valueAt(settingsOfTenant, path)
    inherited[path] = bare === undefined ? effective[path] : valueAt(bare, path)
  }
  return { overrides, effective, inherited, origins }
}
