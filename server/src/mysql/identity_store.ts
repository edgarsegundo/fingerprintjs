import type { Features } from '../identity/features'
import { PopulationStats, smoothedAgreementFromTotals } from '../identity/model'
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
} from '../identity/store'

import type { MysqlDatabase, Queryable } from './database'

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const pieces: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    pieces.push(items.slice(start, start + size))
  }
  return pieces
}

const pairKey = (feature: string, value: string) => `${feature}\u0000${value}`

/**
 * The identity tables in MySQL.
 *
 * The counters of the population (devices per value, totals per feature and per tenant) are kept by this code, in the
 * same transaction as the facts that they count. The SQLite store keeps them with triggers; MySQL triggers need
 * privileges that a shared server usually does not give to an application, and logic written once, in the code, is
 * tested in one place.
 *
 * A decision reads the population once for the features of the visit and then scores with plain functions, which is why
 * `population` takes the features: nothing is asked of the database while scoring.
 */
export class MysqlIdentityStore implements IdentityStore {
  constructor(private readonly db: MysqlDatabase) {}

  /** One turn at a time per tenant across every instance that uses this database */
  withTenantLock<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return this.db.withLock(`identity:${tenantId}`, work)
  }

  // --- Reading what is known

  private async valueCounts(db: Queryable, tenantId: string, features: Features): Promise<Map<string, number>> {
    const pairs = Object.entries(features)
    const counts = new Map<string, number>()
    if (pairs.length === 0) {
      return counts
    }
    const rows = await db.query<{ feature: string; value: string; devices: number }>(
      'SELECT feature, value, devices FROM identity_value_counts WHERE tenant_id = ? AND (feature, value) IN (?)',
      [tenantId, pairs],
    )
    for (const row of rows) {
      counts.set(pairKey(row.feature, row.value), Number(row.devices))
    }
    return counts
  }

  private async deviceCount(db: Queryable, tenantId: string): Promise<number> {
    const rows = await db.query<{ devices: number }>('SELECT devices FROM identity_tenant_stats WHERE tenant_id = ?', [
      tenantId,
    ])
    return Number(rows[0]?.devices ?? 0)
  }

  async population(tenantId: string, features: Features): Promise<PopulationStats> {
    const names = Object.keys(features)
    const [devices, counts, stats] = await Promise.all([
      this.deviceCount(this.db, tenantId),
      this.valueCounts(this.db, tenantId, features),
      names.length === 0
        ? Promise.resolve([] as Array<{ feature: string; total: number; pairs: number }>)
        : this.db.query<{ feature: string; total: number; pairs: number }>(
            'SELECT feature, total, pairs FROM identity_feature_stats WHERE tenant_id = ? AND feature IN (?)',
            [tenantId, names],
          ),
    ])
    const totals = new Map(stats.map((row) => [row.feature, row]))
    return {
      devices,
      // Only the values of this visit were read, and only those are asked while scoring
      devicesWithValue: (feature, value) => counts.get(pairKey(feature, value)) ?? 0,
      agreementProbability: (feature) => {
        const row = totals.get(feature)
        return smoothedAgreementFromTotals(Number(row?.total ?? 0), Number(row?.pairs ?? 0))
      },
    }
  }

  async findCandidates(
    tenantId: string,
    features: Features,
    limit: number,
    rule: CandidateRule = defaultCandidateRule,
  ): Promise<string[]> {
    const [total, counts] = await Promise.all([
      this.deviceCount(this.db, tenantId),
      this.valueCounts(this.db, tenantId, features),
    ])
    const tooCommon = Math.max(rule.minDevices, total * rule.maxShare)
    // A value that few devices share is read in full; one that too many share says little and is skipped
    const useful = Object.entries(features).filter(([feature, value]) => {
      const sharing = counts.get(pairKey(feature, value)) ?? 0
      return sharing > 0 && sharing <= tooCommon
    })
    if (useful.length === 0) {
      return []
    }
    // One small read for each value, the devices seen most recently first and no more than the rule allows. The index
    // `(tenant, feature, value, last_seen)` answers each of them without reading the others.
    const one =
      '(SELECT ? AS feature, ? AS value, device_id FROM identity_features ' +
      'WHERE tenant_id = ? AND feature = ? AND value = ? ORDER BY last_seen DESC LIMIT ?)'
    const rows = await this.db.query<{ feature: string; value: string; device_id: string }>(
      useful.map(() => one).join(' UNION ALL '),
      useful.flatMap(([feature, value]) => [feature, value, tenantId, feature, value, rule.rowsPerValue]),
    )
    const rarity = new Map<string, number>()
    for (const row of rows) {
      const sharing = counts.get(pairKey(row.feature, row.value)) ?? 1
      const weight = -Math.log(sharing / Math.max(1, total)) + 1e-9
      rarity.set(row.device_id, (rarity.get(row.device_id) ?? 0) + weight)
    }
    return [...rarity.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([deviceId]) => deviceId)
  }

  async getProfiles(tenantId: string, deviceIds: readonly string[]): Promise<DeviceProfile[]> {
    if (deviceIds.length === 0) {
      return []
    }
    const [devices, features] = await Promise.all([
      this.db.query<{ device_id: string; created_at: number; last_seen_at: number; visits: number }>(
        `SELECT device_id, created_at, last_seen_at, visits FROM identity_devices
          WHERE tenant_id = ? AND device_id IN (?)`,
        [tenantId, deviceIds],
      ),
      this.db.query<{ device_id: string; feature: string; value: string; count: number; last_seen: number }>(
        `SELECT device_id, feature, value, count, last_seen FROM identity_features
          WHERE tenant_id = ? AND device_id IN (?)`,
        [tenantId, deviceIds],
      ),
    ])
    const profiles = new Map<string, DeviceProfile>()
    for (const row of devices) {
      profiles.set(row.device_id, {
        deviceId: row.device_id,
        visits: Number(row.visits),
        firstSeen: Number(row.created_at),
        lastSeen: Number(row.last_seen_at),
        features: new Map(),
      })
    }
    for (const row of features) {
      const profile = profiles.get(row.device_id)
      if (!profile) {
        continue
      }
      let values = profile.features.get(row.feature)
      if (!values) {
        values = new Map()
        profile.features.set(row.feature, values)
      }
      values.set(row.value, { count: Number(row.count), lastSeen: Number(row.last_seen) })
    }
    // In the order that was asked for
    return deviceIds.flatMap((id) => {
      const profile = profiles.get(id)
      return profile ? [profile] : []
    })
  }

  async getProfile(tenantId: string, deviceId: string): Promise<DeviceProfile | undefined> {
    return (await this.getProfiles(tenantId, [deviceId]))[0]
  }

  // --- Writing

  async createDevice(tenantId: string, deviceId: string, features: Features, at: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run(
        'INSERT INTO identity_devices (tenant_id, device_id, created_at, last_seen_at, visits) VALUES (?, ?, ?, ?, 0)',
        [tenantId, deviceId, at, at],
      )
      await tx.run(
        `INSERT INTO identity_tenant_stats (tenant_id, devices) VALUES (?, 1) AS new
         ON DUPLICATE KEY UPDATE devices = identity_tenant_stats.devices + 1`,
        [tenantId],
      )
      await this.record(tx, tenantId, deviceId, features, at)
    })
  }

  async addObservation(tenantId: string, deviceId: string, features: Features, at: number): Promise<void> {
    await this.db.transaction((tx) => this.record(tx, tenantId, deviceId, features, at))
  }

  /**
   * Adds the visit to the device: bumps the values it already had, adds the new ones and brings the counters along. A
   * device gains at most one new value per feature in a visit, so each feature is touched once in the totals.
   */
  private async record(
    tx: Queryable,
    tenantId: string,
    deviceId: string,
    features: Features,
    at: number,
  ): Promise<void> {
    const touched = await tx.run(
      `UPDATE identity_devices SET visits = visits + 1, last_seen_at =
         GREATEST(last_seen_at, ?) WHERE tenant_id = ? AND device_id = ?`,
      [at, tenantId, deviceId],
    )
    if (touched.affected !== 1) {
      throw new Error('unknown device')
    }
    const pairs = Object.entries(features)
    if (pairs.length === 0) {
      return
    }
    // Take the lock of the device's rows first, so that two visits of one device do not both think a value is new
    const had = await tx.query<{ feature: string; value: string }>(
      `SELECT feature, value FROM identity_features
        WHERE tenant_id = ? AND device_id = ? AND feature IN (?) FOR UPDATE`,
      [tenantId, deviceId, pairs.map(([feature]) => feature)],
    )
    const hadKeys = new Set(had.map((row) => pairKey(row.feature, row.value)))
    const known = pairs.filter(([feature, value]) => hadKeys.has(pairKey(feature, value)))
    const fresh = pairs.filter(([feature, value]) => !hadKeys.has(pairKey(feature, value)))

    if (known.length > 0) {
      await tx.run(
        `UPDATE identity_features SET count = count + 1, last_seen = GREATEST(last_seen, ?)
         WHERE tenant_id = ? AND device_id = ? AND (feature, value) IN (?)`,
        [at, tenantId, deviceId, known],
      )
    }
    if (fresh.length === 0) {
      return
    }
    // How many devices already had each new value: a new device pairs with every one of them
    const old = await tx.query<{ feature: string; value: string; devices: number }>(
      `SELECT feature, value, devices FROM identity_value_counts WHERE
         tenant_id = ? AND (feature, value) IN (?) FOR UPDATE`,
      [tenantId, fresh],
    )
    const before = new Map(old.map((row) => [pairKey(row.feature, row.value), Number(row.devices)]))
    await tx.run('INSERT INTO identity_features (tenant_id, device_id, feature, value, count, last_seen) VALUES ?', [
      fresh.map(([feature, value]) => [tenantId, deviceId, feature, value, 1, at]),
    ])
    await tx.run(
      `INSERT INTO identity_value_counts (tenant_id, feature, value, devices) VALUES ? AS new
       ON DUPLICATE KEY UPDATE devices = identity_value_counts.devices + 1`,
      [fresh.map(([feature, value]) => [tenantId, feature, value, 1])],
    )
    await tx.run(
      `INSERT INTO identity_feature_stats (tenant_id, feature, total, pairs) VALUES ? AS new
       ON DUPLICATE KEY UPDATE total = identity_feature_stats.total + new.total,
                               pairs = identity_feature_stats.pairs + new.pairs`,
      [fresh.map(([feature, value]) => [tenantId, feature, 1, before.get(pairKey(feature, value)) ?? 0])],
    )
  }

  async saveResolution(tenantId: string, requestId: string, deviceId: string, resolution: Resolution): Promise<void> {
    await this.db.run(
      `INSERT INTO identity_resolutions (tenant_id, request_id, device_id, resolution_json) VALUES (?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE device_id = new.device_id, resolution_json = new.resolution_json`,
      [tenantId, requestId, deviceId, JSON.stringify(resolution)],
    )
  }

  async getResolution(tenantId: string, requestId: string): Promise<Resolution | undefined> {
    const rows = await this.db.query<{ resolution_json: string; device_id: string }>(
      'SELECT resolution_json, device_id FROM identity_resolutions WHERE tenant_id = ? AND request_id = ?',
      [tenantId, requestId],
    )
    // The device the visit belongs to now: a merge or a split may have moved it since the visit was decided
    return rows[0] && { ...(JSON.parse(rows[0].resolution_json) as Resolution), visitorId: rows[0].device_id }
  }

  async resolveAlias(tenantId: string, deviceId: string): Promise<string> {
    const rows = await this.db.query<{ to_id: string }>(
      'SELECT to_id FROM identity_aliases WHERE tenant_id = ? AND from_id = ?',
      [tenantId, deviceId],
    )
    return rows[0]?.to_id ?? deviceId
  }

  async applyEdit(tenantId: string, edit: DeviceEdit): Promise<void> {
    const written = edit.write ?? []
    const ids = [...new Set([...(edit.remove ?? []), ...written.map((profile) => profile.deviceId)])]
    await this.db.transaction(async (tx) => {
      const touched = new Map<string, { feature: string; value: string }>()
      const touch = (feature: string, value: string) => touched.set(pairKey(feature, value), { feature, value })
      if (ids.length > 0) {
        const old = await tx.query<{ feature: string; value: string }>(
          'SELECT DISTINCT feature, value FROM identity_features WHERE tenant_id = ? AND device_id IN (?) FOR UPDATE',
          [tenantId, ids],
        )
        old.forEach((row) => touch(row.feature, row.value))
        await tx.run('DELETE FROM identity_features WHERE tenant_id = ? AND device_id IN (?)', [tenantId, ids])
        await tx.run('DELETE FROM identity_devices WHERE tenant_id = ? AND device_id IN (?)', [tenantId, ids])
      }
      if (written.length > 0) {
        await tx.run('INSERT INTO identity_devices (tenant_id, device_id, created_at, last_seen_at, visits) VALUES ?', [
          written.map((p) => [tenantId, p.deviceId, p.firstSeen, p.lastSeen, p.visits]),
        ])
        const rows: unknown[][] = []
        for (const profile of written) {
          for (const [feature, values] of profile.features) {
            for (const [value, use] of values) {
              rows.push([tenantId, profile.deviceId, feature, value, use.count, use.lastSeen])
              touch(feature, value)
            }
          }
        }
        for (const part of chunk(rows, 500)) {
          await tx.run(
            'INSERT INTO identity_features (tenant_id, device_id, feature, value, count, last_seen) VALUES ?',
            [part],
          )
        }
      }
      if (ids.length > 0) {
        await this.recount(tx, tenantId, [...touched.values()])
      }
      const move = edit.moveVisits
      if (move?.from !== undefined) {
        await tx.run('UPDATE identity_resolutions SET device_id = ? WHERE tenant_id = ? AND device_id = ?', [
          move.to,
          tenantId,
          move.from,
        ])
      }
      for (const part of chunk([...(move?.requestIds ?? [])], 500)) {
        await tx.run('UPDATE identity_resolutions SET device_id = ? WHERE tenant_id = ? AND request_id IN (?)', [
          move?.to ?? '',
          tenantId,
          part,
        ])
      }
      if (edit.alias) {
        await tx.run('UPDATE identity_aliases SET to_id = ? WHERE tenant_id = ? AND to_id = ?', [
          edit.alias.to,
          tenantId,
          edit.alias.from,
        ])
        await tx.run(
          `INSERT INTO identity_aliases (tenant_id, from_id, to_id, created_at) VALUES (?, ?, ?, ?) AS new
           ON DUPLICATE KEY UPDATE to_id = new.to_id, created_at = new.created_at`,
          [tenantId, edit.alias.from, edit.alias.to, edit.alias.at],
        )
      }
    })
  }

  /**
   * Forgets the resolutions whose event was deleted, and then the devices that no resolution points to any more, with
   * their values. The counters of every value and feature they had are counted again from what is left, so that they
   * are right whatever way the devices went.
   */
  async removeOrphans(): Promise<number> {
    await this.db.run(
      `DELETE r FROM identity_resolutions r WHERE NOT EXISTS (
         SELECT 1 FROM events e WHERE e.tenant_id = r.tenant_id AND e.request_id = r.request_id)`,
    )
    let removed = 0
    for (;;) {
      const orphans = await this.db.query<{ tenant_id: string; device_id: string }>(
        `SELECT d.tenant_id, d.device_id FROM identity_devices d WHERE NOT EXISTS (
           SELECT 1 FROM identity_resolutions r WHERE r.tenant_id = d.tenant_id AND r.device_id = d.device_id)
         LIMIT 200`,
      )
      if (orphans.length === 0) {
        // A merged-away id means nothing once the device it points to is gone
        await this.db.run(
          `DELETE a FROM identity_aliases a WHERE NOT EXISTS (
             SELECT 1 FROM identity_devices d WHERE d.tenant_id = a.tenant_id AND d.device_id = a.to_id)`,
        )
        return removed
      }
      removed += await this.db.transaction((tx) => this.forget(tx, orphans))
    }
  }

  private async forget(
    tx: Queryable,
    orphans: ReadonlyArray<{ tenant_id: string; device_id: string }>,
  ): Promise<number> {
    const byTenant = new Map<string, string[]>()
    for (const { tenant_id: tenantId, device_id: deviceId } of orphans) {
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), deviceId])
    }
    let removed = 0
    for (const [tenantId, ids] of byTenant) {
      const values = await tx.query<{ feature: string; value: string }>(
        'SELECT DISTINCT feature, value FROM identity_features WHERE tenant_id = ? AND device_id IN (?) FOR UPDATE',
        [tenantId, ids],
      )
      await tx.run('DELETE FROM identity_features WHERE tenant_id = ? AND device_id IN (?)', [tenantId, ids])
      removed += (
        await tx.run('DELETE FROM identity_devices WHERE tenant_id = ? AND device_id IN (?)', [tenantId, ids])
      ).affected
      await this.recount(tx, tenantId, values)
    }
    return removed
  }

  /**
   * Counts again, from the facts, the counters of the given values and of the features they belong to, and the
   * number of devices of the tenant. Counting again is right whatever way the devices went in or out.
   */
  private async recount(
    tx: Queryable,
    tenantId: string,
    values: ReadonlyArray<{ feature: string; value: string }>,
  ): Promise<void> {
    for (const pairs of chunk(
      values.map((row) => [row.feature, row.value]),
      500,
    )) {
      await tx.run('DELETE FROM identity_value_counts WHERE tenant_id = ? AND (feature, value) IN (?)', [
        tenantId,
        pairs,
      ])
      await tx.run(
        `INSERT INTO identity_value_counts (tenant_id, feature, value, devices)
         SELECT tenant_id, feature, value, COUNT(*) FROM identity_features
          WHERE tenant_id = ? AND (feature, value) IN (?) GROUP BY tenant_id, feature, value`,
        [tenantId, pairs],
      )
    }
    const features = [...new Set(values.map((row) => row.feature))]
    for (const names of chunk(features, 200)) {
      await tx.run('DELETE FROM identity_feature_stats WHERE tenant_id = ? AND feature IN (?)', [tenantId, names])
      await tx.run(
        `INSERT INTO identity_feature_stats (tenant_id, feature, total, pairs)
         SELECT tenant_id, feature, SUM(devices), SUM(devices * (devices - 1) DIV 2) FROM identity_value_counts
          WHERE tenant_id = ? AND feature IN (?) GROUP BY tenant_id, feature`,
        [tenantId, names],
      )
    }
    await tx.run('DELETE FROM identity_tenant_stats WHERE tenant_id = ?', [tenantId])
    await tx.run(
      `INSERT INTO identity_tenant_stats (tenant_id, devices) SELECT tenant_id,
       COUNT(*) FROM identity_devices WHERE tenant_id = ? GROUP BY tenant_id`,
      [tenantId],
    )
  }

  // --- Questions about activity

  async activity(tenantId: string, query: ActivityQuery): Promise<Activity> {
    if (query.deviceId === undefined && query.ip === undefined) {
      throw new Error('activity needs a device or an address')
    }
    const byDevice = query.deviceId !== undefined
    const [row] = await this.db.query<{ visits: number; devices: number; linked_ids: number; ips: number }>(
      `SELECT COUNT(*) AS visits, COUNT(DISTINCT r.device_id) AS devices,
              COUNT(DISTINCT e.linked_id) AS linked_ids, COUNT(DISTINCT e.ip) AS ips
         FROM identity_resolutions r
         JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
        WHERE r.tenant_id = ? AND e.received_at >= ? AND e.received_at <= ?
          AND ${byDevice ? 'r.device_id = ?' : 'e.ip = ?'}`,
      [tenantId, query.since, query.until, (byDevice ? query.deviceId : query.ip) ?? ''],
    )
    return {
      visits: Number(row.visits),
      devices: Number(row.devices),
      linkedIds: Number(row.linked_ids),
      ips: Number(row.ips),
    }
  }

  async devicesSeenFrom(
    tenantId: string,
    query: { ip: string; since: number; until: number; limit: number },
  ): Promise<SeenDevice[]> {
    const rows = await this.db.query<{ device_id: string; last_seen: number }>(
      `SELECT r.device_id AS device_id, MAX(e.received_at) AS last_seen
           FROM identity_resolutions r
           JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
          WHERE r.tenant_id = ? AND e.ip = ? AND e.received_at >= ? AND e.received_at <= ?
          GROUP BY r.device_id
          ORDER BY last_seen DESC, r.device_id
          LIMIT ?`,
      [tenantId, query.ip, query.since, query.until, query.limit],
    )
    return rows.map((row) => ({ deviceId: row.device_id, lastSeen: Number(row.last_seen) }))
  }

  async devicesWithLinkedId(tenantId: string, linkedId: string, limit: number): Promise<string[]> {
    const rows = await this.db.query<{ device_id: string }>(
      `SELECT DISTINCT r.device_id AS device_id
         FROM identity_resolutions r
         JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
        WHERE r.tenant_id = ? AND e.linked_id = ?
        ORDER BY r.device_id LIMIT ?`,
      [tenantId, linkedId, limit],
    )
    return rows.map((row) => row.device_id)
  }

  async accountsOf(tenantId: string, deviceIds: readonly string[], limit: number): Promise<DeviceAccount[]> {
    const found: DeviceAccount[] = []
    for (let i = 0; i < deviceIds.length && found.length < limit; i += 100) {
      const rows = await this.db.query<{ device_id: string; linked_id: string }>(
        `SELECT DISTINCT r.device_id AS device_id, e.linked_id AS linked_id
           FROM identity_resolutions r
           JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
          WHERE r.tenant_id = ? AND e.linked_id IS NOT NULL AND r.device_id IN (?)
          ORDER BY r.device_id, e.linked_id LIMIT ?`,
        [tenantId, deviceIds.slice(i, i + 100), limit - found.length],
      )
      found.push(...rows.map((row) => ({ deviceId: row.device_id, linkedId: row.linked_id })))
    }
    return found
  }

  async featureStability(tenantId: string): Promise<FeatureStability[]> {
    const rows = await this.db.query<{ feature: string; devices: number; changed: number }>(
      `SELECT feature, COUNT(*) AS devices, COALESCE(SUM(CASE WHEN values_seen > 1 THEN 1 ELSE 0 END), 0) AS changed
         FROM (SELECT device_id, feature, COUNT(*) AS values_seen, SUM(count) AS read_total
                 FROM identity_features WHERE tenant_id = ? GROUP BY device_id, feature) AS per_device
        WHERE read_total >= 2 GROUP BY feature ORDER BY feature`,
      [tenantId],
    )
    return rows.map((row) => ({ feature: row.feature, devices: Number(row.devices), changed: Number(row.changed) }))
  }

  async recentRequests(tenantId: string, deviceId: string, limit: number): Promise<string[]> {
    const rows = await this.db.query<{ request_id: string }>(
      `SELECT e.request_id AS request_id
         FROM identity_resolutions r
         JOIN events e ON e.tenant_id = r.tenant_id AND e.request_id = r.request_id
        WHERE r.tenant_id = ? AND r.device_id = ?
        ORDER BY e.received_at DESC, e.request_id DESC
        LIMIT ?`,
      [tenantId, deviceId, limit],
    )
    return rows.map((row) => row.request_id)
  }

  async anonymity(tenantId: string, k: number): Promise<FeatureAnonymity[]> {
    const rows = await this.db.query<{ feature: string; devices: number; below: number }>(
      `SELECT feature, SUM(devices) AS devices, COALESCE(SUM(CASE WHEN devices < ? THEN devices END), 0) AS below
         FROM identity_value_counts WHERE tenant_id = ? GROUP BY feature ORDER BY feature`,
      [k, tenantId],
    )
    return rows.map((row) => ({ feature: row.feature, devices: Number(row.devices), devicesBelowK: Number(row.below) }))
  }
}
