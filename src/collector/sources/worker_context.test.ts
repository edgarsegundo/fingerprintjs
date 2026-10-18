import { defined } from '../../../tests/utils'

import getWorkerContext, { getPageSnapshot, WorkerContext } from './worker_context'

async function getContext(): Promise<WorkerContext> {
  const getter = getWorkerContext()
  return defined(getter, 'worker context getter')()
}

describe('Collector sources', () => {
  describe('workerContext', () => {
    it('returns the same navigator values in the page and in the worker when nothing is tampered', async () => {
      const { page, worker } = await getContext()
      expect(page).toEqual(getPageSnapshot())
      if ('unavailable' in worker) {
        fail(`The worker is unavailable: ${worker.unavailable}`)
        return
      }

      for (const key of Object.keys(page) as Array<keyof typeof page>) {
        expect(worker[key]).withContext(key).toEqual(page[key])
      }
      expect(worker.webgl === null || typeof worker.webgl?.renderer === 'string').toBe(true)
    }, 10000)

    it('reports that the worker is unavailable instead of failing', async () => {
      spyOn(window, 'Worker').and.throwError('blocked by a policy')
      const { page, worker } = await getContext()
      expect(page.userAgent).toBe(navigator.userAgent)
      expect(worker).toEqual({ unavailable: 'Error' })
    })

    it('exposes a difference between a patched page and the worker', async () => {
      const original = defined(Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform'))
      Object.defineProperty(Navigator.prototype, 'platform', { ...original, get: () => 'SpoofedOS' })
      try {
        const { page, worker } = await getContext()
        expect(page.platform).toBe('SpoofedOS')
        expect('unavailable' in worker).toBe(false)
        expect((worker as { platform: string }).platform).not.toBe('SpoofedOS')
      } finally {
        Object.defineProperty(Navigator.prototype, 'platform', original)
      }
    }, 10000)

    it('stops the worker after it answers', async () => {
      const terminate = spyOn(Worker.prototype, 'terminate').and.callThrough()
      await getContext()
      expect(terminate).toHaveBeenCalledTimes(1)
    }, 10000)
  })
})
