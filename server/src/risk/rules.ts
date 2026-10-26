/**
 * Rules that turn what the server knows about a visit into a decision (`allow`, `review`, `challenge`, `block`, or
 * any word the tenant chooses). A rule is data, not code: it is checked when the configuration is loaded, and running
 * it can do nothing but read the facts below and compare. There is no `eval`, no regular expression and no loop, so a
 * rule from a configuration file cannot hang or leak the server.
 */
export type FactType = 'number' | 'boolean' | 'string' | 'list'

/** Every fact that a rule can read, and its type. A rule that names another fact is refused when it is loaded. */
export const factTypes = {
  'risk.score': 'number',
  'risk.level': 'string',
  'risk.factors': 'list',
  'identity.visitorId': 'string',
  'identity.matched': 'boolean',
  'identity.new': 'boolean',
  'identity.ambiguous': 'boolean',
  'identity.possibleLink': 'boolean',
  'identity.sameMachineCount': 'number',
  'person.devices': 'number',
  'person.linkedIds': 'number',
  'person.evidenceDevices': 'number',
  'person.truncated': 'boolean',
  'identity.storedIdConflict': 'boolean',
  'identity.learned': 'boolean',
  'identity.probability': 'number',
  'tamper.high': 'number',
  'tamper.medium': 'number',
  'tamper.low': 'number',
  'tamper.signals': 'list',
  'environment.signals': 'list',
  'ip.tags': 'list',
  'crawler.claimed': 'string',
  'crawler.verified': 'boolean',
  'ip.country': 'string',
  'ip.version': 'number',
  'velocity.linkedIdsPerDevice': 'number',
  'velocity.devicesPerIp': 'number',
  'velocity.ipsPerDevice': 'number',
  'behavior.observedMs': 'number',
  'behavior.interactions': 'number',
  'behavior.syntheticEvents': 'number',
  'graph.tenants': 'number',
  'graph.flaggedTenants': 'number',
  'event.linkedId': 'string',
  'event.viaProxy': 'boolean',
} as const satisfies Record<string, FactType>

export type FactName = keyof typeof factTypes

/** A fact is absent (`undefined` or `null`) when it cannot be known, for example `identity.*` with the matcher off */
export type Facts = Partial<Record<FactName, number | boolean | string | readonly string[] | null>>

export const operators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'containsAny', 'exists'] as const
export type Operator = typeof operators[number]

const operatorsByType: Record<FactType, readonly Operator[]> = {
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'],
  boolean: ['eq', 'ne', 'exists'],
  string: ['eq', 'ne', 'in', 'contains', 'exists'],
  list: ['contains', 'containsAny', 'exists'],
}

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: FactName; op: Operator; value?: unknown }

export interface Rule {
  id: string
  when: Condition
  /** What to do. A word chosen by the tenant, such as `review`. */
  decision: string
  /** Why, in words for the person who reads the event */
  reason?: string
}

export interface Decision {
  action: string
  /** The rule that decided, or `null` if none matched and the default was used */
  ruleId: string | null
  reason: string
  /** Every rule that matched, in order. The first one decides. */
  matchedRules: string[]
}

const maxRules = 100
const maxNodes = 40
const maxDepth = 6
const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const decisionPattern = /^[a-z][a-z0-9_]{0,31}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFact = (name: unknown): name is FactName =>
  typeof name === 'string' && Object.prototype.hasOwnProperty.call(factTypes, name)

const matchesType = (type: FactType, value: unknown): boolean =>
  type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type

