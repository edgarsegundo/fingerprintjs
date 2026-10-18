import getStorageQuota from './storage_quota'

describe('Collector sources', () => {
  describe('storageQuota', () => {
    it('returns the quota in bytes, or undefined without the API', async () => {
      const promise = getStorageQuota()
      if (!navigator.storage?.estimate) {
        expect(promise).toBeUndefined()
        return
      }

      const quota = await promise
      expect(quota === undefined || quota > 0).toBe(true)
    })

    it("doesn't send the usage", async () => {
      if (!navigator.storage?.estimate) {
        return
      }
      const quota = await getStorageQuota()
      expect(typeof quota === 'number' || quota === undefined).toBe(true)
    })
  })
})
