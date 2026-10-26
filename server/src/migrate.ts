import type { DatabaseSync } from 'node:sqlite'

import type { MysqlDatabase } from './mysql/database'

/**
 * The tables that hold the data of the server, in an order that never needs a table that is not there yet. The counters
 * of the identity are not copied: they are counted again from the facts, which is how they are known to be right.
 * `used_nonces` is not copied either: a challenge lives for minutes and the ones in the old database are useless.
 */
export const copiedTables = [
  'tenants',
  'events',
  'identity_devices',
  'identity_features',
  'identity_resolutions',
  'identity_aliases',
  'identity_links',
  'webhook_deliveries',
  'audit_log',
  'usage_daily',
  'graph_edges',
] as const

export interface MigrationReport {
  /** Rows copied, by table */
  copied: Record<string, number>
  /** Problems found by the check at the end. Empty means that what is in MySQL is what was in SQLite. */
  problems: string[]
}

const batchSize = 1000

const count = async (db: MysqlDatabase, table: string): Promise<number> =>
  Number((await db.query<{ c: number }>(`SELECT COUNT(*) AS c FROM \`${table}\``))[0].c)

/**
 * Copies a SQLite database of this server into an empty MySQL one, counts the identity counters again and checks the
 * result. It reads SQLite and only adds to MySQL. The schema of MySQL must already exist (opening the storage makes
 * it).
 */
export async function migrateSqliteToMysql(options: {
  sqlite: DatabaseSync
  mysql: MysqlDatabase
  /** Copy into a MySQL database that already has data. Rows with the same key are an error, not overwritten. */
  append?: boolean
  log?: (line: string) => void
}): Promise<MigrationReport> {
  const { sqlite, mysql, append = false } = options
  const log = options.log ?? (() => undefined)
  if (!append) {
    for (const table of ['events', 'identity_devices', 'tenants']) {
      if ((await count(mysql, table)) > 0) {
        throw new Error(
          `The MySQL database already has data in "${table}". Migrate into an empty database, or use --append ` +
            'if you know that the rows do not overlap',
        )
      }
    }
  }
  const copied: Record<string, number> = {}
  const expected: Record<string, number> = {}
  for (const table of copiedTables) {
    const have = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    if (!have) {
      copied[table] = 0
      expected[table] = 0
      continue
    }
    const source = (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
    const target = new Set(
      (
        await mysql.query<{ name: string }>(
          `SELECT COLUMN_NAME AS name FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ?`,
          [table],
        )
      ).map((row) => row.name),
    )
    // Only the columns that both sides have. A column of MySQL that SQLite lacks takes its default.
    const columns = source.filter((name) => target.has(name))
    const list = columns.map((name) => `\`${name}\``).join(', ')
    const select = sqlite.prepare(`SELECT ${columns.map((name) => `"${name}"`).join(', ')} FROM ${table}`)
    expected[table] = Number((sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c)
    let rows: unknown[][] = []
    let done = 0
    const flush = async () => {
      if (rows.length > 0) {
        await mysql.run(`INSERT INTO \`${table}\` (${list}) VALUES ?`, [rows])
        done += rows.length
        rows = []
      }
    }
    for (const row of select.iterate() as Iterable<Record<string, unknown>>) {
      rows.push(columns.map((name) => row[name] ?? null))
      if (rows.length >= batchSize) {
        await flush()
      }
    }
    await flush()
    copied[table] = done
    log(`${table}: ${done} rows`)
  }

  // The counters are counted again from the facts, for the whole database
  await mysql.run('DELETE FROM identity_value_counts')
  await mysql.run('DELETE FROM identity_feature_stats')
  await mysql.run('DELETE FROM identity_tenant_stats')
  await mysql.run(
    `INSERT INTO identity_value_counts (tenant_id, feature, value, devices)
     SELECT tenant_id, feature, value, COUNT(*) FROM identity_features GROUP BY tenant_id, feature, value`,
  )
  await mysql.run(
    `INSERT INTO identity_feature_stats (tenant_id, feature, total, pairs)
     SELECT tenant_id, feature, SUM(devices), SUM(devices * (devices - 1) DIV 2)
       FROM identity_value_counts GROUP BY tenant_id, feature`,
  )
  await mysql.run(
    `INSERT INTO identity_tenant_stats (tenant_id, devices)
     SELECT tenant_id, COUNT(*) FROM identity_devices GROUP BY tenant_id`,
  )

  // The check: what is in MySQL must be what was in SQLite. With --append it can only check that nothing was lost.
  const problems: string[] = []
  for (const table of copiedTables) {
    const now = await count(mysql, table)
    if (append ? now < expected[table] : now !== expected[table]) {
      problems.push(`${table}: ${expected[table]} rows in SQLite, ${now} in MySQL`)
    }
  }
  const sqliteCounter = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'identity_value_counts'")
    .get()
  if (sqliteCounter && !append) {
    const was = Number((sqlite.prepare('SELECT COUNT(*) AS c FROM identity_value_counts').get() as { c: number }).c)
    const is = await count(mysql, 'identity_value_counts')
    if (was !== is) {
      problems.push(`identity_value_counts: ${was} counters in SQLite, ${is} counted again in MySQL`)
    }
  }
  return { copied, problems }
}
