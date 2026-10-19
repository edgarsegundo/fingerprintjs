import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, it } from 'node:test'

import { dropMysqlStorages, mysqlAvailable, newMysqlStorage } from '../testing/mysql'

import { AuditLog, MemoryAuditLog, NewAuditEntry, SqliteAuditLog } from './log'

const implementations: Array<[string, () => AuditLog | Promise<AuditLog>]> = [
  ['MemoryAuditLog', () => new MemoryAuditLog()],
  ['SqliteAuditLog', () => new SqliteAuditLog(new DatabaseSync(':memory:'))],
  ...(mysqlAvailable
    ? [['MysqlAuditLog', async () => (await newMysqlStorage()).audit] as [string, () => Promise<AuditLog>]]
    : []),
]

const entry = (at: number, tenantId = 't1', subject = ''): NewAuditEntry => ({
  at,
  tenantId,
  action: 'event.read',
  subject,
  keyId: 'abcd1234',
  requester: 'h_x',
  status: 200,
})

for (const [name, create] of implementations) {
  describe(name, () => {
    after(dropMysqlStorages)

    it('lists the newest first, as written, for the tenant only', async () => {
      const log = await create()
      await log.record(entry(100, 't1', 'a'))
      await log.record(entry(100, 't1', 'b'))
      await log.record(entry(300, 't2', 'other'))
      await log.record(entry(200, 't1', 'c'))
      assert.deepEqual(
        (await log.list('t1', { limit: 10 })).map((item) => item.subject),
        ['c', 'b', 'a'],
      )
      assert.deepEqual(
        (await log.list('t2', { limit: 10 })).map((item) => item.subject),
        ['other'],
      )
      assert.deepEqual(await log.list('t3', { limit: 10 }), [])
      assert.deepEqual(
        (await log.list('t1', { limit: 1 })).map((item) => item.subject),
        ['c'],
      )
    })

    it('returns every field that was written', async () => {
      const log = await create()
      await log.record({ ...entry(100, 't1', 'a'), action: 'subject.delete', status: 403 })
      const [item] = await log.list('t1', { limit: 1 })
      assert.deepEqual({ ...item, seq: 0 }, { ...entry(100, 't1', 'a'), action: 'subject.delete', status: 403, seq: 0 })
      assert.ok(item.seq > 0)
    })

    it('cuts by time (start included, end excluded) and goes on from a position', async () => {
      const log = await create()
      for (const [at, subject] of [
        [100, 'a'],
        [200, 'b'],
        [300, 'c'],
        [400, 'd'],
      ] as const) {
        await log.record(entry(at, 't1', subject))
      }
      const subjects = async (query: Parameters<AuditLog['list']>[1]) =>
        (await log.list('t1', query)).map((item) => item.subject)
      assert.deepEqual(await subjects({ since: 200, until: 400, limit: 10 }), ['c', 'b'])
      const [first] = await log.list('t1', { limit: 1 })
      assert.deepEqual(await subjects({ before: first.seq, limit: 2 }), ['c', 'b'])
      assert.deepEqual(await subjects({ before: (await log.list('t1', { limit: 4 }))[3].seq, limit: 5 }), [])
    })

    it('purges the old entries of one tenant only', async () => {
      const log = await create()
      await log.record(entry(100, 't1', 'old'))
      await log.record(entry(500, 't1', 'new'))
      await log.record(entry(100, 't2', 'other'))
      assert.equal(await log.purgeTenant('t1', 500), 1, 'the entry at the limit stays')
      assert.deepEqual(
        (await log.list('t1', { limit: 10 })).map((item) => item.subject),
        ['new'],
      )
      assert.equal((await log.list('t2', { limit: 10 })).length, 1)
    })

    it('stores what looks like SQL as plain text', async () => {
      const log = await create()
      await log.record(entry(1, 't1', "x'); DROP TABLE audit_log;--"))
      assert.equal((await log.list('t1', { limit: 10 }))[0].subject, "x'); DROP TABLE audit_log;--")
    })
  })
}
