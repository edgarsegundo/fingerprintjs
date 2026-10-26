import { randomBytes } from 'node:crypto'

import type { MaybePromise } from './async'
import type { AuditLog } from './audit/log'
import type { TenantConfig } from './config'
import { sha256Hex } from './config'
import type { GraphStore } from './graph/store'
import { bearerMatches, HttpError, readBody, reply, Res } from './http_util'
import type { IdentityEngine } from './identity/engine'
import type { Req } from './net/signals'
import { ipHashKey, protectIp } from './privacy/ip_policy'
import { buildCatalog, helpCoverage } from './settings/catalog'
import { readOnlyParameters } from './settings/help'
import type { Settings, SettingsRegistry } from './settings/settings'
import { copyPaths, tenantSettingsView } from './settings/tenant_view'
import type { EventStore } from './store/types'
import type { TenantRecord, TenantStore } from './tenants/store'
import { monthOf, UsageMeter } from './usage/meter'
import type { WebhookQueue } from './webhooks/queue'

export interface AdminDeps {
  settings: SettingsRegistry
  tenantStore: TenantStore
  store: EventStore
  identity?: IdentityEngine
  webhooks?: WebhookQueue
  usage?: UsageMeter
  graph?: GraphStore
  audit?: AuditLog
  now: () => number
  log: (entry: Record<string, unknown>) => void
  /** Called with the address of a caller whose key was not accepted, to limit attempts */
  failedAttempt: (address: string) => MaybePromise<void>
}

const tenantIdPattern = /^[A-Za-z0-9_-]{1,64}$/
const maxKeys = 5
const maxBody = 64 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const token = (prefix: string, bytes: number) => `${prefix}${randomBytes(bytes).toString('base64url')}`
const keyIdOf = (hash: string) => hash.slice(0, 8)

/** A copy of the settings in which the secrets of webhooks are not shown. The admin does not need them again. */
function hideSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(hideSecrets)
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, key === 'secrets' ? ['[hidden]'] : hideSecrets(item)]),
    )
  }
  return value
}

function origins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new HttpError(400, { error: 'invalid_parameter', parameter: 'allowedOrigins' })
  }
  for (const origin of value) {
    let ok = false
    try {
      ok = typeof origin === 'string' && new URL(origin).origin === origin && origin !== 'null'
    } catch {
      ok = false
    }
    if (!ok) {
      throw new HttpError(400, {
        error: 'invalid_parameter',
        parameter: 'allowedOrigins',
        detail: 'use origins such as https://shop.example',
      })
    }
  }
  return value as string[]
}

/**
 * The admin API: tenants made, changed, suspended and removed at run time, their keys, and their usage. It is what a
 * service that sells the platform needs. It has its own keys (`adminKeySha256`), which can do nothing else.
 */
