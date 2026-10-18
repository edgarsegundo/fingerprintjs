import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'

import { loadConfig, sha256Hex } from './config'
import { buildDataset, DatasetMeta, parseDataset, serializeDataset } from './eval/dataset'
import { evaluateIdentity, renderIdentityReport } from './eval/identity_eval'
import { buildReport, renderMarkdown } from './eval/report'
import { componentOverlapScorer, legacyHashScorer } from './eval/scorers'
import { generateSynthetic } from './eval/synthetic'
import { datasetId, fitModel } from './identity/fit'
import { defaultModel, parseModel } from './identity/model'
import { SqliteIdentityStore } from './identity/sqlite_store'
import { summarizeEvent } from './ops'
import { SqliteEventStore } from './store/sqlite'
import { EventCursor, StoredEvent } from './store/types'

const usage = `Usage:
  node server/dist/cli.js new-tenant <id>
      tenant entry for the config file, and its keys
  node server/dist/cli.js nonce-secret
      a random secret for "nonceSecret"
  node server/dist/cli.js export-events --tenant <id> [--config file] [--since date] [--until date]
                                         [--keep-ip] [--out file]
      events that have a linkedId, as a dataset (addresses are hashed unless --keep-ip)
  node server/dist/cli.js last-events --tenant <id> [--config file] [--count n]
      the last visits, one line each, with the address the server saw (to check the setup)
  node server/dist/cli.js fit-model <dataset> --out model.json [--seed n]
      learns the model parameters from a labelled dataset (needs hundreds of devices to be worth anything)
  node server/dist/cli.js eval-identity <dataset> [--model model.json] [--out report.md] [--seed n]
      runs the matcher over the dataset in time order and compares it with the original library's id
  node server/dist/cli.js delete-linked --tenant <id> --linked-id <id> [--config file]
      deletes every event with that linkedId (a participant who withdraws, or a data subject request)
  node server/dist/cli.js eval <dataset> [--out report.md] [--json report.json] [--seed n]
                                         [--threshold x] [--target-fmr x]
      measures the id of the original library on a dataset (run "yarn build" first)
  node server/dist/cli.js synthetic --out <file> [--devices n] [--visits n] [--days n] [--seed n]
      a MADE-UP dataset to try the tools; it says nothing about real accuracy
`

