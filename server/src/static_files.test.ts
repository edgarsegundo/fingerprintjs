import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { calibrationCsp, loadCalibrationFiles } from './static_files'

function withFolder(names: string[], run: (dir: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fp-static-'))
  try {
    for (const name of names) {
      writeFileSync(path.join(dir, name), `content of ${name}`)
    }
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('loadCalibrationFiles', () => {
  it('loads the four files under fixed paths', () => {
    withFolder(['index.html', 'calibration.js', 'config.js', 'fp.min.js', 'secret.txt'], (dir) => {
      const files = loadCalibrationFiles(dir)
      assert.deepEqual(Object.keys(files).sort(), ['/', '/calibration.js', '/config.js', '/fp.min.js'])
      assert.equal(files['/'].body.toString(), 'content of index.html')
      assert.equal(files['/'].type, 'text/html; charset=utf-8')
      assert.ok(!JSON.stringify(files).includes('secret'), 'other files in the folder are never served')
    })
  })

  it('fails at start, saying what to do, when a file is missing', () => {
    withFolder(['index.html', 'calibration.js', 'fp.min.js'], (dir) => {
      assert.throws(() => loadCalibrationFiles(dir), /config\.js.*was not found.*config\.example\.js/s)
    })
  })

  it('has a policy without any external address', () => {
    assert.ok(!calibrationCsp.includes('http'))
    assert.ok(calibrationCsp.includes("frame-ancestors 'none'"))
  })
})