export function createAdminHandler(deps: AdminDeps) {
  const { settings, tenantStore, now } = deps

  function view(tenant: TenantConfig) {
    return {
      id: tenant.id,
      name: tenant.name ?? null,
      plan: tenant.plan ?? null,
      status: tenant.status ?? 'active',
      source: tenant.source ?? 'file',
      publicKey: tenant.publicKey,
      keyIds: tenant.secretKeySha256.map(keyIdOf),
      allowedOrigins: tenant.allowedOrigins,
    }
  }

  const record = async (
    tenantId: string,
    action: 'admin.tenant.create' | 'admin.tenant.update' | 'admin.key.add' | 'admin.key.revoke',
    subject: string,
    address: string,
    status: number,
  ) => {
    try {
      await deps.audit?.record({
        at: now(),
        tenantId,
        action,
        subject,
        keyId: 'admin',
        requester:
          protectIp(
            address,
            'hash',
            ipHashKey(settings.config.ipHashSecret ?? settings.config.nonceSecret),
            tenantId,
          ) ?? '',
        status,
      })
    } catch (error) {
      deps.log({ route: 'audit_failed', error: error instanceof Error ? error.message : 'unknown' })
    }
  }

  async function bodyOf(req: Req): Promise<Record<string, unknown>> {
    let parsed: unknown
    try {
      parsed = JSON.parse((await readBody(req, maxBody)).toString('utf8'))
    } catch (error) {
      if (error instanceof HttpError) {
        throw error
      }
      throw new HttpError(400, { error: 'invalid_json' })
    }
    if (!isRecord(parsed)) {
      throw new HttpError(400, { error: 'invalid_json' })
    }
    return parsed
  }

  /** The fields that the admin may set, checked. Unknown fields are refused so that a typo is not silently ignored. */
  function checkFields(body: Record<string, unknown>, allowed: readonly string[]): void {
    const extra = Object.keys(body).find((key) => !allowed.includes(key))
    if (extra !== undefined) {
      throw new HttpError(400, { error: 'unknown_field', field: extra.slice(0, 40) })
    }
  }

  function checkPlan(plan: unknown): string | undefined {
    if (plan === undefined || plan === null) {
      return undefined
    }
    if (typeof plan !== 'string' || !Object.prototype.hasOwnProperty.call(settings.config.plans, plan)) {
      throw new HttpError(400, { error: 'unknown_plan', plans: Object.keys(settings.config.plans) })
    }
    return plan
  }

  function checkSettings(tenantSettings: unknown, plan: string | undefined): Record<string, unknown> {
    if (!isRecord(tenantSettings)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'settings' })
    }
    // `hideSecrets` shows webhook secrets as "[hidden]". Saving that text back would replace the real secrets with it.
    if (JSON.stringify(tenantSettings).includes('"[hidden]"')) {
      throw new HttpError(400, { error: 'hidden_placeholder', detail: 'a secret was sent back as "[hidden]"' })
    }
    const problems = settings.problemsOfTenantSettings(tenantSettings, plan)
    if (problems.length > 0) {
      throw new HttpError(400, { error: 'invalid_settings', problems: problems.slice(0, 20) })
    }
    return tenantSettings
  }

  async function stored(id: string): Promise<TenantRecord> {
    const tenant = settings.tenants.find(id)
    if (!tenant) {
      throw new HttpError(404, { error: 'not_found' })
    }
    const found = tenant.source === 'database' ? await tenantStore.get(id) : undefined
    if (!found) {
      throw new HttpError(409, { error: 'managed_by_file' })
    }
    return found
  }

  async function changed(tenantId: string): Promise<void> {
    await settings.reloadTenants()
    // A new or changed tenant has to pass its own settings now, not at the first visit
    settings.for(tenantId)
  }

  async function createTenant(req: Req, res: Res, address: string) {
    const body = await bodyOf(req)
    checkFields(body, ['id', 'name', 'plan', 'allowedOrigins', 'settings'])
    if (typeof body.id !== 'string' || !tenantIdPattern.test(body.id)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'id' })
    }
    if (settings.tenants.find(body.id)) {
      throw new HttpError(409, { error: 'id_taken' })
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 100)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'name' })
    }
    const plan = checkPlan(body.plan)
    const tenantSettings = checkSettings(body.settings ?? {}, plan)
    const secretKey = token('sk_', 32)
    const timestamp = now()
    const created: TenantRecord = {
      id: body.id,
      name: body.name as string | undefined,
      publicKey: token('pk_', 18),
      secretKeySha256: [sha256Hex(secretKey)],
      allowedOrigins: body.allowedOrigins === undefined ? [] : origins(body.allowedOrigins),
      plan,
      settings: tenantSettings,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    try {
      await tenantStore.create(created)
    } catch {
      throw new HttpError(409, { error: 'id_taken' })
    }
    await changed(created.id)
    await record(created.id, 'admin.tenant.create', created.id, address, 201)
    // The secret key is shown this once. Only its hash is kept.
    reply(res, 201, { tenant: view(settings.tenants.find(created.id) as TenantConfig), secretKey })
    return { route: 'admin_tenant_create', tenantId: created.id, status: 201 }
  }

  async function updateTenant(req: Req, res: Res, id: string, address: string) {
    const current = await stored(id)
    const body = await bodyOf(req)
    checkFields(body, ['name', 'plan', 'allowedOrigins', 'settings', 'status', 'keepReadOnly'])
    const next: TenantRecord = { ...current, updatedAt: now() }
    if (body.name !== undefined) {
      if (body.name !== null && (typeof body.name !== 'string' || body.name.length > 100)) {
        throw new HttpError(400, { error: 'invalid_parameter', parameter: 'name' })
      }
      next.name = body.name === null ? undefined : body.name
    }
    if (body.plan !== undefined) {
      next.plan = checkPlan(body.plan)
    }
    if (body.allowedOrigins !== undefined) {
      next.allowedOrigins = origins(body.allowedOrigins)
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'suspended') {
        throw new HttpError(400, { error: 'invalid_parameter', parameter: 'status' })
      }
      next.status = body.status
    }
    // The settings are checked together with the plan they will sit on, even if only one of them changed
    // The settings panel never sees the secrets of the parameters that it only shows (webhook endpoints), so it asks to
    // keep what the tenant has for them, instead of sending them back
    let candidate = body.settings ?? current.settings
    if (body.keepReadOnly === true && isRecord(candidate)) {
      candidate = copyPaths(current.settings, candidate, readOnlyParameters)
    }
    next.settings = checkSettings(candidate, next.plan)
    await tenantStore.update(next)
    await changed(id)
    await record(id, 'admin.tenant.update', Object.keys(body).join(','), address, 200)
    reply(res, 200, { tenant: view(settings.tenants.find(id) as TenantConfig) })
    return { route: 'admin_tenant_update', tenantId: id, status: 200 }
  }

  async function addKey(res: Res, id: string, address: string) {
    const current = await stored(id)
    if (current.secretKeySha256.length >= maxKeys) {
      throw new HttpError(409, { error: 'too_many_keys', max: maxKeys })
    }
    const secretKey = token('sk_', 32)
    const hash = sha256Hex(secretKey)
    await tenantStore.update({ ...current, secretKeySha256: [...current.secretKeySha256, hash], updatedAt: now() })
    await changed(id)
    await record(id, 'admin.key.add', keyIdOf(hash), address, 201)
    reply(res, 201, { keyId: keyIdOf(hash), secretKey })
    return { route: 'admin_key_add', tenantId: id, status: 201 }
  }

  async function revokeKey(res: Res, id: string, keyId: string, address: string) {
    const current = await stored(id)
    const matching = current.secretKeySha256.filter((hash) => keyIdOf(hash) === keyId)
    if (matching.length !== 1) {
      throw new HttpError(404, { error: 'not_found' })
    }
    if (current.secretKeySha256.length === 1) {
      throw new HttpError(409, { error: 'last_key' })
    }
    await tenantStore.update({
      ...current,
      secretKeySha256: current.secretKeySha256.filter((hash) => hash !== matching[0]),
      updatedAt: now(),
    })
    await changed(id)
    await record(id, 'admin.key.revoke', keyId, address, 200)
    reply(res, 200, { revoked: keyId })
    return { route: 'admin_key_revoke', tenantId: id, status: 200 }
  }

  /** Removes a tenant and everything kept about it. It cannot be undone. */
  async function deleteTenant(res: Res, url: URL, id: string) {
    const current = await stored(id)
    if (url.searchParams.get('confirm') !== id) {
      throw new HttpError(400, { error: 'confirmation_required', detail: 'add ?confirm=<tenant id>' })
    }
    const events = await deps.store.purgeTenant(id, Number.MAX_SAFE_INTEGER, 0)
    const deliveries = (await deps.webhooks?.deleteTenant(id)) ?? 0
    const audit = (await deps.audit?.purgeTenant(id, Number.MAX_SAFE_INTEGER)) ?? 0
    const usage = (await deps.usage?.deleteTenant(id)) ?? 0
    await deps.graph?.deleteTenant(id)
    await tenantStore.delete(current.id)
    await settings.reloadTenants()
    const devices = (await deps.identity?.removeOrphans()) ?? 0
    deps.log({ route: 'admin_tenant_deleted', tenantId: id, events, devices, deliveries })
    reply(res, 200, { deleted: id, events, devices, deliveries, audit, usage })
    return { route: 'admin_tenant_delete', tenantId: id, status: 200 }
  }

  function detail(res: Res, id: string) {
    const tenant = settings.tenants.find(id)
    if (!tenant) {
      throw new HttpError(404, { error: 'not_found' })
    }
    const effective: Settings = settings.for(id)
    reply(res, 200, {
      ...view(tenant),
      settings: hideSecrets(tenant.settings),
      effectiveSettings: hideSecrets(effective),
    })
    return { route: 'admin_tenant', tenantId: id, status: 200 }
  }

  /** Every parameter with its explanation, so that the settings panel can draw the fields */
  function parameterCatalog(res: Res) {
    reply(res, 200, { parameters: buildCatalog(), coverage: helpCoverage() })
    return { route: 'admin_parameters', status: 200 }
  }

  /** The settings of one tenant by parameter: what it sets, what it falls back to, and where each value comes from */
  function tenantSettings(res: Res, id: string) {
    const tenant = settings.tenants.find(id)
    if (!tenant) {
      throw new HttpError(404, { error: 'not_found' })
    }
    const paths = buildCatalog().map((entry) => entry.path)
    const byLayer = tenantSettingsView(settings, tenant, paths)
    reply(res, 200, {
      tenant: view(tenant),
      // A tenant of the configuration file cannot be changed through the API
      editable: tenant.source === 'database',
      overrides: hideSecrets(byLayer.overrides),
      effective: hideSecrets(byLayer.effective),
      inherited: hideSecrets(byLayer.inherited),
      origins: byLayer.origins,
    })
    return { route: 'admin_tenant_settings', tenantId: id, status: 200 }
  }

  async function usage(res: Res, url: URL) {
    const month = url.searchParams.get('month') ?? monthOf(now())
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new HttpError(400, { error: 'invalid_parameter', parameter: 'month' })
    }
    const tenantId = url.searchParams.get('tenant')
    if (tenantId !== null) {
      if (!settings.tenants.find(tenantId)) {
        throw new HttpError(404, { error: 'not_found' })
      }
      const s = settings.for(tenantId)
      reply(res, 200, {
        month,
        tenant: tenantId,
        totals: (await deps.usage?.month(tenantId, month)) ?? null,
        days: (await deps.usage?.days(tenantId, month)) ?? [],
        quotas: { collectsPerMonth: s.quota.collectsPerMonth, apiReadsPerMonth: s.quota.apiReadsPerMonth },
      })
    } else {
      reply(res, 200, {
        month,
        tenants: await Promise.all(
          settings.tenants.all().map(async (tenant) => ({
            tenant: tenant.id,
            plan: tenant.plan ?? null,
            status: tenant.status ?? 'active',
            totals: (await deps.usage?.month(tenant.id, month)) ?? null,
          })),
        ),
      })
    }
    return { route: 'admin_usage', status: 200 }
  }

  return async function handleAdmin(
    req: Req,
    res: Res,
    url: URL,
    method: string,
    address: string,
  ): Promise<{ route: string; tenantId?: string; status: number }> {
    if (!bearerMatches(settings.config.adminKeySha256, req)) {
      await deps.failedAttempt(address)
      throw new HttpError(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' })
    }
    const path = url.pathname.slice('/admin/v1'.length)
    const notAllowed = (allow: string) => new HttpError(405, { error: 'method_not_allowed' }, { Allow: allow })

    if (path === '/tenants') {
      if (method === 'GET') {
        reply(res, 200, { tenants: settings.tenants.all().map(view) })
        return { route: 'admin_tenants', status: 200 }
      }
      if (method === 'POST') {
        return createTenant(req, res, address)
      }
      throw notAllowed('GET, POST')
    }
    if (path === '/parameters') {
      if (method !== 'GET') {
        throw notAllowed('GET')
      }
      return parameterCatalog(res)
    }
    const settingsMatch = /^\/tenants\/([A-Za-z0-9_-]{1,64})\/settings$/.exec(path)
    if (settingsMatch) {
      if (method !== 'GET') {
        throw notAllowed('GET')
      }
      return tenantSettings(res, settingsMatch[1])
    }
    if (path === '/usage') {
      if (method !== 'GET') {
        throw notAllowed('GET')
      }
      return usage(res, url)
    }
    const keyMatch = /^\/tenants\/([A-Za-z0-9_-]{1,64})\/keys(?:\/([0-9a-f]{8}))?$/.exec(path)
    if (keyMatch) {
      if (keyMatch[2] === undefined) {
        if (method !== 'POST') {
          throw notAllowed('POST')
        }
        return addKey(res, keyMatch[1], address)
      }
      if (method !== 'DELETE') {
        throw notAllowed('DELETE')
      }
      return revokeKey(res, keyMatch[1], keyMatch[2], address)
    }
    const tenantMatch = /^\/tenants\/([A-Za-z0-9_-]{1,64})$/.exec(path)
    if (tenantMatch) {
      if (method === 'GET') {
        return detail(res, tenantMatch[1])
      }
      if (method === 'PATCH') {
        return updateTenant(req, res, tenantMatch[1], address)
      }
      if (method === 'DELETE') {
        return deleteTenant(res, url, tenantMatch[1])
      }
      throw notAllowed('GET, PATCH, DELETE')
    }
    throw new HttpError(404, { error: 'not_found' })
  }
}
