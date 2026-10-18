import { withTimeout } from '../utils'

const queryTimeoutMs = 1000

export type NotificationPermissionState = {
  /** `Notification.permission` */
  api: string
  /** `navigator.permissions.query({ name: 'notifications' })`. `undefined` means the Permissions API is missing. */
  query?: string
}

/**
 * The two ways of reading the notification permission must agree.
 * They disagree in some automated browsers (e.g. headless Chrome reports `denied` and `prompt`).
 * Only this permission is queried; the state of the camera, location, etc. describes user choices and isn't needed.
 */
export default function getNotificationPermission(): Promise<NotificationPermissionState> | undefined {
  if (typeof Notification !== 'function') {
    return undefined
  }

  const api = Notification.permission
  if (typeof navigator.permissions?.query !== 'function') {
    return Promise.resolve({ api })
  }

  return withTimeout(navigator.permissions.query({ name: 'notifications' }), queryTimeoutMs).then(
    (status) => ({ api, query: status.state }),
    (error) => ({ api, query: `error:${error instanceof Error ? error.name : 'Error'}` }),
  )
}
