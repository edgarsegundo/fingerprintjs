import type { Resolution, SeenDevice } from '../identity/store'

import type { PersonStore } from './store'

/** What the linker reads about devices. The identity engine has it. */
export interface DeviceReader {
  devicesSeenFrom(
    tenantId: string,
    query: { ip: string; since: number; until: number; limit: number },
  ): Promise<SeenDevice[]>
  devicesWithLinkedId(tenantId: string, linkedId: string, limit: number): Promise<string[]>
}

export interface LinkerParams {
  /** An account id shared by more devices than this ties nothing: it is not one person's account */
  maxDevices: number
  /** How far back the same address counts as "at the same time", in minutes. 0 turns the tie of the address off. */
  networkWindowMinutes: number
  /** More devices than this from the address in the window and the address ties nothing */
  networkMaxDevicesPerIp: number
}

export interface LinkerReport {
  linkedId: number
  sameMachine: number
  network: number
  possibleLink: number
}

/**
 * Notes the ties that one resolved visit shows between its device and others: the same account id, the same machine in
 * another browser, the same address a short while apart, and the closest device that was not joined. It writes ties and
 * nothing else; whether they make a person is decided when the person is read (`clusterOf`).
 *
 * A visit that was not allowed to teach the engine (`learned: false`) ties nothing: it could be a forged one.
 */
export async function linkVisit(
  deps: { devices: DeviceReader; person: PersonStore },
  tenantId: string,
  visit: { ip: string; linkedId?: string; receivedAt: number },
  resolution: Resolution,
  params: LinkerParams,
): Promise<LinkerReport> {
  const report: LinkerReport = { linkedId: 0, sameMachine: 0, network: 0, possibleLink: 0 }
  if (!resolution.learned) {
    return report
  }
  const self = resolution.visitorId
  const note = async (other: string, kind: Parameters<PersonStore['record']>[1]['kind'], strength: number) =>
    other !== self && (await deps.person.record(tenantId, { a: self, b: other, kind, strength, at: visit.receivedAt }))

  if (visit.linkedId !== undefined) {
    const others = (await deps.devices.devicesWithLinkedId(tenantId, visit.linkedId, params.maxDevices + 2)).filter(
      (id) => id !== self,
    )
    if (others.length < params.maxDevices) {
      for (const other of others) {
        report.linkedId += (await note(other, 'linked_id', 1)) ? 1 : 0
      }
    }
  }
  for (const link of resolution.sameMachine?.links ?? []) {
    report.sameMachine += (await note(link.visitorId, 'same_machine', link.logOdds)) ? 1 : 0
  }
  if (resolution.possibleLink) {
    report.possibleLink += (await note(
      resolution.possibleLink.visitorId,
      'possible_link',
      resolution.possibleLink.logOdds,
    ))
      ? 1
      : 0
  }
  if (params.networkWindowMinutes > 0 && visit.ip) {
    const seen = await deps.devices.devicesSeenFrom(tenantId, {
      ip: visit.ip,
      since: visit.receivedAt - params.networkWindowMinutes * 60_000,
      until: visit.receivedAt,
      limit: params.networkMaxDevicesPerIp + 2,
    })
    const others = seen.filter((item) => item.deviceId !== self)
    if (others.length <= params.networkMaxDevicesPerIp) {
      for (const other of others) {
        report.network += (await note(other.deviceId, 'network', 1)) ? 1 : 0
      }
    }
  }
  return report
}
