import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface StaticFile {
  type: string
  body: Buffer
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
