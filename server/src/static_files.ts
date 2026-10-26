import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { dashboardIndex, dashboardScript, dashboardStyle } from './dashboard/assets'
import { configIndex, configScript, configStyle } from './dashboard/config_assets'

export interface StaticFile {
  type: string
  body: Buffer
  /** The content security policy of the file. The default is the one of the collection page. */
  csp?: string
  /** `Cache-Control`. The default is `no-store`. */
  cache?: string
  /** Lets any site load the file (a script that other origins include). */
  anyOrigin?: boolean
  /** Sent as the `ETag`, so that a browser can ask whether its copy is still good */
  etag?: string
}

/**
 * The page and scripts of the collection page (`tools/calibration`). The route table is fixed: only these names are
 * ever served, so there is no path to traverse. It makes the server a one-address setup for the test volunteers:
 * the page and the API share an origin, so no CORS and no second hostname are needed.
 */
const calibrationFiles: Array<[urlPath: string, fileName: string, type: string]> = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/calibration.js', 'calibration.js', 'text/javascript; charset=utf-8'],
  ['/config.js', 'config.js', 'text/javascript; charset=utf-8'],
  ['/fp.min.js', 'fp.min.js', 'text/javascript; charset=utf-8'],
]

/**
 * What the page is allowed to do. Scripts only from this server, connections only to this server, and the blob
 * workers that the collector uses to compare the page with a worker. Nothing external, no framing.
 */
export const calibrationCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  'worker-src blob:',
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** What the dashboard may do: only its own script and style sheet, and calls to this server. */
export const dashboardCsp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

export function dashboardFiles(): Record<string, StaticFile> {
  const page = (body: string, type: string): StaticFile => ({
    type,
    body: Buffer.from(body),
    csp: dashboardCsp,
  })
  const index = page(dashboardIndex, 'text/html; charset=utf-8')
  const configPage = page(configIndex, 'text/html; charset=utf-8')
  return {
    '/dashboard': index,
    '/dashboard/': index,
    '/dashboard/app.js': page(dashboardScript, 'text/javascript; charset=utf-8'),
    '/dashboard/style.css': page(dashboardStyle, 'text/css; charset=utf-8'),
    // The settings panel: it logs in with the key of the operator and changes the settings of the tenants
    '/dashboard/config': configPage,
    '/dashboard/config/': configPage,
    '/dashboard/config/app.js': page(configScript, 'text/javascript; charset=utf-8'),
    '/dashboard/config/style.css': page(configStyle, 'text/css; charset=utf-8'),
  }
}

/**
 * The browser script, served by this server so that the page, the script and the API share a hostname (first-party).
 * The path is the operator's choice, because a fixed well-known name is the first thing that a blocklist learns.
 */
export function collectorFiles(file: string, urlPath: string): Record<string, StaticFile> {
  if (!existsSync(file)) {
    throw new Error(
      `collectorFile: "${file}" was not found. Build the library (yarn build) and point to dist/fp.min.js.`,
    )
  }
  const body = readFileSync(file)
  return {
    [urlPath]: {
      type: 'text/javascript; charset=utf-8',
      body,
      csp: "default-src 'none'",
      cache: 'public, max-age=3600',
      anyOrigin: true,
      etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
    },
  }
}

export function loadCalibrationFiles(directory: string): Record<string, StaticFile> {
  const files: Record<string, StaticFile> = {}
  for (const [urlPath, fileName, type] of calibrationFiles) {
    const file = path.join(directory, fileName)
    if (!existsSync(file)) {
      throw new Error(
        `calibrationDir: "${fileName}" was not found in "${directory}". ` +
          'Build the library (yarn build), copy dist/fp.min.js there, and create config.js from config.example.js.',
      )
    }
    files[urlPath] = { type, body: readFileSync(file) }
  }
  return files
}