const out = (text: string) => process.stdout.write(`${text}\n`)
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`)
  return process.exit(2)
}

function parseArgs(args: readonly string[]): { positional: string[]; options: Record<string, string | true> } {
  const positional: string[] = []
  const options: Record<string, string | true> = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith('--')) {
      const next = args[index + 1]
      if (next === undefined || next.startsWith('--')) {
        options[arg.slice(2)] = true
      } else {
        options[arg.slice(2)] = next
        index++
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, options }
}

const text = (value: string | true | undefined): string | undefined => (typeof value === 'string' ? value : undefined)

function number(value: string | true | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (typeof value !== 'string' || !Number.isFinite(parsed)) {
    return fail(`--${name} must be a number`)
  }
  return parsed
}

function time(value: string | true | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = typeof value === 'string' ? (/^\d+$/.test(value) ? Number(value) : Date.parse(value)) : NaN
  return Number.isNaN(parsed) ? fail(`--${name} must be a date such as 2026-10-17 or a time in milliseconds`) : parsed
}

function exportEvents(options: Record<string, string | true>): void {
  const tenantId = text(options.tenant) ?? fail('export-events needs --tenant <id>')
  const configFile =
    text(options.config) ?? process.env.FP_CONFIG ?? fail('export-events needs --config <file> or FP_CONFIG')
  const config = loadConfig(configFile)
  if (config.databasePath === ':memory:' || !existsSync(config.databasePath)) {
    return fail(`There is no database file at "${config.databasePath}"`)
  }
  const store = new SqliteEventStore(config.databasePath)
  const target = text(options.out)
  const stream = target ? createWriteStream(target) : process.stdout
  const hashKey = randomBytes(16)
  const keepIp = options['keep-ip'] === true
  const since = time(options.since, 'since')
  const until = time(options.until, 'until')

  let written = 0
  let skipped = 0
  let after: EventCursor | undefined
  let firstPage = true
  for (;;) {
    const page = store.listEvents(tenantId, { since, until, after, limit: 500 })
    if (page.length === 0) {
      break
    }
    const { dataset, skipped: skippedInPage } = buildDataset(page, { keepIp, tenantId, hashKey })
    if (firstPage) {
      stream.write(serializeDataset({ meta: dataset.meta, events: [] }))
      firstPage = false
    }
    stream.write(serializeDataset({ meta: dataset.meta, events: dataset.events }).split('\n').slice(1).join('\n'))
    written += dataset.events.length
    skipped += skippedInPage
    const last = page[page.length - 1]
    after = { receivedAt: last.receivedAt, requestId: last.requestId }
  }
  if (firstPage) {
    const meta: DatasetMeta = { format: 1, source: 'export', createdAt: Date.now(), tenantId, ipPseudonymized: !keepIp }
    stream.write(serializeDataset({ meta, events: [] }))
  }
  store.close()
  process.stderr.write(`${written} labelled events exported, ${skipped} without linkedId left out.\n`)
  if (target) {
    ;(stream as NodeJS.WritableStream).end()
  }
}

function lastEvents(options: Record<string, string | true>): void {
  const tenantId = text(options.tenant) ?? fail('last-events needs --tenant <id>')
  const configFile =
    text(options.config) ?? process.env.FP_CONFIG ?? fail('last-events needs --config <file> or FP_CONFIG')
  const count = number(options.count, 'count', 5)
  const config = loadConfig(configFile)
  if (config.databasePath === ':memory:' || !existsSync(config.databasePath)) {
    return fail(`There is no database file at "${config.databasePath}"`)
  }
  const store = new SqliteEventStore(config.databasePath)
  const identity = new SqliteIdentityStore(store.connection)
  let last: StoredEvent[] = []
  let after: EventCursor | undefined
  for (;;) {
    const page = store.listEvents(tenantId, { after, limit: 500 })
    if (page.length === 0) {
      break
    }
    last = [...last, ...page].slice(-count)
    after = { receivedAt: page[page.length - 1].receivedAt, requestId: page[page.length - 1].requestId }
  }
  if (last.length === 0) {
    process.stderr.write('No events yet.\n')
  }
  for (const event of last) {
    out(summarizeEvent(event, identity.getResolution(tenantId, event.requestId)))
  }
  store.close()
}

function deleteLinked(options: Record<string, string | true>): void {
  const tenantId = text(options.tenant) ?? fail('delete-linked needs --tenant <id>')
  const linkedId = text(options['linked-id']) ?? fail('delete-linked needs --linked-id <id>')
  const configFile =
    text(options.config) ?? process.env.FP_CONFIG ?? fail('delete-linked needs --config <file> or FP_CONFIG')
  const config = loadConfig(configFile)
  if (config.databasePath === ':memory:' || !existsSync(config.databasePath)) {
    return fail(`There is no database file at "${config.databasePath}"`)
  }
  const store = new SqliteEventStore(config.databasePath)
  const deleted = store.deleteByLinkedId(tenantId, linkedId)
  // A device that no remaining event points to is forgotten with them
  const devices = new SqliteIdentityStore(store.connection).removeOrphans()
  store.close()
  process.stderr.write(`${deleted} events deleted, ${devices} devices forgotten.\n`)
}

function loadModel(file: string | undefined) {
  return file ? parseModel(JSON.parse(readFileSync(file, 'utf8'))) : defaultModel()
}

function fit(positional: string[], options: Record<string, string | true>): void {
  const file = positional[1] ?? fail('fit-model needs a dataset file')
  const target = text(options.out) ?? fail('fit-model needs --out <model.json>')
  const dataset = parseDataset(readFileSync(file, 'utf8'))
  const result = fitModel(dataset, { seed: number(options.seed, 'seed', 1) })
  writeFileSync(target, `${JSON.stringify(result.model, null, 2)}\n`)
  const { summary } = result
  out(`Dataset ${datasetId(dataset)}: ${summary.visits} visits of ${summary.devices} devices.`)
  out(
    `Chance of keeping a value learned for ${summary.featuresFitted} of ${summary.featuresTotal} signals ` +
      `(from ${summary.devicesForM} devices).`,
  )
  if (summary.calibration) {
    const { examples, correct, eceBefore, eceAfter } = summary.calibration
    out(
      `Probability scale fitted on ${summary.devicesForCalibration} other devices: ` +
        `${examples} decisions, ${correct} right.`,
    )
    out(`Calibration error before ${eceBefore.toFixed(3)}, after ${eceAfter.toFixed(3)} (measured on the same data).`)
  }
  out(`Model written to ${target}. calibrated = ${result.model.calibrated}`)
  for (const warning of result.warnings) {
    process.stderr.write(`WARNING: ${warning}\n`)
  }
}

function evaluateIdentityCommand(positional: string[], options: Record<string, string | true>): void {
  const file = positional[1] ?? fail('eval-identity needs a dataset file')
  const dataset = parseDataset(readFileSync(file, 'utf8'))
  const report = evaluateIdentity(dataset, {
    model: loadModel(text(options.model)),
    datasetId: datasetId(dataset),
    seed: number(options.seed, 'seed', 1),
  })
  const markdown = renderIdentityReport(report)
  const target = text(options.out)
  if (target) {
    writeFileSync(target, markdown)
    process.stderr.write(`Report written to ${target}\n`)
  } else {
    process.stdout.write(markdown)
  }
}

function evaluate(positional: string[], options: Record<string, string | true>): void {
  const file = positional[1] ?? fail('eval needs a dataset file')
  const dataset = parseDataset(readFileSync(file, 'utf8'))
  const report = buildReport(dataset, [legacyHashScorer, componentOverlapScorer], {
    seed: number(options.seed, 'seed', 1),
    threshold: number(options.threshold, 'threshold', 0.5),
    targetFmr: number(options['target-fmr'], 'target-fmr', 0.001),
  })
  const markdown = renderMarkdown(report)
  const markdownFile = text(options.out)
  if (markdownFile) {
    writeFileSync(markdownFile, markdown)
    process.stderr.write(`Report written to ${markdownFile}\n`)
  } else {
    process.stdout.write(markdown)
  }
  const jsonFile = text(options.json)
  if (jsonFile) {
    writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`)
  }
}

