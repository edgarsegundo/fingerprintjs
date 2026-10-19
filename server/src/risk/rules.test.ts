import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateRules, Facts, Rule, validateRules } from './rules'

const rule = (id: string, when: unknown, decision = 'block', reason?: string) => ({
  id,
  when,
  decision,
  ...(reason ? { reason } : {}),
})

describe('rules: what is accepted', () => {
  it('accepts every operator on the type it belongs to', () => {
    const rules = [
      rule('a', { field: 'risk.score', op: 'gte', value: 60 }),
      rule('b', { field: 'risk.level', op: 'in', value: ['medium', 'high'] }),
      rule('c', { field: 'ip.tags', op: 'contains', value: 'tor_exit' }),
      rule('d', { field: 'ip.tags', op: 'containsAny', value: ['vpn', 'proxy'] }),
      rule('e', { field: 'identity.matched', op: 'eq', value: false }),
      rule('f', { field: 'ip.country', op: 'exists', value: true }),
      rule('g', { field: 'event.linkedId', op: 'contains', value: 'test-' }),
      rule('h', {
        not: {
          all: [
            { field: 'tamper.high', op: 'gt', value: 0 },
            { field: 'risk.score', op: 'lt', value: 5 },
          ],
        },
      }),
    ]
    assert.equal(validateRules(rules), undefined)
    assert.equal(validateRules([]), undefined)
  })

  it('refuses what could not run, saying where and why', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['x', /list of rules/],
      [[5], /rule 0 must be an object/],
      [[{ id: 'A b', when: {}, decision: 'block' }], /needs an id/],
      [
        [
          rule('a', { field: 'risk.score', op: 'gte', value: 1 }),
          rule('a', { field: 'risk.score', op: 'gte', value: 1 }),
        ],
        /twice/,
      ],
      [[rule('a', { field: 'risk.score', op: 'gte', value: 1 }, 'Block!')], /lower-case word/],
      [[{ ...rule('a', { field: 'risk.score', op: 'gte', value: 1 }), extra: 1 }], /unknown key "extra"/],
      [[rule('a', { field: 'risk.scor', op: 'gte', value: 1 })], /unknown fact "risk.scor"/],
      [[rule('a', { field: 'risk.score', op: 'matches', value: 1 })], /unknown operator "matches"/],
      [[rule('a', { field: 'risk.score', op: 'contains', value: 'x' })], /cannot use "contains" on risk.score/],
      [[rule('a', { field: 'ip.tags', op: 'eq', value: 'x' })], /cannot use "eq" on ip.tags/],
      [[rule('a', { field: 'risk.score', op: 'gte', value: '60' })], /needs a number/],
      [[rule('a', { field: 'risk.score', op: 'gte', value: Infinity })], /needs a number/],
      [[rule('a', { field: 'risk.score', op: 'in', value: [] })], /1 to 50/],
      [[rule('a', { field: 'ip.tags', op: 'containsAny', value: [1] })], /strings/],
      [[rule('a', { field: 'ip.country', op: 'exists', value: 'yes' })], /true or false/],
      [[rule('a', { all: [] })], /non-empty list/],
      [[rule('a', { all: [{ field: 'risk.score', op: 'gte', value: 1 }], any: [] })], /only key/],
      [[rule('a', { field: 'risk.score', op: 'gte', value: 1, also: 1 })], /unknown key "also"/],
      [[rule('a', { not: { field: 'risk.score', op: 'gte', value: 1 }, extra: 1 })], /only key/],
      [[{ id: 'a', decision: 'block' }], /must be an object/],
      [[{ ...rule('a', { field: 'risk.score', op: 'gte', value: 1 }), reason: 5 }], /reason/],
    ]
    for (const [value, expected] of cases) {
      const problem = validateRules(value)
      assert.ok(problem && expected.test(problem), `${JSON.stringify(value)} gave ${problem}`)
    }
  })

  it('refuses facts that only look like facts, such as inherited properties', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'risk']) {
      assert.match(validateRules([rule('a', { field: name, op: 'exists', value: true })]) ?? '', /unknown fact/)
    }
  })

  it('limits the size, so that a rule cannot become a burden', () => {
    let deep: unknown = { field: 'risk.score', op: 'gte', value: 1 }
    for (let i = 0; i < 8; i++) {
      deep = { not: deep }
    }
    assert.match(validateRules([rule('a', deep)]) ?? '', /deeper than 6/)
    const wide = { any: Array.from({ length: 41 }, () => ({ field: 'risk.score', op: 'gte', value: 1 })) }
    assert.match(validateRules([rule('a', wide)]) ?? '', /more than 40/)
    const many = Array.from({ length: 101 }, (_, i) => rule(`r${i}`, { field: 'risk.score', op: 'gte', value: 1 }))
    assert.match(validateRules(many) ?? '', /at most 100/)
  })
})

