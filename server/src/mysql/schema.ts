import type { Queryable } from './database'

/**
 * The tables. Every text column is `utf8mb4_bin`: the values are compared as they are, with no folding of case or
 * accents, as in SQLite. Key lengths are chosen so that every index fits the limit of InnoDB (3072 bytes, four per
 * character). `CREATE TABLE IF NOT EXISTS` makes starting again harmless; a change of a table later needs its own step.
 */
const options = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin'

const statements = [
  `CREATE TABLE IF NOT EXISTS events (
     request_id VARCHAR(64) NOT NULL PRIMARY KEY,
     tenant_id VARCHAR(64) NOT NULL,
     received_at BIGINT NOT NULL,
     ip VARCHAR(64) NOT NULL,
     ja4 VARCHAR(64) NULL,
     header_fp VARCHAR(64) NOT NULL,
     linked_id VARCHAR(128) NULL,
     payload_json MEDIUMTEXT NOT NULL,
     network_json MEDIUMTEXT NOT NULL,
     derived_json TEXT NOT NULL,
     KEY events_tenant_time (tenant_id, received_at, request_id),
     KEY events_tenant_ja4 (tenant_id, ja4),
     KEY events_tenant_linked (tenant_id, linked_id),
     KEY events_tenant_ip (tenant_id, ip, received_at)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS used_nonces (
     fingerprint VARCHAR(128) NOT NULL PRIMARY KEY,
     expires_at BIGINT NOT NULL,
     KEY used_nonces_expiry (expires_at)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS identity_devices (
     tenant_id VARCHAR(64) NOT NULL,
     device_id VARCHAR(48) NOT NULL,
     created_at BIGINT NOT NULL,
     last_seen_at BIGINT NOT NULL,
     visits INT NOT NULL,
     PRIMARY KEY (tenant_id, device_id)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS identity_features (
     tenant_id VARCHAR(64) NOT NULL,
     device_id VARCHAR(48) NOT NULL,
     feature VARCHAR(64) NOT NULL,
     value VARCHAR(190) NOT NULL,
     count INT NOT NULL,
     last_seen BIGINT NOT NULL,
     PRIMARY KEY (tenant_id, device_id, feature, value),
     KEY identity_features_by_value (tenant_id, feature, value, device_id)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS identity_resolutions (
     tenant_id VARCHAR(64) NOT NULL,
     request_id VARCHAR(64) NOT NULL,
     device_id VARCHAR(48) NOT NULL,
     resolution_json MEDIUMTEXT NOT NULL,
     PRIMARY KEY (tenant_id, request_id),
     KEY identity_resolutions_device (tenant_id, device_id)
   ) ${options}`,
  // Running counters, kept by the code in the same transaction as the facts (not by triggers, which need privileges
  // that a shared server often does not give)
  `CREATE TABLE IF NOT EXISTS rate_windows (
     bucket CHAR(32) NOT NULL,
     window_start BIGINT NOT NULL,
     hits INT NOT NULL,
     PRIMARY KEY (bucket, window_start),
     KEY rate_windows_start (window_start)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS identity_aliases (
     tenant_id VARCHAR(64) NOT NULL,
     from_id VARCHAR(64) NOT NULL,
     to_id VARCHAR(64) NOT NULL,
     created_at BIGINT NOT NULL,
     PRIMARY KEY (tenant_id, from_id),
     KEY identity_aliases_to (tenant_id, to_id)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS identity_value_counts (
     tenant_id VARCHAR(64) NOT NULL,
     feature VARCHAR(64) NOT NULL,
     value VARCHAR(190) NOT NULL,
     devices INT NOT NULL,
     PRIMARY KEY (tenant_id, feature, value)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS identity_feature_stats (
     tenant_id VARCHAR(64) NOT NULL,
     feature VARCHAR(64) NOT NULL,
     total BIGINT NOT NULL,
     pairs BIGINT NOT NULL,
     PRIMARY KEY (tenant_id, feature)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS identity_tenant_stats (
     tenant_id VARCHAR(64) NOT NULL PRIMARY KEY,
     devices INT NOT NULL
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     id VARCHAR(64) NOT NULL PRIMARY KEY,
     tenant_id VARCHAR(64) NOT NULL,
     endpoint_id VARCHAR(64) NOT NULL,
     body MEDIUMTEXT NOT NULL,
     attempts INT NOT NULL DEFAULT 0,
     next_attempt_at BIGINT NOT NULL,
     status VARCHAR(16) NOT NULL,
     last_error TEXT NULL,
     created_at BIGINT NOT NULL,
     finished_at BIGINT NULL,
     KEY webhook_deliveries_due (status, next_attempt_at),
     KEY webhook_deliveries_tenant (tenant_id, status, created_at)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     seq BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
     at BIGINT NOT NULL,
     tenant_id VARCHAR(64) NOT NULL,
     action VARCHAR(48) NOT NULL,
     subject VARCHAR(128) NOT NULL,
     key_id VARCHAR(16) NOT NULL,
     requester VARCHAR(64) NOT NULL,
     status INT NOT NULL,
     KEY audit_log_tenant (tenant_id, seq)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS tenants (
     id VARCHAR(64) NOT NULL PRIMARY KEY,
     public_key VARCHAR(128) NOT NULL,
     record_json MEDIUMTEXT NOT NULL,
     created_at BIGINT NOT NULL,
     UNIQUE KEY tenants_public_key (public_key)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS usage_daily (
     tenant_id VARCHAR(64) NOT NULL,
     day CHAR(10) NOT NULL,
     metric VARCHAR(32) NOT NULL,
     count BIGINT NOT NULL,
     PRIMARY KEY (tenant_id, day, metric)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS graph_edges (
     graph_key VARCHAR(64) NOT NULL,
     tenant_id VARCHAR(64) NOT NULL,
     last_seen BIGINT NOT NULL,
     last_flagged BIGINT NOT NULL DEFAULT 0,
     PRIMARY KEY (graph_key, tenant_id),
     KEY graph_edges_tenant (tenant_id),
     KEY graph_edges_seen (last_seen)
   ) ${options}`,
  `CREATE TABLE IF NOT EXISTS identity_links (
     tenant_id VARCHAR(64) NOT NULL,
     a VARCHAR(48) NOT NULL,
     b VARCHAR(48) NOT NULL,
     kind VARCHAR(16) NOT NULL,
     strength DOUBLE NOT NULL,
     first_seen BIGINT NOT NULL,
     last_seen BIGINT NOT NULL,
     days INT NOT NULL DEFAULT 1,
     status VARCHAR(10) NOT NULL DEFAULT 'auto',
     PRIMARY KEY (tenant_id, a, b, kind),
     KEY identity_links_b (tenant_id, b),
     KEY identity_links_seen (tenant_id, last_seen)
   ) ${options}`,
]

