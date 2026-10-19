import { randomBytes } from 'node:crypto'

import { MysqlDatabase } from '../mysql/database'
import { mysqlStorage, Storage } from '../storage'

/**
 * MySQL for the tests. Set `FP_TEST_MYSQL_URL` (such as `mysql://root:secret@127.0.0.1:3306`) to a server where the
 * user may create and drop databases, and the tests that run on every store also run on MySQL. Without it they are
 * skipped, and the rest of the suite does not need MySQL. Each test gets a database of its own, dropped at the end.
 */
export const mysqlTestUrl = process.env.FP_TEST_MYSQL_URL

export const mysqlAvailable = mysqlTestUrl !== undefined && mysqlTestUrl !== ''

function parse(url: string) {
  const parsed = new URL(url)
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  }
}

const made: Array<{ name: string; storage: Storage }> = []

/** A storage on MySQL in a database that did not exist a moment ago */
export async function newMysqlStorage(): Promise<Storage> {
  return (await newMysqlStorageWithDatabase()).storage
}

/** The same, with the connection too, for the tests that look at the tables themselves */
export async function newMysqlStorageWithDatabase(): Promise<{
  storage: Storage
  database: MysqlDatabase
  /** Another connection to the same database, the way a second instance of the server would have */
  another(): Promise<Storage>
}> {
  if (!mysqlTestUrl) {
    throw new Error('FP_TEST_MYSQL_URL is not set')
  }
  const server = parse(mysqlTestUrl)
  const name = `fp_test_${randomBytes(6).toString('hex')}`
  const admin = await MysqlDatabase.connect({
    ...server,
    database: 'mysql',
    connectionLimit: 1,
    ssl: false,
    connectTimeoutMs: 5000,
  })
  try {
    await admin.run(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  } finally {
    await admin.close()
  }
  const database = await MysqlDatabase.connect({
    ...server,
    database: name,
    connectionLimit: 8,
    ssl: false,
    connectTimeoutMs: 5000,
  })
  const storage = await mysqlStorage(database)
  made.push({ name, storage })
  const another = async () => {
    const second = await MysqlDatabase.connect({
      ...server,
      database: name,
      connectionLimit: 8,
      ssl: false,
      connectTimeoutMs: 5000,
    })
    const twin = await mysqlStorage(second)
    made.push({ name, storage: twin })
    return twin
  }
  return { storage, database, another }
}

/** Closes every storage made by `newMysqlStorage` and drops its database */
export async function dropMysqlStorages(): Promise<void> {
  if (!mysqlTestUrl || made.length === 0) {
    return
  }
  const server = parse(mysqlTestUrl)
  const admin = await MysqlDatabase.connect({
    ...server,
    database: 'mysql',
    connectionLimit: 1,
    ssl: false,
    connectTimeoutMs: 5000,
  })
  try {
    for (const { name, storage } of made.splice(0)) {
      await storage.close().catch(() => undefined)
      await admin.run(`DROP DATABASE IF EXISTS \`${name}\``)
    }
  } finally {
    await admin.close()
  }
}

/** The options for the config of a server on MySQL in a database of its own (for the end-to-end tests) */
export async function newMysqlDatabaseConfig(): Promise<{ config: Record<string, unknown>; drop(): Promise<void> }> {
  if (!mysqlTestUrl) {
    throw new Error('FP_TEST_MYSQL_URL is not set')
  }
  const server = parse(mysqlTestUrl)
  const name = `fp_test_${randomBytes(6).toString('hex')}`
  const admin = await MysqlDatabase.connect({
    ...server,
    database: 'mysql',
    connectionLimit: 1,
    ssl: false,
    connectTimeoutMs: 5000,
  })
  try {
    await admin.run(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)
  } finally {
    await admin.close()
  }
  return {
    config: {
      type: 'mysql',
      host: server.host,
      port: server.port,
      user: server.user,
      password: server.password,
      database: name,
      connectionLimit: 8,
    },
    async drop() {
      const cleaner = await MysqlDatabase.connect({
        ...server,
        database: 'mysql',
        connectionLimit: 1,
        ssl: false,
        connectTimeoutMs: 5000,
      })
      try {
        await cleaner.run(`DROP DATABASE IF EXISTS \`${name}\``)
      } finally {
        await cleaner.close()
      }
    },
  }
}
