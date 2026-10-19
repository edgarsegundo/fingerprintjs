import { createHash } from 'node:crypto'

import type { Limiter, SharedLimits } from '../ingest/ratelimit'

import type { MysqlDatabase } from './database'

/**
 * Rate limits that every instance of the server counts together. A window is a fixed stretch of time (a minute, as the
 * limits are written), and each request adds one to the count of its key in the current window, in one statement. It
 * is coarser than the token bucket of a single process: a client can use the limit at the end of one window and
 * again at the start of the next. In exchange, the limit holds however many instances there are.
 */
export class MysqlRateLimits implements SharedLimits {
  constructor(private readonly db: MysqlDatabase) {}

  limiter(name: string, limit: number, windowMs: number, now: () => number): Limiter {
    return {
      take: async (key) => {
        const at = now()
        const start = Math.floor(at / windowMs) * windowMs
        const bucket = createHash('sha256').update(`${name}\u0000${key}`).digest('hex').slice(0, 32)
        // `LAST_INSERT_ID(expr)` hands back the new count of an existing row, so one trip is enough. A new row has 1.
        const result = await this.db.run(
          `INSERT INTO rate_windows (bucket, window_start, hits) VALUES (?, ?, 1)
           ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(hits + 1)`,
          [bucket, start],
        )
        const hits = result.affected === 1 ? 1 : result.insertId
        return hits <= limit ? 0 : Math.max(1, Math.ceil((start + windowMs - at) / 1000))
      },
    }
  }

  async purge(before: number): Promise<number> {
    return (await this.db.run('DELETE FROM rate_windows WHERE window_start < ?', [before])).affected
  }
}