describe('rules: what they decide', () => {
  const rules = (list: unknown[]) => list as Rule[]

  it('takes the first rule that holds, and lists the others that held', () => {
    const decision = evaluateRules(
      rules([
        rule('tor', { field: 'ip.tags', op: 'contains', value: 'tor_exit' }, 'block', 'Tor exit node'),
        rule('high', { field: 'risk.score', op: 'gte', value: 60 }, 'review'),
        rule('never', { field: 'risk.score', op: 'gte', value: 101 }, 'block'),
      ]),
      { 'ip.tags': ['tor_exit'], 'risk.score': 80 },
      'allow',
    )
    assert.deepEqual(decision, {
      action: 'block',
      ruleId: 'tor',
      reason: 'Tor exit node',
      matchedRules: ['tor', 'high'],
    })
  })

  it('uses the default when nothing matches, and gives no decision without rules', () => {
    const list = rules([rule('high', { field: 'risk.score', op: 'gte', value: 60 }, 'review')])
    assert.deepEqual(evaluateRules(list, { 'risk.score': 10 }, 'allow'), {
      action: 'allow',
      ruleId: null,
      reason: 'No rule matched.',
      matchedRules: [],
    })
    assert.equal(evaluateRules([], { 'risk.score': 99 }, 'allow'), null)
  })

  it('compares each operator the way its name says, at the edges', () => {
    const holds = (op: string, value: unknown, fact: number) =>
      evaluateRules(rules([rule('r', { field: 'risk.score', op, value })]), { 'risk.score': fact }, 'no')?.ruleId ===
      'r'
    assert.ok(holds('gte', 60, 60) && !holds('gte', 60, 59.9))
    assert.ok(holds('gt', 60, 60.1) && !holds('gt', 60, 60))
    assert.ok(holds('lte', 60, 60) && !holds('lte', 60, 60.1))
    assert.ok(holds('lt', 60, 59.9) && !holds('lt', 60, 60))
    assert.ok(holds('eq', 60, 60) && !holds('eq', 60, 61))
    assert.ok(holds('ne', 60, 61) && !holds('ne', 60, 60))
    assert.ok(holds('in', [1, 60], 60) && !holds('in', [1, 2], 60))
  })

  it('combines with all, any and not', () => {
    const high = { field: 'risk.score', op: 'gte', value: 60 }
    const tor = { field: 'ip.tags', op: 'contains', value: 'tor_exit' }
    const run = (when: unknown, facts: Facts) => evaluateRules(rules([rule('r', when)]), facts, 'no')?.ruleId === 'r'
    assert.ok(run({ all: [high, tor] }, { 'risk.score': 70, 'ip.tags': ['tor_exit'] }))
    assert.ok(!run({ all: [high, tor] }, { 'risk.score': 70, 'ip.tags': [] }))
    assert.ok(run({ any: [high, tor] }, { 'risk.score': 10, 'ip.tags': ['tor_exit'] }))
    assert.ok(!run({ any: [high, tor] }, { 'risk.score': 10, 'ip.tags': [] }))
    assert.ok(run({ not: high }, { 'risk.score': 10 }))
    assert.ok(!run({ not: high }, { 'risk.score': 70 }))
  })

  it('treats a fact that is not known as false for every comparison, and tests it with exists', () => {
    const run = (when: unknown, facts: Facts) => evaluateRules(rules([rule('r', when)]), facts, 'no')?.ruleId === 'r'
    for (const op of ['gte', 'lt', 'eq', 'ne']) {
      assert.ok(!run({ field: 'identity.probability', op, value: 0.5 }, {}), op)
      assert.ok(!run({ field: 'identity.probability', op, value: 0.5 }, { 'identity.probability': null }), op)
    }
    assert.ok(run({ field: 'identity.probability', op: 'exists', value: false }, {}))
    assert.ok(run({ field: 'identity.probability', op: 'exists', value: true }, { 'identity.probability': 0.1 }))
    assert.ok(!run({ field: 'identity.probability', op: 'exists', value: true }, { 'identity.probability': null }))
    // zero and the empty list are known facts
    assert.ok(run({ field: 'tamper.high', op: 'eq', value: 0 }, { 'tamper.high': 0 }))
    assert.ok(run({ field: 'identity.matched', op: 'eq', value: false }, { 'identity.matched': false }))
    assert.ok(!run({ field: 'ip.tags', op: 'contains', value: 'x' }, { 'ip.tags': [] }))
  })

  it('does text and list operators', () => {
    const run = (when: unknown, facts: Facts) => evaluateRules(rules([rule('r', when)]), facts, 'no')?.ruleId === 'r'
    assert.ok(run({ field: 'event.linkedId', op: 'contains', value: 'bot' }, { 'event.linkedId': 'my-bot-1' }))
    assert.ok(!run({ field: 'event.linkedId', op: 'contains', value: 'bot' }, { 'event.linkedId': 'human' }))
    assert.ok(
      run({ field: 'ip.tags', op: 'containsAny', value: ['vpn', 'proxy'] }, { 'ip.tags': ['datacenter', 'proxy'] }),
    )
    assert.ok(!run({ field: 'ip.tags', op: 'containsAny', value: ['vpn', 'proxy'] }, { 'ip.tags': ['datacenter'] }))
    assert.ok(run({ field: 'ip.country', op: 'in', value: ['BR', 'PT'] }, { 'ip.country': 'PT' }))
  })
})
