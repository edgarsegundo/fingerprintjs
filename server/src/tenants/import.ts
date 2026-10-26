import type { TenantConfig } from '../config'

import type { TenantRecord, TenantStore } from './store'

export interface ImportReport {
  /** Tenants that were copied (or would be, in a dry run) */
  imported: string[]
  /** Tenants that were left alone, with the reason */
  skipped: Array<{ id: string; reason: string }>
}

/**
 * Copies the tenants of the configuration file into the database, with the SAME keys, so that a page that already has
 * the public key keeps working and a backend that already has the secret key keeps working. The admin API cannot do
 * this: it makes new keys. After the copy the tenants are removed from the file, and from then on they are changed
 * through the admin API (and the settings panel).
 *
 * It is safe to run again: a tenant that is already in the database is left alone, never overwritten.
 */
export async function importFileTenants(
  fileTenants: readonly TenantConfig[],
  store: TenantStore,
  now: number,
  options: { dryRun?: boolean } = {},
): Promise<ImportReport> {
  const report: ImportReport = { imported: [], skipped: [] }
  const existing = await store.list()
  const taken = new Set(existing.map((record) => record.publicKey))
  for (const tenant of fileTenants) {
    if (existing.some((record) => record.id === tenant.id)) {
      report.skipped.push({ id: tenant.id, reason: 'already in the database' })
      continue
    }
    if (taken.has(tenant.publicKey)) {
      report.skipped.push({ id: tenant.id, reason: 'its public key is already used by another tenant in the database' })
      continue
    }
    const record: TenantRecord = {
      id: tenant.id,
      ...(tenant.name === undefined ? {} : { name: tenant.name }),
      publicKey: tenant.publicKey,
      secretKeySha256: [...tenant.secretKeySha256],
      allowedOrigins: [...tenant.allowedOrigins],
      ...(tenant.plan === undefined ? {} : { plan: tenant.plan }),
      settings: structuredClone(tenant.settings),
      status: tenant.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    }
    if (options.dryRun !== true) {
      await store.create(record)
    }
    taken.add(record.publicKey)
    report.imported.push(tenant.id)
  }
  return report
}
