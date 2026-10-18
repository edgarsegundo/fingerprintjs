import type { NetworkSignals } from '../net/signals'

/**
 * Who is asking, for the challenge: the network, the TLS stack and the user agent. They change together only when
 * the client changes.
 *
 * The ciphers part of the JA4 is used, and not the whole JA4: the extension list changes when a TLS session is
 * resumed (verified with Chrome 155), and a returning browser must not look like another client.
 */
export function requestContext(network: Pick<NetworkSignals, 'ipPrefix' | 'tls' | 'headers'>): string {
  return [network.ipPrefix, network.tls?.ja4.split('_')[1] ?? '-', network.headers.values['user-agent'] ?? '-'].join(
    '|',
  )
}
