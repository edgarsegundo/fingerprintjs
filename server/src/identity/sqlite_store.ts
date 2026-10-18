import type { DatabaseSync, StatementSync } from 'node:sqlite'

import type { Features } from './features'
import { smoothedAgreement, type PopulationStats } from './model'
import type { DeviceProfile, IdentityStore, Resolution } from './store'

/**
 * Keeps the devices, their feature values and the resolutions in the same SQLite file as the events.
 *
 * Counting devices per value is done with queries on every resolution. That is right for thousands of devices and the
 * wrong shape for millions: phase 8 should keep running counters instead.
 */
export class SqliteIdentityStore implements IdentityStore {
  private readonly countDevices: StatementSync
  private readonly countWithValue: StatementSync
  private readonly countsOfFeature: StatementSync
  private readonly devicesWithValue: StatementSync
  private readonly insertDevice: StatementSync
  private readonly touchDevice: StatementSync
  private readonly upsertFeature: StatementSync
  private readonly selectDevice: StatementSync
  private readonly selectFeatures: StatementSync
  private readonly upsertResolution: StatementSync
  private readonly selectResolution: StatementSync
  /** Bumped on every write; the cached agreement estimates of an older version are thrown away */
  private version = 0
  private readonly agreementCache = new Map<string, { version: number; value: number }>()

  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_devices (
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        visits INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS identity_features (
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        feature TEXT NOT NULL,
        value TEXT NOT NULL,
        count INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, device_id, feature, value)
      );
      CREATE INDEX IF NOT EXISTS identity_features_lookup ON identity_features (tenant_id, feature, value);
      CREATE TABLE IF NOT EXISTS identity_resolutions (
        tenant_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        resolution_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS identity_resolutions_device ON identity_resolutions (tenant_id, device_id);
    `)
    this.countDevices = db.prepare('SELECT COUNT(*) AS c FROM identity_devices WHERE tenant_id = ?')
    this.countWithValue = db.prepare(
      'SELECT COUNT(*) AS c FROM identity_features WHERE tenant_id = ? AND feature = ? AND value = ?',
    )
    this.countsOfFeature = db.prepare(
      'SELECT COUNT(*) AS c FROM identity_features WHERE tenant_id = ? AND feature = ? GROUP BY value',
    )
    this.devicesWithValue = db.prepare(
      'SELECT device_id FROM identity_features WHERE tenant_id = ? AND feature = ? AND value = ? LIMIT ?',
    )
    this.insertDevice = db.prepare(
      'INSERT INTO identity_devices (tenant_id, device_id, created_at, last_seen_at, visits) VALUES (?, ?, ?, ?, 0)',
    )
    this.touchDevice = db.prepare(
      `UPDATE identity_devices SET visits = visits + 1, last_seen_at = MAX(last_seen_at, ?)
       WHERE tenant_id = ? AND device_id = ?`,
    )
    this.upsertFeature = db.prepare(
      `INSERT INTO identity_features (tenant_id, device_id, feature, value, count, last_seen) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (tenant_id, device_id, feature, value)
       DO UPDATE SET count = count + 1, last_seen = MAX(last_seen, excluded.last_seen)`,
    )
    this.selectDevice = db.prepare(
      'SELECT created_at, last_seen_at, visits FROM identity_devices WHERE tenant_id = ? AND device_id = ?',
    )
    this.selectFeatures = db.prepare(
      'SELECT feature, value, count, last_seen FROM identity_features WHERE tenant_id = ? AND device_id = ?',
    )
    this.upsertResolution = db.prepare(
      `INSERT OR REPLACE INTO identity_resolutions (tenant_id, request_id, device_id, resolution_json)
       VALUES (?, ?, ?, ?)`,
    )
    this.selectResolution = db.prepare(
      'SELECT resolution_json FROM identity_resolutions WHERE tenant_id = ? AND request_id = ?',
    )
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  population(tenantId: string): PopulationStats {
    const devices = Number((this.countDevices.get(tenantId) as { c: number }).c)
    return {
      devices,
      devicesWithValue: (feature, value) =>
        Number((this.countWithValue.get(tenantId, feature, value) as { c: number }).c),
      agreementProbability: (feature) => {
        const key = `${tenantId}\u0000${feature}`
        const cached = this.agreementCache.get(key)
        if (cached && cached.version === this.version) {
          return cached.value
        }
        const counts = (this.countsOfFeature.all(tenantId, feature) as Array<{ c: number }>).map((row) => Number(row.c))
        const value = smoothedAgreement(counts)
        this.agreementCache.set(key, { version: this.version, value })
        return value
      },
    }
  }

  findCandidates(tenantId: string, features: Features, limit: number): string[] {
    const total = Number((this.countDevices.get(tenantId) as { c: number }).c)
    const tooCommon = Math.max(50, total * 0.05)
    const rarity = new Map<string, number>()
    for (const [feature, value] of Object.entries(features)) {
      const rows = this.devicesWithValue.all(tenantId, feature, value, Math.ceil(tooCommon) + 1) as Array<{
        device_id: string
      }>
      if (rows.length === 0 || rows.length > tooCommon) {
        continue
      }
      const weight = -Math.log(rows.length / Math.max(1, total)) + 1e-9
      for (const row of rows) {
        rarity.set(row.device_id, (rarity.get(row.device_id) ?? 0) + weight)
      }
    }
    return [...rarity.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([deviceId]) => deviceId)
  }

  getProfile(tenantId: string, deviceId: string): DeviceProfile | undefined {
    const device = this.selectDevice.get(tenantId, deviceId) as
      | { created_at: number; last_seen_at: number; visits: number }
      | undefined
    if (!device) {
      return undefined
    }
    const features: DeviceProfile['features'] = new Map()
    for (const row of this.selectFeatures.all(tenantId, deviceId) as Array<{
      feature: string
      value: string
      count: number
      last_seen: number
    }>) {
      let values = features.get(row.feature)
      if (!values) {
        values = new Map()
        features.set(row.feature, values)
      }
      values.set(row.value, { count: Number(row.count), lastSeen: Number(row.last_seen) })
    }
    return {
      deviceId,
      visits: Number(device.visits),
      firstSeen: Number(device.created_at),
      lastSeen: Number(device.last_seen_at),
      features,
    }
  }

  createDevice(tenantId: string, deviceId: string, features: Features, at: number): void {
    this.transaction(() => {
      this.insertDevice.run(tenantId, deviceId, at, at)
      this.record(tenantId, deviceId, features, at)
    })
  }

  addObservation(tenantId: string, deviceId: string, features: Features, at: number): void {
    this.transaction(() => this.record(tenantId, deviceId, features, at))
  }

  private record(tenantId: string, deviceId: string, features: Features, at: number): void {
    if (Number(this.touchDevice.run(at, tenantId, deviceId).changes) !== 1) {
      throw new Error('unknown device')
    }
    for (const [feature, value] of Object.entries(features)) {
      this.upsertFeature.run(tenantId, deviceId, feature, value, at)
    }
    this.version++
  }

  saveResolution(tenantId: string, requestId: string, deviceId: string, resolution: Resolution): void {
    this.upsertResolution.run(tenantId, requestId, deviceId, JSON.stringify(resolution))
  }

  getResolution(tenantId: string, requestId: string): Resolution | undefined {
    const row = this.selectResolution.get(tenantId, requestId) as { resolution_json: string } | undefined
    return row ? (JSON.parse(row.resolution_json) as Resolution) : undefined
  }

  /** Forgets the resolutions whose event was deleted, and then the devices that no resolution points to any more */
  removeOrphans(): number {
    return this.transaction(() => {
      this.db.exec(`
        DELETE FROM identity_resolutions WHERE NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.tenant_id = identity_resolutions.tenant_id AND e.request_id = identity_resolutions.request_id
        );
        DELETE FROM identity_features WHERE NOT EXISTS (
          SELECT 1 FROM identity_resolutions r
          WHERE r.tenant_id = identity_features.tenant_id AND r.device_id = identity_features.device_id
        );
      `)
      const removed = this.db.prepare(
        `DELETE FROM identity_devices WHERE NOT EXISTS (
          SELECT 1 FROM identity_resolutions r
          WHERE r.tenant_id = identity_devices.tenant_id AND r.device_id = identity_devices.device_id
        )`,
      )
      const changes = Number(removed.run().changes)
      if (changes > 0) {
        this.version++
      }
      return changes
    })
  }
}
