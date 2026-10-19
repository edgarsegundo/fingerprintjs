import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'

/**
 * Asks the running server whether it is ready, for the health check of a container. It reads the configuration file
 * only to learn the port and whether the server uses TLS. Inside the container it talks to the server on the loopback
 * address, so the certificate (which names the public hostname) is not checked.
 */
export function readinessTarget(configText: string): { port: number; secure: boolean; host: string; path: string } {
  const raw = JSON.parse(configText) as { listen?: { port?: number; host?: string }; tls?: unknown; basePath?: string }
  const host =
    raw.listen?.host && raw.listen.host !== '0.0.0.0' && raw.listen.host !== '::' ? raw.listen.host : '127.0.0.1'
  return { port: raw.listen?.port ?? 8080, secure: raw.tls !== undefined, host, path: `${raw.basePath ?? ''}/readyz` }
}

export function check(configFile: string, timeoutMs = 3000): Promise<boolean> {
  const target = readinessTarget(readFileSync(configFile, 'utf8'))
  return new Promise((resolve) => {
    const options = {
      host: target.host,
      port: target.port,
      path: target.path,
      timeout: timeoutMs,
      rejectUnauthorized: false,
    }
    const request = (target.secure ? https : http).get(options, (response) => {
      response.resume()
      resolve(response.statusCode === 200)
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

if (require.main === module) {
  const file = process.env.FP_CONFIG ?? process.argv[2]
  if (!file) {
    process.exit(2)
  }
  check(file).then((ok) => process.exit(ok ? 0 : 1))
}
