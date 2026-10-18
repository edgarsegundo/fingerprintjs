import { defined } from '../../../tests/utils'

import getWebGpu from './webgpu'

describe('Collector sources', () => {
  describe('webGpu', () => {
    it('describes the adapter, or says that there is none', async () => {
      const result = await getWebGpu()
      if (!(navigator as unknown as { gpu?: unknown }).gpu) {
        expect(result).toBeUndefined()
        return
      }

      const gpu = defined(result)
      if (gpu.adapter) {
        expect(Array.isArray(gpu.features)).toBe(true)
        expect(gpu.features).toEqual([...gpu.features].sort())
        expect(Object.keys(gpu.limits)).toEqual(Object.keys(gpu.limits).sort())
        expect(Object.keys(gpu.info).sort()).toEqual(['architecture', 'description', 'device', 'vendor'])
      } else {
        expect(result).toEqual({ adapter: false })
      }
    }, 10000)
  })
})
