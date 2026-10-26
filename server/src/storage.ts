import type { AuditLog } from './audit/log'
import { MemoryAuditLog, SqliteAuditLog } from './audit/log'
import type { Config } from './config'
import { GraphStore, MemoryGraphStore, SqliteGraphStore } from './graph/store'
import { MemoryIdentityStore } from './identity/memory_store'
import { SqliteIdentityStore } from './identity/sqlite_store'
import type { IdentityStore } from './identity/store'
import type { SharedLimits } from './ingest/ratelimit'
import { MysqlDatabase } from './mysql/database'
import { MysqlEventStore } from './mysql/event_store'
import { MysqlIdentityStore } from './mysql/identity_store'
import { MysqlPersonStore } from './mysql/person_store'
import { MysqlRateLimits } from './mysql/rate_limits'
import { createSchema } from './mysql/schema'
import {
  MysqlAuditLog,
  MysqlGraphStore,
  MysqlTenantStore,
  MysqlUsageMeter,
  MysqlWebhookQueue,
} from './mysql/small_stores'
import { MemoryPersonStore, PersonStore, SqlitePersonStore } from './person/store'
import { MemoryEventStore } from './store/memory'
import { SqliteEventStore } from './store/sqlite'
import type { EventStore } from './store/types'
import { MemoryTenantStore, SqliteTenantStore, TenantStore } from './tenants/store'
import { MemoryUsageMeter, SqliteUsageMeter, UsageMeter } from './usage/meter'
import { MemoryWebhookQueue, SqliteWebhookQueue, WebhookQueue } from './webhooks/queue'

/** Everything the server keeps, behind one object, whatever the database is */
export interface Storage {
  kind: 'memory' | 'sqlite' | 'mysql'
  events: EventStore
  identity: IdentityStore
  webhooks: WebhookQueue
  audit: AuditLog
  tenants: TenantStore
  usage: UsageMeter
  graph: GraphStore
  /** The ties between devices, from which a person is worked out */
  person: PersonStore
  /** Rate limits that several instances share. Only a store on the network has it. */
  sharedLimits?: SharedLimits
  /** The connection to MySQL, for the tools that work on the tables themselves (the migration). Only MySQL has it. */
  mysql?: MysqlDatabase
  close(): Promise<void>
}

/** Everything in the memory of the process, lost when it ends. For tests and for trying the server. */
export function memoryStorage(): Storage {
  const events = new MemoryEventStore()
  return aroundMemoryEvents(events)
}

function aroundMemoryEvents(events: EventStore): Storage {
  return {
    kind: 'memory',
    events,
    // The memory store of identities asks the store of events for what it needs to answer, so it is given a way in
    identity: new MemoryIdentityStore((tenantId, requestId) => {
      const event = (events as MemoryEventStore).getEvent(tenantId, requestId)
      return event && { ip: event.network.ip, linkedId: event.payload.linkedId, receivedAt: event.receivedAt }
    }),
    webhooks: new MemoryWebhookQueue(),
    audit: new MemoryAuditLog(),
    tenants: new MemoryTenantStore(),
    usage: new MemoryUsageMeter(),
    graph: new MemoryGraphStore(),
    person: new MemoryPersonStore(),
    close: () => Promise.resolve(events.close()),
  }
}

function aroundSqlite(events: SqliteEventStore): Storage {
  const db = events.connection
  return {
    kind: 'sqlite',
    events,
    identity: new SqliteIdentityStore(db),
    webhooks: new SqliteWebhookQueue(db),
    audit: new SqliteAuditLog(db),
    tenants: new SqliteTenantStore(db),
    usage: new SqliteUsageMeter(db),
    graph: new SqliteGraphStore(db),
    person: new SqlitePersonStore(db),
    close: () => Promise.resolve(events.close()),
  }
}

/** The storage around an event store that the caller made. Used by tests that bring their own. */
export function storageAround(events: EventStore): Storage {
  return events instanceof SqliteEventStore ? aroundSqlite(events) : aroundMemoryEvents(events)
}

export function sqliteStorage(path: string): Storage {
  return aroundSqlite(new SqliteEventStore(path))
}

export async function mysqlStorage(database: MysqlDatabase): Promise<Storage> {
  await createSchema(database, undefined, (work) => database.withLock('schema', work))
  return {
    kind: 'mysql',
    events: new MysqlEventStore(database),
    identity: new MysqlIdentityStore(database),
    webhooks: new MysqlWebhookQueue(database),
    audit: new MysqlAuditLog(database),
    tenants: new MysqlTenantStore(database),
    usage: new MysqlUsageMeter(database),
    graph: new MysqlGraphStore(database),
    person: new MysqlPersonStore(database),
    sharedLimits: new MysqlRateLimits(database),
    mysql: database,
    close: () => database.close(),
  }
}

/** Opens the storage that the configuration asks for. Throws, with the reason, if it cannot. */
export async function openStorage(config: Config): Promise<Storage> {
  const { database } = config
  if (database.type === 'sqlite') {
    return sqliteStorage(database.path)
  }
  const password = database.password ?? process.env[database.passwordEnv]
  if (password === undefined || password === '') {
    throw new Error(
      `Config: the MySQL password is not set. Put it in the environment variable ${database.passwordEnv} ` +
        '(better than in the file), or in database.password',
    )
  }
  return mysqlStorage(await MysqlDatabase.connect({ ...database, password }))
}
