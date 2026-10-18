import type { Resolution } from './identity/store'
import type { StoredEvent } from './store/types'

/**
 * One readable line about a stored event, for the operator at the terminal: when, which label, which address, how it
 * connected. It shows the real address on purpose: the operator is checking that the server sees visitors correctly.
 */
export function summarizeEvent(event: StoredEvent, resolution?: Resolution): string {
  const { network, payload } = event
  const parts = [
    new Date(event.receivedAt).toISOString(),
    `label=${payload.linkedId ?? '-'}`,
    `ip=${network.ip}`,
    `http=${network.httpVersion}`,
    `ja4=${network.tls?.ja4 ?? network.tlsStatus ?? '-'}`,
    `viaProxy=${network.viaProxy}`,
  ]
  if (resolution) {
    const probability = resolution.probability ?? resolution.provisionalProbability
    parts.push(
      `visitor=${resolution.visitorId}`,
      resolution.matched ? 'returning' : 'new',
      probability === null ? 'p=-' : `p=${probability.toFixed(3)}${resolution.calibrated ? '' : '(provisional)'}`,
    )
    if (resolution.ambiguous) {
      parts.push('AMBIGUOUS')
    }
  }
  // 172.16.0.0/12 is where Docker puts its bridge networks. An address there means the visitor's was hidden.
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(network.ip) || network.ip === '127.0.0.1') {
    parts.push('WARNING=looks-like-a-container-or-local-address')
  }
  return parts.join('  ')
}
