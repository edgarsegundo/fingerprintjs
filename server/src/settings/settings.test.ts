import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

import { Config, parseConfig, sha256Hex } from '../config'
import { featureNames } from '../identity/features'
import { factTypes, operators } from '../risk/rules'
import { tamperCheckIds } from '../tamper/ids'

import { checkValue, editDistance, suggestion } from './kinds'
import { parameters } from './parameters'
import { renderReference, renderRulesReference } from './reference'
import { defaultSettings, resolveSettings, SettingsRegistry, validateLayer } from './settings'

const baseRaw = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  nonceSecret: 'n'.repeat(32),
  tenants: [
    { id: 't1', publicKey: 'pk_0123456789abcdef0123', secretKeySha256: [sha256Hex('a')] },
    { id: 't2', publicKey: 'pk_fedcba9876543210fedc', secretKeySha256: [sha256Hex('b')] },
  ],
  ...extra,
})

function withTenantSettings(
  first: Record<string, unknown>,
  second?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Config {
  const raw = baseRaw(extra)
  const tenants = raw.tenants as Array<Record<string, unknown>>
  tenants[0].settings = first
  if (second) {
    tenants[1].settings = second
  }
  return parseConfig(raw)
}

describe('the table of parameters', () => {
  it('has a description, a default that passes its own check, and a unique path for every parameter', () => {
    const seen = new Set<string>()
    for (const parameter of parameters) {
      assert.ok(!seen.has(parameter.path), `duplicated ${parameter.path}`)
      seen.add(parameter.path)
      assert.ok(parameter.description.length > 20, `${parameter.path} needs a description`)
      if (parameter.default === null) {
        assert.ok(parameter.nullable, `${parameter.path} defaults to null but does not allow it`)
      } else {
        assert.equal(checkValue(parameter.kind, parameter.default), undefined, `the default of ${parameter.path}`)
      }
    }
  })

  it('makes default settings in which every parameter exists, and nothing else does', () => {
    const settings = defaultSettings() as unknown as Record<string, unknown>
    const leaves: string[] = []
    const walk = (node: unknown, prefix: string) => {
      const isParameter = parameters.some((parameter) => parameter.path === prefix)
      if (isParameter || typeof node !== 'object' || node === null || Array.isArray(node)) {
        leaves.push(prefix)
        return
      }
      for (const [key, value] of Object.entries(node)) {
        walk(value, prefix === '' ? key : `${prefix}.${key}`)
      }
    }
    walk(settings, '')
    assert.deepEqual(leaves.sort(), parameters.map((parameter) => parameter.path).sort())
  })

  it('gives a fresh copy of the defaults each time, so that one tenant cannot change another', () => {
    const a = defaultSettings()
    a.identity.disabledFeatures.push('canvas')
    a.identity.featureM.canvas = 0.5
    assert.deepEqual(defaultSettings().identity.disabledFeatures, [])
    assert.deepEqual(defaultSettings().identity.featureM, {})
  })

  it('lists the features and the checks that exist', () => {
    const disabled = parameters.find((parameter) => parameter.path === 'identity.disabledFeatures')
    assert.equal(checkValue(disabled?.kind as never, [featureNames[0]]), undefined)
    assert.ok(checkValue(disabled?.kind as never, ['no_such_feature']))
    const checks = parameters.find((parameter) => parameter.path === 'tamper.disabledChecks')
    assert.equal(checkValue(checks?.kind as never, [tamperCheckIds[0]]), undefined)
    assert.ok(checkValue(checks?.kind as never, ['no_such_check']))
  })
})

describe('validateLayer', () => {
  it('accepts a good layer and flattens it', () => {
    const { flat, problems } = validateLayer(
      { identity: { matchProbability: 0.9, defaultM: { stable: 0.99 } }, retention: { eventsDays: 10 } },
      'x',
    )
    assert.deepEqual(problems, [])
    assert.deepEqual(flat, [
      ['identity.matchProbability', 0.9],
      ['identity.defaultM.stable', 0.99],
      ['retention.eventsDays', 10],
    ])
  })

  it('refuses an unknown setting and suggests the closest one', () => {
    const { problems } = validateLayer({ identity: { matchProbabilty: 0.9 } }, 'defaults')
    assert.equal(problems.length, 1)
    assert.match(problems[0], /unknown setting "identity\.matchProbabilty"/)
    assert.match(problems[0], /did you mean "identity\.matchProbability"/)
  })

  it('does not suggest anything for a name that is far from every known one', () => {
    const { problems } = validateLayer({ completelyDifferent: 1 }, 'defaults')
    assert.ok(!problems[0].includes('did you mean'))
  })

  it('reports every problem at once, with where it is', () => {
    const { problems } = validateLayer(
      {
        nonce: { ttlSeconds: 5, required: 'no' },
        retention: { eventsDays: 1.5 },
        identity: { matchProbability: 1 },
        nope: 1,
      },
      'tenant loja',
    )
    assert.equal(problems.length, 5)
    for (const problem of problems) {
      assert.ok(problem.startsWith('tenant loja: '), problem)
    }
  })

  it('treats null as a value only where the parameter allows it', () => {
    assert.deepEqual(validateLayer({ identity: { matchProbability: null } }, 'x').problems, [])
    assert.equal(validateLayer({ retention: { eventsDays: null } }, 'x').problems.length, 1)
    assert.equal(validateLayer({ nonce: { required: null } }, 'x').problems.length, 1)
  })

  it('checks the names inside a map, with a suggestion', () => {
    const { problems } = validateLayer({ identity: { featureM: { canvass: 0.9 } } }, 'x')
    assert.match(problems[0], /unknown key "canvass".*did you mean "canvas"/)
    assert.deepEqual(validateLayer({ identity: { featureM: { canvas: 0.9 } } }, 'x').problems, [])
    assert.equal(validateLayer({ identity: { featureM: { canvas: 1.2 } } }, 'x').problems.length, 1)
  })

  it('refuses a section given as a value, and a value given as a section', () => {
    assert.equal(validateLayer({ identity: 5 }, 'x').problems.length, 1)
    assert.equal(validateLayer({ retention: { eventsDays: { a: 1 } } }, 'x').problems.length, 1)
    assert.equal(validateLayer([], 'x').problems.length, 1)
    assert.deepEqual(validateLayer(undefined, 'x'), { flat: [], problems: [] })
  })

  it('refuses the values that would turn a protection off without saying so', () => {
    for (const bad of ['false', 0, null, 'no']) {
      assert.equal(validateLayer({ nonce: { required: bad } }, 'x').problems.length, 1, JSON.stringify(bad))
    }
  })
})

describe('layers', () => {
  it('takes the code defaults, then the legacy fields, then the defaults of the file, then the tenant', () => {
    const { settings } = resolveSettings([
      { layer: { retention: { eventsDays: 20 }, limits: { collectPerMinutePerIp: 11 } }, where: 'legacy' },
      { layer: { retention: { eventsDays: 40 } }, where: 'defaults' },
      { layer: { retention: { eventsDays: 90 } }, where: 'tenant' },
    ])
    assert.equal(settings.retention.eventsDays, 90)
    assert.equal(settings.limits.collectPerMinutePerIp, 11, 'a lower layer stays where a higher one is silent')
    assert.equal(settings.limits.collectPerMinutePerTenant, 6000, 'and so does the default of the code')
  })

  it('rejects a combination that makes no sense', () => {
    const { problems } = resolveSettings([
      { layer: { identity: { matchProbability: 0.8, possibleLinkProbability: 0.9 } }, where: 'tenant x' },
    ])
    assert.match(problems[0], /possibleLinkProbability.*must be lower than.*matchProbability/)
    assert.deepEqual(
      resolveSettings([{ layer: { identity: { matchProbability: 0.9, possibleLinkProbability: 0.5 } }, where: 'x' }])
        .problems,
      [],
    )
  })
})

describe('the configuration file', () => {
  it('uses the old top-level fields as a layer below the new ones', () => {
    const config = parseConfig(
      baseRaw({
        nonceTtlSeconds: 100,
        retentionDays: 7,
        rateLimit: { collectPerMinutePerIp: 5 },
        defaults: { retention: { eventsDays: 50 } },
      }),
    )
    const registry = new SettingsRegistry(config)
    assert.equal(registry.for('t1').nonce.ttlSeconds, 100)
    assert.equal(registry.for('t1').limits.collectPerMinutePerIp, 5)
    assert.equal(registry.for('t1').retention.eventsDays, 50, 'defaults beat the old field')
  })

  it('gives each tenant its own settings, over the defaults', () => {
    const config = withTenantSettings({ retention: { eventsDays: 5 }, identity: { enabled: false } }, undefined, {
      defaults: { retention: { eventsDays: 60 } },
    })
    const registry = new SettingsRegistry(config)
    assert.equal(registry.for('t1').retention.eventsDays, 5)
    assert.equal(registry.for('t1').identity.enabled, false)
    assert.equal(registry.for('t2').retention.eventsDays, 60)
    assert.equal(registry.for('t2').identity.enabled, true)
    assert.equal(registry.global().retention.eventsDays, 60)
  })

  it('refuses to start with a bad setting, saying which tenant has it', () => {
    assert.throws(() => withTenantSettings({ retention: { eventsDays: 0 } }), /tenant t1: retention\.eventsDays/)
    assert.throws(
      () => withTenantSettings({}, { identity: { matchProbabilty: 0.9 } }),
      /tenant t2: unknown setting.*did you mean/,
    )
    assert.throws(
      () => parseConfig(baseRaw({ defaults: { nonce: { required: 'false' } } })),
      /defaults: nonce\.required/,
    )
    assert.throws(() => parseConfig(baseRaw({ defaults: 5 })), /defaults must be an object/)
    assert.throws(() => parseConfig(baseRaw({ defaults: [] })), /defaults must be an object/)
    assert.throws(
      () =>
        withTenantSettings({}, undefined, {}) &&
        parseConfig({
          ...baseRaw(),
          tenants: [
            { id: 'a', publicKey: 'pk_0123456789abcdef0123', secretKeySha256: [sha256Hex('a')], settings: 'x' },
          ],
        }),
      /tenants\[0\]\.settings must be an object/,
    )
  })

  it('refuses a tenant combination that only breaks for that tenant', () => {
    assert.throws(
      () =>
        withTenantSettings({ identity: { matchProbability: 0.6 } }, undefined, {
          defaults: { identity: { possibleLinkProbability: 0.7 } },
        }),
      /tenant t1:.*possibleLinkProbability/,
    )
  })
})

describe('SettingsRegistry', () => {
  it('reads the new settings after a reload, and keeps the old ones if the new file is wrong', async () => {
    const registry = new SettingsRegistry(withTenantSettings({ retention: { eventsDays: 5 } }))
    assert.equal(registry.for('t1').retention.eventsDays, 5)
    await registry.reload(withTenantSettings({ retention: { eventsDays: 8 } }))
    assert.equal(registry.for('t1').retention.eventsDays, 8)

    const broken = withTenantSettings({ retention: { eventsDays: 8 } })
    ;(broken.tenants[0].settings as Record<string, unknown>).retention = { eventsDays: -1 }
    await assert.rejects(registry.reload(broken), /retention\.eventsDays/)
    assert.equal(registry.for('t1').retention.eventsDays, 8, 'the working settings stay')
  })

  it('knows the tenants of the new file', async () => {
    const registry = new SettingsRegistry(parseConfig(baseRaw()))
    const raw = baseRaw()
    ;(raw.tenants as Array<Record<string, unknown>>).push({
      id: 't3',
      publicKey: 'pk_00000000000000000003',
      secretKeySha256: [sha256Hex('c')],
      settings: { retention: { eventsDays: 3 } },
    })
    await registry.reload(parseConfig(raw))
    assert.equal(registry.for('t3').retention.eventsDays, 3)
    assert.equal(registry.config.tenants.length, 3)
  })

  it('returns the same object until a reload, and a new one after it', async () => {
    const registry = new SettingsRegistry(parseConfig(baseRaw()))
    assert.equal(registry.for('t1'), registry.for('t1'))
    const before = registry.for('t1')
    await registry.reload(parseConfig(baseRaw()))
    assert.notEqual(registry.for('t1'), before)
  })
})

describe('kinds', () => {
  it('measures edit distance and suggests only close names', () => {
    assert.equal(editDistance('kitten', 'sitting'), 3)
    assert.equal(editDistance('', 'abc'), 3)
    assert.equal(
      suggestion('retenton.eventsDays', ['retention.eventsDays', 'nonce.required']),
      ' (did you mean "retention.eventsDays"?)',
    )
    assert.equal(suggestion('zzzzzz', ['retention.eventsDays']), '')
  })
})

describe('the reference document', () => {
  it('mentions every parameter', () => {
    const text = renderReference()
    for (const parameter of parameters) {
      assert.ok(text.includes(`\`${parameter.path}\``), parameter.path)
    }
  })

  it('is the same as the file in docs/, which is written by the command', () => {
    const file = path.resolve(__dirname, '../../../docs/configuracao.md')
    assert.equal(
      readFileSync(file, 'utf8'),
      renderReference(),
      'docs/configuracao.md is out of date. Run: node server/dist/cli.js config-reference --out docs/configuracao.md',
    )
  })

  it('has a reference of the rules that mentions every fact and operator, and is the file in docs/', () => {
    const text = renderRulesReference()
    for (const fact of Object.keys(factTypes)) {
      assert.ok(text.includes(`\`${fact}\``), fact)
    }
    for (const op of operators) {
      assert.ok(text.includes(`| \`${op}\` |`), op)
    }
    assert.equal(
      readFileSync(path.resolve(__dirname, '../../../docs/regras.md'), 'utf8'),
      text,
      'docs/regras.md is out of date. Run: node server/dist/cli.js rules-reference --out docs/regras.md',
    )
  })
})
