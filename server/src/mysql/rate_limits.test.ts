import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { dropMysqlStorages, mysqlAvailable, newMysqlStorageWithDatabase } from '../testing/mysql'

import { MysqlRateLimits } from './rate_limits'

describe('rate limits counted in MySQL', { skip: mysqlAvailable ? false : 'FP_TEST_MYSQL_URL is not set' }, () => {
  after(dropMysqlStorages)

  const minute = 60_000
  const start = 29_000_000 * minute

  async function limits() {
    const { database, another } = await newMysqlStorageWithDatabase()
    const twin = await another()
    return { here: new MysqlRateLimits(database), there: twin.sharedLimits as MysqlRateLimits }
  }

  it('allows up to the limit in a window and tells how long to wait after it', async () => {
    const { here } = await limits()
    let clock = start + 10_000
    const limiter = here.limiter('collect', 3, minute, () => clock)
    assert.deepEqual([await limiter.take('a'), await limiter.take('a'), await limiter.take('a')], [0, 0, 0])
    assert.equal(await limiter.take('a'), 50, 'the seconds left in this window')
    clock = start + 59_999
    assert.equal(await limiter.take('a'), 1)
  })

  it('starts again in the next window, and not before', async () => {
    const { here } = await limits()
    let clock = start
    const limiter = here.limiter('collect', 1, minute, () => clock)
    assert.equal(await limiter.take('a'), 0)
    assert.ok((await limiter.take('a')) > 0)
    clock = start + minute - 1
    assert.ok((await limiter.take('a')) > 0, 'still the same window')
    clock = start + minute
    assert.equal(await limiter.take('a'), 0, 'a new window')
    assert.ok((await limiter.take('a')) > 0)
  })

  it('counts by key and by name apart, and counts together what two instances see', async () => {
    const { here, there } = await limits()
    const clock = () => start
    const a = here.limiter('collect', 2, minute, clock)
    const b = there.limiter('collect', 2, minute, clock)
    assert.equal(await a.take('ip1'), 0)
    assert.equal(await b.take('ip1'), 0)
    assert.ok((await a.take('ip1')) > 0, 'the second instance used the other half')
    assert.equal(await a.take('ip2'), 0, 'another key')
    assert.equal(await here.limiter('nonce', 2, minute, clock).take('ip1'), 0, 'another limit with the same key')
  })

  it('forgets the windows that ended and keeps the current one', async () => {
    const { here } = await limits()
    let clock = start
    const limiter = here.limiter('collect', 5, minute, () => clock)
    await limiter.take('a')
    clock = start + 3 * minute
    await limiter.take('a')
    assert.equal(await here.purge(start + 2 * minute), 1)
    assert.equal(await here.purge(start + 2 * minute), 0)
  })
})