const { positional, options } = parseArgs(process.argv.slice(2))
const command = positional[0]

if (command === 'new-tenant' && positional[1] && /^[A-Za-z0-9_-]{1,64}$/.test(positional[1])) {
  const token = (prefix: string, bytes: number) => `${prefix}${randomBytes(bytes).toString('base64url')}`
  const publicKey = token('pk_', 18)
  const secretKey = token('sk_', 32)
  out('Put this in "tenants" of the config file (the secret key is NOT in it, only its hash):')
  out(
    JSON.stringify(
      { id: positional[1], publicKey, secretKeySha256: [sha256Hex(secretKey)], allowedOrigins: [] },
      null,
      2,
    ),
  )
  out('')
  out(`Public key (goes in the web page):  ${publicKey}`)
  out(`Secret key (shown once, keep it in the backend of the customer):  ${secretKey}`)
} else if (command === 'nonce-secret') {
  out(randomBytes(48).toString('base64url'))
} else if (command === 'export-events') {
  exportEvents(options)
} else if (command === 'last-events') {
  lastEvents(options)
} else if (command === 'fit-model') {
  fit(positional, options)
} else if (command === 'eval-identity') {
  evaluateIdentityCommand(positional, options)
} else if (command === 'delete-linked') {
  deleteLinked(options)
} else if (command === 'eval') {
  evaluate(positional, options)
} else if (command === 'synthetic') {
  const target = text(options.out) ?? fail('synthetic needs --out <file>')
  const dataset = generateSynthetic({
    seed: number(options.seed, 'seed', 1),
    devices: number(options.devices, 'devices', 120),
    visitsPerDevice: number(options.visits, 'visits', 6),
    days: number(options.days, 'days', 60),
    updatesPerDay: 0.03,
    noiseRate: 0.02,
  })
  writeFileSync(target, serializeDataset(dataset))
  process.stderr.write(`Synthetic dataset written to ${target}. It is made up and says nothing about real accuracy.\n`)
} else {
  process.stderr.write(usage)
  process.exit(2)
}