/** What is wrong with a condition, or `undefined` */
function checkCondition(condition: unknown, depth: number, budget: { nodes: number }): string | undefined {
  if (++budget.nodes > maxNodes) {
    return `has more than ${maxNodes} conditions`
  }
  if (depth > maxDepth) {
    return `is nested deeper than ${maxDepth} levels`
  }
  if (!isRecord(condition)) {
    return 'a condition must be an object'
  }
  const keys = Object.keys(condition)
  for (const group of ['all', 'any'] as const) {
    if (group in condition) {
      const items = condition[group]
      if (keys.length !== 1 || !Array.isArray(items) || items.length === 0) {
        return `"${group}" must be the only key and hold a non-empty list`
      }
      for (const item of items) {
        const problem = checkCondition(item, depth + 1, budget)
        if (problem) {
          return problem
        }
      }
      return undefined
    }
  }
  if ('not' in condition) {
    return keys.length === 1 ? checkCondition(condition.not, depth + 1, budget) : '"not" must be the only key'
  }
  const extra = keys.filter((key) => !['field', 'op', 'value'].includes(key))
  if (extra.length > 0) {
    return `has an unknown key "${extra[0].slice(0, 40)}" (a condition uses field, op, value, all, any or not)`
  }
  if (!isFact(condition.field)) {
    return `refers to an unknown fact "${String(condition.field).slice(0, 60)}"`
  }
  const type: FactType = factTypes[condition.field]
  const op = condition.op
  if (typeof op !== 'string' || !(operators as readonly string[]).includes(op)) {
    return `has an unknown operator "${String(op).slice(0, 40)}"`
  }
  if (!operatorsByType[type].includes(op as Operator)) {
    return `cannot use "${op}" on ${condition.field}, which is ${type === 'list' ? 'a list' : `a ${type}`}`
  }
  const value = condition.value
  if (op === 'exists') {
    return typeof value === 'boolean' ? undefined : '"exists" needs true or false as its value'
  }
  if (op === 'in' || op === 'containsAny') {
    const itemType: FactType = op === 'containsAny' ? 'string' : type
    return Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 50 &&
      value.every((v) => matchesType(itemType, v))
      ? undefined
      : `"${op}" needs a list of 1 to 50 ${itemType}s as its value`
  }
  const valueType: FactType = op === 'contains' ? 'string' : type
  return matchesType(valueType, value) ? undefined : `"${op}" on ${condition.field} needs a ${valueType} as its value`
}

/** What is wrong with the list of rules, or `undefined`. A bad rule stops the server at start. */
export function validateRules(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return 'must be a list of rules'
  }
  if (value.length > maxRules) {
    return `must have at most ${maxRules} rules`
  }
  const seen = new Set<string>()
  for (const [index, rule] of value.entries()) {
    if (!isRecord(rule)) {
      return `rule ${index} must be an object`
    }
    const extra = Object.keys(rule).filter((key) => !['id', 'when', 'decision', 'reason'].includes(key))
    if (extra.length > 0) {
      return `rule ${index} has an unknown key "${extra[0].slice(0, 40)}"`
    }
    if (typeof rule.id !== 'string' || !idPattern.test(rule.id)) {
      return `rule ${index} needs an id of lower-case letters, digits, "_" or "-"`
    }
    if (seen.has(rule.id)) {
      return `rule "${rule.id}" appears twice`
    }
    seen.add(rule.id)
    if (typeof rule.decision !== 'string' || !decisionPattern.test(rule.decision)) {
      return `rule "${rule.id}" needs a decision that is a lower-case word such as review (letters, digits, "_")`
    }
    if (rule.reason !== undefined && (typeof rule.reason !== 'string' || rule.reason.length > 200)) {
      return `rule "${rule.id}": reason must be text of at most 200 characters`
    }
    const problem = checkCondition(rule.when, 0, { nodes: 0 })
    if (problem) {
      return `rule "${rule.id}": ${problem}`
    }
  }
  return undefined
}

function compare(op: Operator, type: FactType, fact: unknown, value: unknown): boolean {
  switch (op) {
    case 'eq':
      return fact === value
    case 'ne':
      return fact !== value
    case 'gt':
      return (fact as number) > (value as number)
    case 'gte':
      return (fact as number) >= (value as number)
    case 'lt':
      return (fact as number) < (value as number)
    case 'lte':
      return (fact as number) <= (value as number)
    case 'in':
      return (value as unknown[]).includes(fact)
    case 'contains':
      return type === 'list' ? (fact as string[]).includes(value as string) : (fact as string).includes(value as string)
    case 'containsAny':
      return (fact as string[]).some((item) => (value as string[]).includes(item))
    default:
      return false
  }
}

function holds(condition: Condition, facts: Facts): boolean {
  if ('all' in condition) {
    return condition.all.every((item) => holds(item, facts))
  }
  if ('any' in condition) {
    return condition.any.some((item) => holds(item, facts))
  }
  if ('not' in condition) {
    return !holds(condition.not, facts)
  }
  const fact = facts[condition.field]
  const known = fact !== undefined && fact !== null
  if (condition.op === 'exists') {
    return known === condition.value
  }
  // Nothing can be said about a fact that is not known, so every comparison with it is false
  return known && compare(condition.op, factTypes[condition.field], fact, condition.value)
}

/** The first rule that holds decides. With no rule at all there is no decision, and `null` is returned. */
export function evaluateRules(rules: readonly Rule[], facts: Facts, defaultAction: string): Decision | null {
  if (rules.length === 0) {
    return null
  }
  const matchedRules = rules.filter((rule) => holds(rule.when, facts)).map((rule) => rule.id)
  const winner = rules.find((rule) => rule.id === matchedRules[0])
  return winner
    ? { action: winner.decision, ruleId: winner.id, reason: winner.reason ?? '', matchedRules }
    : { action: defaultAction, ruleId: null, reason: 'No rule matched.', matchedRules }
}
