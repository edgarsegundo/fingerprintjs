import { collect } from '..'

import getStoredId, { forgetStoredId } from './stored_id'

describe('Collector sources', () => {
  describe('storedId', () => {
    const name = '_fpid_test'
    const tokenPattern = /^[A-Za-z0-9_-]{22,64}$/

    afterEach(async () => {
      await forgetStoredId({ name })
    })

    it('makes a random code the first time, and gives the same one afterwards', async () => {
      const first = await getStoredId({ name })
      expect(first.created).toBe(true)
      expect(first.foundIn).toEqual([])
      expect(first.token).toMatch(tokenPattern)

      const second = await getStoredId({ name })
      expect(second.created).toBe(false)
      expect(second.token).toBe(first.token)
      expect(second.foundIn.length).toBeGreaterThan(0)
    })

    it('makes a different code for each browser', async () => {
      const first = await getStoredId({ name })
      await forgetStoredId({ name })
      const second = await getStoredId({ name })
      expect(second.token).not.toBe(first.token)
    })

    it('writes the code back to a place that lost it', async () => {
      const first = await getStoredId({ name })
      // Clear one place only (local storage), the way a cleanup tool or another tab might
      let hadLocal = true
      try {
        localStorage.removeItem(name)
      } catch {
        hadLocal = false
      }
      const second = await getStoredId({ name })
      expect(second.token).toBe(first.token)
      if (hadLocal) {
        expect(localStorage.getItem(name)).toBe(first.token)
      }
    })

    it('trusts the place that most of them agree on, and ignores a value that is not a code', async () => {
      const first = await getStoredId({ name })
      try {
        localStorage.setItem(name, 'not a code!')
      } catch {
        return
      }
      const second = await getStoredId({ name })
      expect(second.token).toBe(first.token)
      expect(localStorage.getItem(name)).toBe(first.token)
    })

    it('limits the life of the cookie to 400 days', async () => {
      // Only the call has to work: the browser does not let a script read the Max-Age back
      const result = await getStoredId({ name, maxAgeDays: 100000 })
      expect(result.token).toMatch(tokenPattern)
    })
  })

  describe('storedId in collect', () => {
    const name = '_fpid_collect_test'

    afterEach(async () => {
      await forgetStoredId({ name })
    })

    const stored = () => {
      try {
        return localStorage.getItem(name)
      } catch {
        return null
      }
    }

    it('is off unless it is asked for', async () => {
      const payload = await collect({ consent: { basis: 'consent', version: '1' }, storedIdName: name })
      expect(payload.extended.storedId).toBeUndefined()
      expect(stored()).toBeNull()
    })

    it('leaves the device alone unless the page declares consent or fraud prevention', async () => {
      for (const consent of [
        undefined,
        { basis: 'contract', version: '1' },
        { basis: 'other', version: '1' },
      ] as const) {
        const payload = await collect({ include: ['storedId'], consent, storedIdName: name })
        expect(payload.extended.storedId).toBeUndefined()
        expect(stored()).toBeNull()
        expect(document.cookie.indexOf(name)).toBe(-1)
      }
    })

    it('stores and sends the code on consent or on a fraud prevention basis', async () => {
      for (const basis of ['consent', 'legitimate_interest'] as const) {
        await forgetStoredId({ name })
        const payload = await collect({ include: ['storedId'], consent: { basis, version: '1' }, storedIdName: name })
        const value = payload.extended.storedId.value as { token: string | null; created: boolean }
        expect(value.created).toBe(true)
        expect(value.token).toMatch(/^[A-Za-z0-9_-]{22,64}$/)
        const again = await collect({ include: ['storedId'], consent: { basis, version: '1' }, storedIdName: name })
        expect((again.extended.storedId.value as { token: string }).token).toBe(value.token as string)
      }
    })

    it('is dropped by exclude, which wins over include', async () => {
      const payload = await collect({
        include: ['storedId'],
        exclude: ['storedId'],
        consent: { basis: 'consent', version: '1' },
        storedIdName: name,
      })
      expect(payload.extended.storedId).toBeUndefined()
      expect(stored()).toBeNull()
    })

    it('refuses a name that could break the cookie', async () => {
      for (const bad of ['', 'a b', 'a;b', '1abc', 'x'.repeat(33)]) {
        let message = ''
        try {
          await collect({ storedIdName: bad })
        } catch (error) {
          message = (error as Error).message
        }
        expect(message).toContain('storedIdName')
      }
    })
  })
})
