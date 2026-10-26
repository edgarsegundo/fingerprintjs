import type { DeviceAccount } from '../identity/store'

import type { Link, LinkKind } from './store'

export interface PersonParams {
  /** The kinds of tie that make two devices one person. The others are shown as evidence and group nothing. */
  groupingKinds: readonly LinkKind[]
  /** A person with more devices than this is cut short and marked `truncated`: a shared account is not one person */
  maxDevices: number
}

export interface Person {
  /** The device asked about first, then the others in the order they were reached */
  devices: string[]
  /** The ties that make the devices one person */
  edges: Link[]
  /** Ties that touch the devices but group nothing (a shared address, a device that was not close enough to join) */
  evidence: Link[]
  /** True if there were more devices than `maxDevices`; then it says little and must not feed a rule */
  truncated: boolean
}

/** Whether a tie makes its two devices one person: not if a person rejected it, always if a person confirmed it */
export function groups(link: Link, params: PersonParams): boolean {
  if (link.status === 'rejected') {
    return false
  }
  return link.status === 'confirmed' || params.groupingKinds.includes(link.kind)
}

/**
 * The person that a device belongs to: the devices that the grouping ties reach, from the device outwards. It is
 * worked out when asked, from the ties, so nothing has to be kept right when a device is merged, erased or expires.
 * `loadLinks` gives the ties that touch some devices.
 */
export async function clusterOf(
  start: string,
  loadLinks: (deviceIds: string[]) => Promise<Link[]>,
  params: PersonParams,
): Promise<Person> {
  const devices = [start]
  const reached = new Set(devices)
  const seen = new Map<string, Link>()
  let frontier = [start]
  let truncated = false
  while (frontier.length > 0 && !truncated) {
    const next: string[] = []
    for (const link of await loadLinks(frontier)) {
      seen.set(`${link.a}\u0000${link.b}\u0000${link.kind}`, link)
      if (!groups(link, params)) {
        continue
      }
      for (const id of [link.a, link.b]) {
        if (reached.has(id)) {
          continue
        }
        if (devices.length >= params.maxDevices) {
          truncated = true
          continue
        }
        reached.add(id)
        devices.push(id)
        next.push(id)
      }
    }
    frontier = next
  }
  const edges: Link[] = []
  const evidence: Link[] = []
  for (const link of seen.values()) {
    if (link.status === 'rejected' || (!reached.has(link.a) && !reached.has(link.b))) {
      continue
    }
    if (groups(link, params) && reached.has(link.a) && reached.has(link.b)) {
      edges.push(link)
    } else if (!groups(link, params)) {
      evidence.push(link)
    }
  }
  return { devices, edges, evidence, truncated }
}

/** A person with the account ids (`linkedId`) of its devices, which is what a rule about several accounts reads */
export interface PersonView extends Person {
  linkedIds: string[]
  /** Other devices that only ties of evidence reach, without counting the ones already in the person */
  evidenceDevices: string[]
}

export function viewOf(person: Person, accounts: readonly DeviceAccount[]): PersonView {
  const inside = new Set(person.devices)
  const outside = new Set<string>()
  for (const link of person.evidence) {
    for (const id of [link.a, link.b]) {
      if (!inside.has(id)) {
        outside.add(id)
      }
    }
  }
  return {
    ...person,
    linkedIds: [...new Set(accounts.map((account) => account.linkedId))].sort(),
    evidenceDevices: [...outside].sort(),
  }
}
