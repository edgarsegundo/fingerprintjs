import type { DeviceAccount } from '../identity/store'

import { clusterOf, PersonParams, PersonView, viewOf } from './cluster'
import type { PersonStore } from './store'

export interface PersonDeps {
  person: PersonStore
  identity: { accountsOf(tenantId: string, deviceIds: readonly string[], limit: number): Promise<DeviceAccount[]> }
}

/** The person that a device belongs to, with the account ids of its devices. Per tenant, like everything else. */
export async function personView(
  deps: PersonDeps,
  tenantId: string,
  deviceId: string,
  params: PersonParams,
): Promise<PersonView> {
  const person = await clusterOf(
    deviceId,
    async (ids) => deps.person.linksOf(tenantId, ids, params.maxDevices * 10),
    params,
  )
  const accounts = await deps.identity.accountsOf(tenantId, person.devices, 1000)
  return viewOf(person, accounts)
}