/**
 * Changes to tables that already exist (a new column, a new index). `CREATE TABLE IF NOT EXISTS` above never alters a
 * table, so a change goes here as a new entry at the end. Each entry runs once, in order, and is recorded in
 * `schema_migrations`. Never edit or reorder an entry that has shipped: add a new one.
 */
export interface Migration {
  id: number
  name: string
  statements: string[]
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'a webhook delivery can be claimed by one instance of the server',
    statements: [
      'ALTER TABLE webhook_deliveries ADD COLUMN claimed_by VARCHAR(64) NULL, ADD COLUMN claimed_until BIGINT NULL',
    ],
  },
  {
    id: 2,
    name: 'the devices of a value can be read most recent first',
    statements: ['CREATE INDEX identity_features_by_seen ON identity_features (tenant_id, feature, value, last_seen)'],
  },
]

/**
 * Makes the tables and runs the migrations that were not run yet. Several instances of the server may start together
 * against one database, so the whole thing runs under `lock` (a lock that all of them respect), and the list of what
 * was run is read after the lock is held, not before.
 */
export async function createSchema(
  db: Queryable,
  steps: readonly Migration[] = migrations,
  lock: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
): Promise<void> {
  await lock(() => build(db, steps))
}

async function build(db: Queryable, steps: readonly Migration[]): Promise<void> {
  for (const statement of statements) {
    await db.run(statement)
  }
  await db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id INT NOT NULL PRIMARY KEY,
       name VARCHAR(128) NOT NULL,
       applied_at BIGINT NOT NULL
     ) ${options}`,
  )
  const applied = new Set((await db.query<{ id: number }>('SELECT id FROM schema_migrations')).map((row) => row.id))
  for (const step of [...steps].sort((a, b) => a.id - b.id)) {
    if (applied.has(step.id)) {
      continue
    }
    for (const statement of step.statements) {
      await db.run(statement)
    }
    await db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
      step.id,
      step.name,
      Date.now(),
    ])
  }
}
