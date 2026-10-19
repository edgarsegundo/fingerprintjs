import { createHash, timingSafeEqual } from 'node:crypto'

import type { Config, TenantConfig } from '../config'

import type { TenantRecord, TenantStore } from './store'

function fromRecord(record: TenantRecord): TenantConfig {
  return {
    id: record.id,
    name: record.name,
    publicKey: record.publicKey,
    secretKeySha256: record.secretKeySha256,
    allowedOrigins: record.allowedOrigins,
    settings: record.settings,
    plan: record.plan,
    status: record.status,
    source: 'database',
  }
}

/**
 * Every tenant that can use the server: the ones in the configuration file and the ones made through the admin API.
 * The tenants of the store are read by `load` and kept in memory, because the answers here are needed at once, on every
 * request. `load` again after a change. An id or a public key that appears in both places is a mistake, and the one in
 * the file wins, so a tenant made later cannot take over a configured one.
 *
 * With no store there is nothing to load and the directory works at once. With a store, using it before `load` is a
 * mistake in the code and says so, instead of silently leaving out the tenants of the store.
 */
export class TenantDirectory {
  private cache: TenantConfig[] | undefined
  private storedTenants: TenantConfig[] | undefined

  constructor(private readonly getConfig: () => Config, private readonly store?: TenantStore) {}

  /** Reads the tenants of the store again. A failure leaves what was loaded before as it was. */
  async load(): Promise<void> {
    this.storedTenants = this.store ? (await this.store.list()).map(fromRecord) : []
    this.cache = undefined
  }

  /** Forgets the merged list, so that a new configuration is taken into account. The store is not read again. */
  refresh(): void {
    this.cache = undefined
  }

  all(): TenantConfig[] {
    if (!this.cache) {
      if (this.store && this.storedTenants === undefined) {
        throw new Error('The tenants of the store were not loaded: call load() first')
      }
      const fileTenants = this.getConfig().tenants
      const taken = new Set(fileTenants.flatMap((tenant) => [`id:${tenant.id}`, `pk:${tenant.publicKey}`]))
      const stored = (this.storedTenants ?? []).filter(
        (tenant) => !taken.has(`id:${tenant.id}`) && !taken.has(`pk:${tenant.publicKey}`),
      )
      this.cache = [...fileTenants, ...stored]
    }
    return this.cache
  }

  find(id: string): TenantConfig | undefined {
    return this.all().find((tenant) => tenant.id === id)
  }

  byPublicKey(publicKey: string | null | undefined): TenantConfig | undefined {
    return publicKey ? this.all().find((tenant) => tenant.publicKey === publicKey) : undefined
  }

  /** The tenant that owns a secret key. The comparison takes the same time for any wrong key. */
  authenticate(secret: string): TenantConfig | undefined {
    const given = createHash('sha256').update(secret).digest()
    let found: TenantConfig | undefined
    for (const tenant of this.all()) {
      for (const stored of tenant.secretKeySha256) {
        if (timingSafeEqual(given, Buffer.from(stored, 'hex'))) {
          found = tenant
        }
      }
    }
    return found
  }
}
