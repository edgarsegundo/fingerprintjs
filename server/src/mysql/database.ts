import { createHash } from 'node:crypto'

import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise'

export interface MysqlOptions {
  host: string
  port: number
  user: string
  password: string
  database: string
  /** The most connections the server holds open. The database is shared, so keep it small. */
  connectionLimit: number
  /** Connections for the named locks, apart from the ones that do the work (see `withLock`). Default 16. */
  lockConnections?: number
  /** How long `withLock` waits for its turn, in seconds. Default 15. */
  lockWaitSeconds?: number
  /** Use TLS and check the certificate of the server */
  ssl: boolean
  connectTimeoutMs: number
}

/** What a statement can be sent through: the pool, or one connection inside a transaction */
export interface Queryable {
  /** A statement that returns rows */
  query<T extends object = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /** A statement that changes data. Returns how many rows it changed (or, for an insert, added). */
  run(sql: string, params?: readonly unknown[]): Promise<{ affected: number; insertId: number }>
}

const deadlock = 1213
const lockWait = 1205

const isRetryable = (error: unknown): boolean => {
  const errno = typeof error === 'object' && error !== null ? (error as { errno?: number }).errno : undefined
  return errno === deadlock || errno === lockWait
}

/**
 * The MySQL connection of the server. The driver (`mysql2`) is loaded only here and only when MySQL is used, so a
 * server that keeps its data in SQLite does not need it installed.
 *
 * Values always go as parameters (`?`); the text of a statement is written in the code and never built from what a
 * client sent. Numbers come back as numbers, including sums.
 */
export class MysqlDatabase implements Queryable {
  private constructor(
    private readonly pool: Pool,
    private readonly lockPool: Pool,
    /** Locks are named for the whole server, so the name carries the database: two databases do not share a lock */
    private readonly databaseName: string,
    private readonly lockWaitSeconds: number,
  ) {}

  static async connect(options: MysqlOptions): Promise<MysqlDatabase> {
    let driver: typeof import('mysql2/promise')
    try {
      driver = await import('mysql2/promise')
    } catch {
      throw new Error('MySQL needs the package "mysql2": install it next to the server (npm install mysql2)')
    }
    const settings = (connectionLimit: number) => ({
      host: options.host,
      port: options.port,
      user: options.user,
      password: options.password,
      database: options.database,
      connectionLimit,
      connectTimeout: options.connectTimeoutMs,
      charset: 'utf8mb4',
      timezone: 'Z',
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
      waitForConnections: true,
      // The server must not hold a connection that the database dropped (the database closes idle ones)
      enableKeepAlive: true,
    })
    const pool = driver.createPool(settings(options.connectionLimit))
    const lockPool = driver.createPool(settings(options.lockConnections ?? 16))
    const database = new MysqlDatabase(pool, lockPool, options.database, options.lockWaitSeconds ?? 15)
    try {
      await database.query('SELECT 1')
    } catch (error) {
      await pool.end().catch(() => undefined)
      await lockPool.end().catch(() => undefined)
      throw new Error(`Cannot connect to MySQL: ${error instanceof Error ? error.message : String(error)}`)
    }
    return database
  }

  async query<T extends object = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params as unknown[])
    return rows as unknown as T[]
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ affected: number; insertId: number }> {
    const [header] = await this.pool.query(sql, params as unknown[])
    return {
      affected: (header as ResultSetHeader).affectedRows,
      insertId: Number((header as ResultSetHeader).insertId),
    }
  }

  /**
   * Runs the work in a transaction. A deadlock, which two transactions that touch the same rows can cause, is retried
   * a few times, since the database has already undone the work of the one it chose.
   */
  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const connection = await this.pool.getConnection()
      try {
        await connection.beginTransaction()
        const result = await work(wrap(connection))
        await connection.commit()
        return result
      } catch (error) {
        await connection.rollback().catch(() => undefined)
        if (attempt < 4 && isRetryable(error)) {
          continue
        }
        throw error
      } finally {
        connection.release()
      }
    }
  }

  /**
   * Runs the work while holding a lock that every instance of the server sharing this database respects. Another
   * holder of the same name makes this wait, up to `lockWaitSeconds`. The lock belongs to a connection of its own,
   * which the database frees if the process dies, so a crashed instance cannot leave a tenant locked.
   */
  async withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
    const waitSeconds = this.lockWaitSeconds
    const lockName = `fp:${createHash('sha256').update(`${this.databaseName}\u0000${name}`).digest('hex').slice(0, 48)}`
    const connection = await this.lockPool.getConnection()
    let broken = false
    try {
      const [rows] = await connection.query('SELECT GET_LOCK(?, ?) AS got', [lockName, waitSeconds])
      if (Number((rows as Array<{ got: number | null }>)[0]?.got) !== 1) {
        throw new Error(`Waited ${waitSeconds} seconds for the turn of ${name} and did not get it`)
      }
      try {
        return await work()
      } finally {
        try {
          await connection.query('SELECT RELEASE_LOCK(?)', [lockName])
        } catch {
          // If the lock cannot be released, the connection must not go back to the pool still holding it
          broken = true
        }
      }
    } finally {
      if (broken) {
        connection.destroy()
      } else {
        connection.release()
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.pool.end(), this.lockPool.end()])
  }
}

function wrap(connection: PoolConnection): Queryable {
  return {
    async query<T extends object = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      const [rows] = await connection.query(sql, params as unknown[])
      return rows as unknown as T[]
    },
    async run(sql: string, params: readonly unknown[] = []) {
      const [header] = await connection.query(sql, params as unknown[])
      return {
        affected: (header as ResultSetHeader).affectedRows,
        insertId: Number((header as ResultSetHeader).insertId),
      }
    },
  }
}
