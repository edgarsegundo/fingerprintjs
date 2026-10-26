import type { DatabaseSync, StatementSync } from 'node:sqlite'

import type { Features } from './features'
import { smoothedAgreementFromTotals, type PopulationStats } from './model'
import {
  Activity,
  ActivityQuery,
  CandidateRule,
  defaultCandidateRule,
  DeviceEdit,
  DeviceProfile,
  FeatureAnonymity,
  FeatureStability,
  SeenDevice,
  DeviceAccount,
  IdentityStore,
  Resolution,
} from './store'

/**
 * Keeps the devices, their feature values and the resolutions in the same SQLite file as the events.
 *
 * Counting devices per value is done with queries on every resolution. That is right for thousands of devices and the
 * wrong shape for millions: phase 8 should keep running counters instead.
 */
export class SqliteIdentityStore implements IdentityStore {
  private readonly countDevices: StatementSync
  private readonly countWithValue: StatementSync
  private readonly featureTotals: StatementSync
  private readonly devicesWithValue: StatementSync
  private readonly insertDevice: StatementSync
  private readonly touchDevice: StatementSync
  private readonly upsertFeature: StatementSync
  private readonly selectDevice: StatementSync
  private readonly selectFeatures: StatementSync
  private readonly upsertResolution: StatementSync
  private readonly selectResolution: StatementSync

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
      -- With the device id in the index, finding the devices of a value never has to read the table
      CREATE INDEX IF NOT EXISTS identity_features_by_value ON identity_features (tenant_id, feature, value, device_id);
      -- The devices of a value that were seen most recently come first without reading the others
      CREATE INDEX IF NOT EXISTS identity_features_by_seen ON identity_features (tenant_id, feature, value, last_seen);
      DROP INDEX IF EXISTS identity_features_lookup;
      CREATE TABLE IF NOT EXISTS identity_resolutions (
        tenant_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        resolution_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS identity_resolutions_device ON identity_resolutions (tenant_id, device_id);
      -- A device that was merged into another: the old id means the new one from then on
      CREATE TABLE IF NOT EXISTS identity_aliases (
        tenant_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, from_id)
      );
      CREATE INDEX IF NOT EXISTS identity_aliases_to ON identity_aliases (tenant_id, to_id);
      CREATE TABLE IF NOT EXISTS identity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Running counters, so that a visit does not have to count the whole population again (see the triggers below)
      CREATE TABLE IF NOT EXISTS identity_value_counts (
        tenant_id TEXT NOT NULL, feature TEXT NOT NULL, value TEXT NOT NULL, devices INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, feature, value)
      );
      CREATE TABLE IF NOT EXISTS identity_feature_stats (
        tenant_id TEXT NOT NULL, feature TEXT NOT NULL, total INTEGER NOT NULL, pairs INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, feature)
      );
      CREATE TABLE IF NOT EXISTS identity_tenant_stats (tenant_id TEXT PRIMARY KEY, devices INTEGER NOT NULL);
    `)
    this.buildCounters()
    this.countDevices = db.prepare('SELECT devices AS c FROM identity_tenant_stats WHERE tenant_id = ?')
    this.countWithValue = db.prepare(
      'SELECT devices AS c FROM identity_value_counts WHERE tenant_id = ? AND feature = ? AND value = ?',
    )
    this.featureTotals = db.prepare(
      'SELECT total, pairs FROM identity_feature_stats WHERE tenant_id = ? AND feature = ?',
    )
    this.devicesWithValue = db.prepare(
      `SELECT device_id FROM identity_features WHERE tenant_id = ? AND feature = ? AND value = ?
       ORDER BY last_seen DESC, device_id LIMIT ?`,
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
      'SELECT resolution_json, device_id FROM identity_resolutions WHERE tenant_id = ? AND request_id = ?',
    )
  }

  /**
   * The counters are kept by triggers on the two tables that hold the facts, so every way of writing or deleting
   * (a visit, the clean-up of orphans, a deletion on request) keeps them right. A database made before the counters
   * existed, or one that is out of step, is counted again once, in one transaction, before the triggers are in place.
   */
  private buildCounters(): void {
    const version = '1'
    const current = this.db.prepare("SELECT value FROM identity_meta WHERE key = 'counters'").get() as
      | { value: string }
      | undefined
    if (current?.value === version) {
      return
    }
    this.transaction(() => {
      this.db.exec(`
        DROP TRIGGER IF EXISTS identity_features_added;
        DROP TRIGGER IF EXISTS identity_features_removed;
        DROP TRIGGER IF EXISTS identity_devices_added;
        DROP TRIGGER IF EXISTS identity_devices_removed;
        DELETE FROM identity_value_counts;
        DELETE FROM identity_feature_stats;
        DELETE FROM identity_tenant_stats;
        INSERT INTO identity_value_counts
          SELECT tenant_id, feature, value, COUNT(*) FROM identity_features GROUP BY tenant_id, feature, value;
        INSERT INTO identity_feature_stats
          SELECT tenant_id, feature, SUM(devices), SUM(devices * (devices - 1) / 2)
            FROM identity_value_counts GROUP BY tenant_id, feature;
        INSERT INTO identity_tenant_stats SELECT tenant_id, COUNT(*) FROM identity_devices GROUP BY tenant_id;

        -- A device gets a value: one more device has it, and it pairs with each device that already had it
        CREATE TRIGGER identity_features_added AFTER INSERT ON identity_features BEGIN
          INSERT INTO identity_feature_stats (tenant_id, feature, total, pairs)
            VALUES (NEW.tenant_id, NEW.feature, 1, 0)
            ON CONFLICT (tenant_id, feature) DO UPDATE SET
              total = total + 1,
              pairs = pairs + COALESCE((SELECT devices FROM identity_value_counts
                WHERE tenant_id = NEW.tenant_id AND feature = NEW.feature AND value = NEW.value), 0);
          INSERT INTO identity_value_counts (tenant_id, feature, value, devices)
            VALUES (NEW.tenant_id, NEW.feature, NEW.value, 1)
            ON CONFLICT (tenant_id, feature, value) DO UPDATE SET devices = devices + 1;
        END;
        -- A device loses a value: the reverse
        CREATE TRIGGER identity_features_removed AFTER DELETE ON identity_features BEGIN
          UPDATE identity_feature_stats SET
            total = total - 1,
            pairs = pairs - (SELECT devices - 1 FROM identity_value_counts
              WHERE tenant_id = OLD.tenant_id AND feature = OLD.feature AND value = OLD.value)
            WHERE tenant_id = OLD.tenant_id AND feature = OLD.feature;
          UPDATE identity_value_counts SET devices = devices - 1
            WHERE tenant_id = OLD.tenant_id AND feature = OLD.feature AND value = OLD.value;
          DELETE FROM identity_value_counts
            WHERE tenant_id = OLD.tenant_id AND feature = OLD.feature AND value = OLD.value AND devices <= 0;
          DELETE FROM identity_feature_stats WHERE tenant_id = OLD.tenant_id AND feature = OLD.feature AND total <= 0;
        END;
        CREATE TRIGGER identity_devices_added AFTER INSERT ON identity_devices BEGIN
          INSERT INTO identity_tenant_stats (tenant_id, devices) VALUES (NEW.tenant_id, 1)
            ON CONFLICT (tenant_id) DO UPDATE SET devices = devices + 1;
        END;
        CREATE TRIGGER identity_devices_removed AFTER DELETE ON identity_devices BEGIN
          UPDATE identity_tenant_stats SET devices = devices - 1 WHERE tenant_id = OLD.tenant_id;
          DELETE FROM identity_tenant_stats WHERE tenant_id = OLD.tenant_id AND devices <= 0;
        END;
      `)
      this.db.prepare("INSERT OR REPLACE INTO identity_meta (key, value) VALUES ('counters', ?)").run(version)
    })
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

  // The features are for stores on the network, which read the population once, for this visit
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  population(tenantId: string, _features?: Features): PopulationStats {
    // One of these lives for one decision, in which nothing is written, so each answer can be remembered
    const values = new Map<string, number>()
    const agreement = new Map<string, number>()
    return {
      devices: this.deviceCount(tenantId),
      devicesWithValue: (feature, value) => {
        const key = `${feature}\u0000${value}`
        let count = values.get(key)
        if (count === undefined) {
          count = this.valueCount(tenantId, feature, value)
          values.set(key, count)
        }
        return count
      },
      agreementProbability: (feature) => {
        let probability = agreement.get(feature)
        if (probability === undefined) {
          const row = this.featureTotals.get(tenantId, feature) as { total: number; pairs: number } | undefined
          probability = smoothedAgreementFromTotals(Number(row?.total ?? 0), Number(row?.pairs ?? 0))
          agreement.set(feature, probability)
        }
        return probability
      },
    }
  }

  private deviceCount(tenantId: string): number {
    const row = this.countDevices.get(tenantId) as { c: number } | undefined
    return Number(row?.c ?? 0)
  }

  private valueCount(tenantId: string, feature: string, value: string): number {
    const row = this.countWithValue.get(tenantId, feature, value) as { c: number } | undefined
    return Number(row?.c ?? 0)
  }

  findCandidates(
    tenantId: string,
    features: Features,
    limit: number,
    rule: CandidateRule = defaultCandidateRule,
  ): string[] {
    const total = this.deviceCount(tenantId)
    const tooCommon = Math.max(rule.minDevices, total * rule.maxShare)
    const rarity = new Map<string, number>()
    for (const [feature, value] of Object.entries(features)) {
      // The counter says at once whether a value is shared by too many devices to be worth reading them all
      const sharing = this.valueCount(tenantId, feature, value)
      if (sharing === 0 || sharing > tooCommon) {
        continue
      }
      const rows = this.devicesWithValue.all(tenantId, feature, value, rule.rowsPerValue) as Array<{
        device_id: string
      }>
      if (rows.length === 0) {
        continue
      }
      // The weight is the rarity of the value among all devices, not among the ones that were read
      const weight = -Math.log(sharing / Math.max(1, total)) + 1e-9
      for (const row of rows) {
        rarity.set(row.device_id, (rarity.get(row.device_id) ?? 0) + weight)
      }
    }
    return [...rarity.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([deviceId]) => deviceId)
  }

  getProfiles(tenantId: string, deviceIds: readonly string[]): DeviceProfile[] {
    return deviceIds.flatMap((id) => {
      const profile = this.getProfile(tenantId, id)
      return profile ? [profile] : []
    })
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
  }

  saveResolution(tenantId: string, requestId: string, deviceId: string, resolution: Resolution): void {
    this.upsertResolution.run(tenantId, requestId, deviceId, JSON.stringify(resolution))
  }

  getResolution(tenantId: string, requestId: string): Resolution | undefined {
    const row = this.selectResolution.get(tenantId, requestId) as
      | { resolution_json: string; device_id: string }
      | undefined
    // The device the visit belongs to now: a merge or a split may have moved it since the visit was decided
    return row ? { ...(JSON.parse(row.resolution_json) as Resolution), visitorId: row.device_id } : undefined
  }

  resolveAlias(tenantId: string, deviceId: string): string {
    const row = this.db
      .prepare('SELECT to_id FROM identity_aliases WHERE tenant_id = ? AND from_id = ?')
      .get(tenantId, deviceId) as { to_id: string } | undefined
    return row?.to_id ?? deviceId
  }

  applyEdit(tenantId: string, edit: DeviceEdit): void {
    this.transaction(() => {
      const ids = [...(edit.remove ?? []), ...(edit.write ?? []).map((profile) => profile.deviceId)]
      // The triggers on these two tables keep the counters of the population right, for deletes and inserts alike
      for (const id of ids) {
        this.db.prepare('DELETE FROM identity_features WHERE tenant_id = ? AND device_id = ?').run(tenantId, id)
        this.db.prepare('DELETE FROM identity_devices WHERE tenant_id = ? AND device_id = ?').run(tenantId, id)
      }
      const insertDevice = this.db.prepare(
        'INSERT INTO identity_devices (tenant_id, device_id, created_at, last_seen_at, visits) VALUES (?, ?, ?, ?, ?)',
      )
      const insertFeature = this.db.prepare(
        `INSERT INTO identity_features (tenant_id, device_id, feature, value, count, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (const profile of edit.write ?? []) {
        insertDevice.run(tenantId, profile.deviceId, profile.firstSeen, profile.lastSeen, profile.visits)
        for (const [feature, values] of profile.features) {
          for (const [value, use] of values) {
            insertFeature.run(tenantId, profile.deviceId, feature, value, use.count, use.lastSeen)
          }
        }
      }
      const move = edit.moveVisits
      if (move?.from !== undefined) {
        this.db
          .prepare('UPDATE identity_resolutions SET device_id = ? WHERE tenant_id = ? AND device_id = ?')
          .run(move.to, tenantId, move.from)
      }
      for (const requestId of move?.requestIds ?? []) {
        this.db
          .prepare('UPDATE identity_resolutions SET device_id = ? WHERE tenant_id = ? AND request_id = ?')
          .run(move?.to ?? '', tenantId, requestId)
      }
      if (edit.alias) {
        this.db
          .prepare('UPDATE identity_aliases SET to_id = ? WHERE tenant_id = ? AND to_id = ?')
          .run(edit.alias.to, tenantId, edit.alias.from)
        this.db
          .prepare(
            'INSERT OR REPLACE INTO identity_aliases (tenant_id, from_id, to_id, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(tenantId, edit.alias.from, edit.alias.to, edit.alias.at)
      }
    })
  }

  anonymity(tenantId: string, k: number): FeatureAnonymity[] {
    const rows = this.db
      .prepare(
        `SELECT feature, SUM(devices) AS devices, COALESCE(SUM(CASE WHEN devices < ? THEN devices END), 0) AS below
           FROM identity_value_counts WHERE tenant_id = ? GROUP BY feature ORDER BY feature`,
      )
      .all(k, tenantId) as Array<{ feature: string; devices: number; below: number }>
    return rows.map((row) => ({ feature: row.feature, devices: Number(row.devices), devicesBelowK: Number(row.below) }))
  }

  devicesSeenFrom(tenantId: string, query: { ip: string; since: number; until: number; limit: number }): SeenDevice[] {
    const rows = this.db
      .prepare(
        `SELECT r.device_id AS device_id, MAX(e.received_at) AS last_seen
           FROM identity_resolutions r
           JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
          WHERE r.tenant_id = ? AND e.ip = ? AND e.received_at >= ? AND e.received_at <= ?
          GROUP BY r.device_id
          ORDER BY last_seen DESC, r.device_id
          LIMIT ?`,
      )
      .all(tenantId, query.ip, query.since, query.until, query.limit) as Array<{ device_id: string; last_seen: number }>
    return rows.map((row) => ({ deviceId: row.device_id, lastSeen: Number(row.last_seen) }))
  }

  devicesWithLinkedId(tenantId: string, linkedId: string, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT r.device_id AS device_id
           FROM identity_resolutions r
           JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
          WHERE r.tenant_id = ? AND e.linked_id = ?
          ORDER BY r.device_id LIMIT ?`,
      )
      .all(tenantId, linkedId, limit) as Array<{ device_id: string }>
    return rows.map((row) => row.device_id)
  }

  accountsOf(tenantId: string, deviceIds: readonly string[], limit: number): DeviceAccount[] {
    const found: DeviceAccount[] = []
    for (let i = 0; i < deviceIds.length && found.length < limit; i += 100) {
      const ids = deviceIds.slice(i, i + 100)
      const rows = this.db
        .prepare(
          `SELECT DISTINCT r.device_id AS device_id, e.linked_id AS linked_id
             FROM identity_resolutions r
             JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
            WHERE r.tenant_id = ? AND e.linked_id IS NOT NULL AND r.device_id IN (${ids.map(() => '?').join(',')})
            ORDER BY r.device_id, e.linked_id LIMIT ?`,
        )
        .all(tenantId, ...ids, limit - found.length) as Array<{ device_id: string; linked_id: string }>
      found.push(...rows.map((row) => ({ deviceId: row.device_id, linkedId: row.linked_id })))
    }
    return found
  }

  featureStability(tenantId: string): FeatureStability[] {
    const rows = this.db
      .prepare(
        `SELECT feature, COUNT(*) AS devices, COALESCE(SUM(CASE WHEN values_seen > 1 THEN 1 ELSE 0 END), 0) AS changed
           FROM (SELECT device_id, feature, COUNT(*) AS values_seen, SUM(count) AS read_total
                   FROM identity_features WHERE tenant_id = ? GROUP BY device_id, feature) AS per_device
          WHERE read_total >= 2 GROUP BY feature ORDER BY feature`,
      )
      .all(tenantId) as Array<{ feature: string; devices: number; changed: number }>
    return rows.map((row) => ({ feature: row.feature, devices: Number(row.devices), changed: Number(row.changed) }))
  }

  recentRequests(tenantId: string, deviceId: string, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT e.request_id AS request_id
           FROM identity_resolutions r
           JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
          WHERE r.tenant_id = ? AND r.device_id = ?
          ORDER BY e.received_at DESC, e.request_id DESC
          LIMIT ?`,
      )
      .all(tenantId, deviceId, limit) as Array<{ request_id: string }>
    return rows.map((row) => row.request_id)
  }

  activity(tenantId: string, query: ActivityQuery): Activity {
    if (query.deviceId === undefined && query.ip === undefined) {
      throw new Error('activity needs a device or an address')
    }
    const byDevice = query.deviceId !== undefined
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS visits, COUNT(DISTINCT r.device_id) AS devices,
                COUNT(DISTINCT e.linked_id) AS linked_ids, COUNT(DISTINCT e.ip) AS ips
           FROM identity_resolutions r
           JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
          WHERE r.tenant_id = ? AND e.received_at >= ? AND e.received_at <= ?
            AND ${byDevice ? 'r.device_id = ?' : 'e.ip = ?'}`,
      )
      .get(tenantId, query.since, query.until, (byDevice ? query.deviceId : query.ip) ?? '') as Record<string, number>
    return {
      visits: Number(row.visits),
      devices: Number(row.devices),
      linkedIds: Number(row.linked_ids),
      ips: Number(row.ips),
    }
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
      const count = Number(removed.run().changes)
      // A merged-away id means nothing once the device it points to is gone
      this.db.exec(`
        DELETE FROM identity_aliases WHERE NOT EXISTS (
          SELECT 1 FROM identity_devices d
          WHERE d.tenant_id = identity_aliases.tenant_id AND d.device_id = identity_aliases.to_id
        )
      `)
      return count
    })
  }
}
