import { createHash } from 'node:crypto'
import type { Http2ServerRequest } from 'node:http2'

export interface Http2Signals {
  /** HTTP/2 SETTINGS id to value: 1 header table, 2 push, 3 streams, 4 window, 5 frame size, 6 header list size */
  settings: Record<string, number>
  /** First letter of each pseudo-header in the order received. Chrome sends `masp`, for example. */
  pseudoHeaderOrder: string
  fp: string
}

/**
 * What an HTTP/2 client says about itself in the connection preface. Browsers and libraries differ in these values.
 *
 * Limit of the Node API: `remoteSettings` lists every setting, filled with the protocol default when the client
 * didn't send it, so "not sent" and "sent the default" look the same. The initial WINDOW_UPDATE and PRIORITY frames,
 * which the Akamai research also uses, are not exposed by Node at all.
 */
export function http2Signals(req: Http2ServerRequest): Http2Signals {
  const remote = req.stream.session?.remoteSettings ?? {}
  const settings: Record<string, number> = {}
  const entries: Array<[string, number | boolean | undefined]> = [
    ['1', remote.headerTableSize],
    ['2', remote.enablePush],
    ['3', remote.maxConcurrentStreams],
    ['4', remote.initialWindowSize],
    ['5', remote.maxFrameSize],
    ['6', remote.maxHeaderListSize],
  ]
  for (const [id, value] of entries) {
    if (value !== undefined) {
      settings[id] = typeof value === 'boolean' ? Number(value) : value
    }
  }

  let pseudoHeaderOrder = ''
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]
    if (name.startsWith(':')) {
      pseudoHeaderOrder += name[1]
    }
  }

  const canonical = Object.entries(settings)
    .map(([id, value]) => `${id}:${value}`)
    .join(';')
  const fp = createHash('sha256').update(`${canonical}|${pseudoHeaderOrder}`).digest('hex').slice(0, 16)
  return { settings, pseudoHeaderOrder, fp }
}
