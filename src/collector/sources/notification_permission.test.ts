import { defined } from '../../../tests/utils'

import getNotificationPermission from './notification_permission'

describe('Collector sources', () => {
  describe('notificationPermission', () => {
    it('returns both readings of the permission', async () => {
      const promise = getNotificationPermission()
      if (typeof Notification !== 'function') {
        expect(promise).toBeUndefined()
        return
      }

      const result = defined(await promise)
      expect(['default', 'granted', 'denied']).toContain(result.api)
      expect(result.api).toBe(Notification.permission)
      if (result.query !== undefined) {
        expect(typeof result.query).toBe('string')
      }
    })

    it('reports a failed query instead of throwing', async () => {
      if (typeof Notification !== 'function' || !navigator.permissions) {
        return
      }
      spyOn(navigator.permissions, 'query').and.returnValue(Promise.reject(new TypeError('unsupported')))
      expect(defined(await getNotificationPermission()).query).toBe('error:TypeError')
    })
  })
})
