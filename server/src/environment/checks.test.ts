import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { StoredEvent } from '../store/types'

import { checkEnvironment, defaultPrivateQuotaBytes } from './checks'
import { environmentCheckIds } from './ids'

const signal = (value: unknown) => ({ value, duration: 1 })

function visit(options: { renderer?: string; unmasked?: string; quota?: unknown } = {}): StoredEvent {
  return {
    requestId: 'r1',
    tenantId: 't1',
    receivedAt: 1000,
    network: {
      ip: '203.0.113.9',
      ipVersion: 4,
      ipPrefix: '203.0.113.0/24',
      ipSource: 'socket',
      ipIntel: { tags: [] },
      viaProxy: false,
      httpVersion: '2.0',
      headers: { order: [], casing: '', fp: 'x', values: {} },
    },
    payload: {
      schema: 1,
      libVersion: '5.3.0',
      collectedAt: 1000,
      durationMs: 5,
      components: {
        webGlBasics: signal({
          renderer: options.renderer ?? 'WebKit WebGL',
          rendererUnmasked: options.unmasked ?? 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
          vendor: 'WebKit',
          vendorUnmasked: 'Google Inc. (Apple)',
        }),
      },
      extended: { storageQuota: signal(options.quota ?? 300_000_000_000) },
    },
    derived: { clockSkewMs: 0 },
  }
}

const ids = (event: StoredEvent, options = {}) => checkEnvironment(event, options).signals.map((s) => s.id)

describe('the environment of the visit', () => {
  it('finds nothing in the graphics cards and storage of ordinary machines', () => {
    for (const unmasked of [
      'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Adreno (TM) 650',
      'Mali-G78',
      'Apple GPU',
      'Mesa Intel(R) Xe Graphics (TGL GT2)',
    ]) {
      assert.deepEqual(ids(visit({ unmasked })), [], unmasked)
    }
    for (const quota of [300_000_000_000, 60_000_000_000, defaultPrivateQuotaBytes, 2_147_483_648]) {
      assert.deepEqual(ids(visit({ quota })), [], String(quota))
    }
  })

  it('reports the virtual graphics cards of the common virtual machines', () => {
    for (const unmasked of [
      'VMware SVGA 3D',
      'ANGLE (VMware, VMware SVGA 3D Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'VirtualBox Graphics Adapter',
      'Parallels Display Adapter (WDDM)',
      'virgl (Mesa)',
      'Red Hat QXL / virtio-gpu',
    ]) {
      assert.deepEqual(ids(visit({ unmasked })), ['virtual_machine_gpu'], unmasked)
    }
  })

  it('reports a graphics card made of software apart from a virtual one', () => {
    for (const unmasked of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'Microsoft Basic Render Driver',
    ]) {
      assert.deepEqual(ids(visit({ unmasked })), ['software_renderer'], unmasked)
    }
  })

  it('reports a small storage quota as a likely private window, and only a quota that was really read', () => {
    assert.deepEqual(ids(visit({ quota: 100_000_000 })), ['private_mode_likely'])
    assert.match(checkEnvironment(visit({ quota: 100_000_000 })).signals[0].detail, /95 MiB.*128 MiB/)
    for (const quota of [null, 0, -5, 'big', Number.NaN, {}]) {
      assert.deepEqual(ids(visit({ quota })), [], String(quota))
    }
  })

  it('takes the limit of the tenant, and a check turned off reports nothing', () => {
    const event = visit({ quota: 100_000_000, unmasked: 'VMware SVGA 3D' })
    assert.deepEqual(ids(event).sort(), ['private_mode_likely', 'virtual_machine_gpu'])
    assert.deepEqual(ids(event, { privateQuotaBytes: 50_000_000 }), ['virtual_machine_gpu'])
    assert.deepEqual(ids(event, { disabledChecks: ['virtual_machine_gpu'] }), ['private_mode_likely'])
    assert.deepEqual(ids(event, { disabledChecks: [...environmentCheckIds] }), [])
  })

  it('says nothing when the page did not read the signals, instead of guessing', () => {
    const event = visit()
    event.payload.components = {}
    event.payload.extended = {}
    assert.deepEqual(ids(event), [])
    event.payload.components = { webGlBasics: { error: { name: 'Error', message: 'x' }, duration: 1 } }
    event.payload.extended = { storageQuota: { error: { name: 'timeout', message: 'x' }, duration: 1 } }
    assert.deepEqual(ids(event), [])
  })

  it('has a check for each id it lists, and no more', () => {
    const everything = visit({ quota: 1_000_000, unmasked: 'VMware SVGA 3D' })
    const software = visit({ unmasked: 'llvmpipe' })
    const found = new Set([...ids(everything), ...ids(software)])
    assert.deepEqual([...found].sort(), [...environmentCheckIds].sort())
  })
})
