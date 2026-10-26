import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { Config, loadConfig, sha256Hex } from './config'
import { buildDataset, DatasetMeta, parseDataset, serializeDataset } from './eval/dataset'
import { evaluateIdentity, renderIdentityReport } from './eval/identity_eval'
import { buildReport, renderMarkdown } from './eval/report'
import { componentOverlapScorer, legacyHashScorer } from './eval/scorers'
import { generateSynthetic } from './eval/synthetic'
import { datasetId, fitModel } from './identity/fit'
import { defaultModel, parseModel } from './identity/model'
import { migrateSqliteToMysql } from './migrate'
import { defaultListUrls, ListKind, parseList, renderList } from './net/ip_lists'
import { summarizeEvent } from './ops'
import { startReceiver } from './reachability/run'
import { ReportStore } from './reachability/store'
import { renderSummary, summarize } from './reachability/summary'
import { renderReference, renderRulesReference } from './settings/reference'
import { openStorage, Storage } from './storage'
import { EventCursor, StoredEvent } from './store/types'
import { importFileTenants } from './tenants/import'

const usage = `Usage:
  node server/dist/cli.js new-tenant <id>
      tenant entry for the config file, and its keys
  node server/dist/cli.js admin-key
      a key for the admin API (/admin/v1) and its hash for "adminKeySha256"
  node server/dist/cli.js nonce-secret
      a random secret for "nonceSecret"
  node server/dist/cli.js export-events --tenant <id> [--config file] [--since date] [--until date]
                                         [--keep-ip] [--out file]
      events that have a linkedId, as a dataset (addresses are hashed unless --keep-ip)
  node server/dist/cli.js last-events --tenant <id> [--config file] [--count n]
      the last visits, one line each, with the address the server saw (to check the setup)
  node server/dist/cli.js feature-stability --tenant <id> [--config file]
      per feature: how many devices (seen at least twice) changed its value. Shows which signals are unstable.
  node server/dist/cli.js fit-model <dataset> --out model.json [--seed n]
      learns the model parameters from a labelled dataset (needs hundreds of devices to be worth anything)
  node server/dist/cli.js eval-identity <dataset> [--model model.json] [--out report.md] [--seed n]
      runs the matcher over the dataset in time order and compares it with the original library's id
  node server/dist/cli.js config-reference [--out docs/configuracao.md]
      the reference of every setting, written from the table of parameters
  node server/dist/cli.js rules-reference [--out docs/regras.md]
      the reference of the decision rules (facts and operators), written from the code
  node server/dist/cli.js fetch-ip-list <aws|gcp|tor> --out <file> [--url address] [--file local] [--service EC2,S3]
      downloads a public list of IP ranges and writes it in the format of "ipLists" (--file reads a saved copy)
  node server/dist/cli.js migrate-sqlite --from <events.db> [--config file] [--append]
      copies a SQLite database of this server into the MySQL database of the configuration, counts the counters of the
      identity again and checks the result. The MySQL database must be empty (--append to add to one that is not)
  node server/dist/cli.js import-tenants [--config file] [--dry-run]
      copies the tenants of the config file into the database with the SAME keys, so they can be changed in the settings
      panel. Then remove "tenants" from the file. Safe to run again: a tenant already in the database is not touched
  node server/dist/cli.js delete-linked --tenant <id> --linked-id <id> [--config file]
      deletes every event with that linkedId (a participant who withdraws, or a data subject request)
  node server/dist/cli.js reachability-receiver --db <file> [--port 8090] [--host 127.0.0.1] [--path /report]
                                         [--allowed-origin https://app.example.com] [--trust-forwarded-from 172.16.0.0/12]
                                         [--asn-file networks.csv --asn-from 0 [--asn-to 1] --asn-number 2 --asn-name 3]
                                         [--keep-days 90] [--rate-per-ip 30] [--rate-total 600] [--secret-file file]
      receives the reports that the loader of a page sends when the collector could not be reached (blocked port,
      blocker). It keeps no address: see docs/plano/detectar-bloqueio-da-porta-8443-e-do-coletor-*.md
  node server/dist/cli.js reachability-summary --db <file> [--days 30] [--utc-offset -3] [--json]
      counts those reports: by reason, browser, hour of the day and network
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

/** Opens the storage of the configuration. A SQLite file that does not exist is an error, not an empty database. */
async function openExisting(config: Config): Promise<Storage> {
  if (config.database.type === 'sqlite' && (config.database.path === ':memory:' || !existsSync(config.database.path))) {
    return fail(`There is no database file at "${config.database.path}"`)
  }
  return openStorage(config)
}

async function exportEvents(options: Record<string, string | true>): Promise<void> {
  const tenantId = text(options.tenant) ?? fail('export-events needs --tenant <id>')
  const configFile =
    text(options.config) ?? process.env.FP_CONFIG ?? fail('export-events needs --config <file> or FP_CONFIG')
  const storage = await openExisting(loadConfig(configFile))
  const store = storage.events
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
    const page = await store.listEvents(tenantId, { since, until, after, limit: 500 })
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
  await storage.close()
  process.stderr.write(`${written} labelled events exported, ${skipped} without linkedId left out.\n`)
  if (target) {
    ;(stream as NodeJS.WritableStream).end()
  }
}

async function lastEvents(options: Record<string, string | true>): Promise<void> {
  const tenantId = text(options.tenant) ?? fail('last-events needs --tenant <id>')
  const configFile =
    text(options.config) ?? process.env.FP_CONFIG ?? fail('last-events needs --config <file> or FP_CONFIG')
  const count = number(options.count, 'count', 5)
  const storage = await openExisting(loadConfig(configFile))
  const store = storage.events
  const identity = storage.identity
  let last: StoredEvent[] = []
  let after: EventCursor | undefined
  for (;;) {
    const page = await store.listEvents(tenantId, { after, limit: 500 })
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
    out(summarizeEvent(event, (await identity.getResolution(tenantId, event.requestId)) ?? undefined))
  }
  await storage.close()
}

async function featureStability(options: Record<string, string | true>): Promise<void> {
  const tenantId = text(options.tenant) ?? fail('feature-stability needs --tenant <id>')
  const configFile =
    text(options.config) ?? process.env.FP_CONFIG ?? fail('feature-stability needs --config <file> or FP_CONFIG')
  const storage = await openExisting(loadConfig(configFile))
  const rows = await storage.identity.featureStability(tenantId)
  await storage.close()
  if (rows.length === 0) {
    process.stderr.write('Nenhum aparelho com duas visitas ou mais ainda.\n')
    return
  }
  out('Estabilidade das características, por aparelho com duas visitas ou mais que leram a característica.')
  out('"Mudou" é o aparelho que teve mais de um valor. Quanto menor, mais estável. Poucos aparelhos dão pouca certeza.')
  out('')
  out(`${'característica'.padEnd(24)}${'aparelhos'.padStart(10)}${'mudou'.padStart(8)}${'taxa'.padStart(8)}`)
  for (const row of [...rows].sort((a, b) => b.changed / b.devices - a.changed / a.devices)) {
    const rate = `${((100 * row.changed) / row.devices).toFixed(0)}%`
    out(
      `${row.feature.padEnd(24)}${String(row.devices).padStart(10)}${String(row.changed).padStart(8)}${rate.padStart(
        8,
      )}`,
    )
  }
}

async function deleteLinked(options: Record<string, string | true>): Promise<void> {
  const tenantId = text(options.tenant) ?? fail('delete-linked needs --tenant <id>')
  const linkedId = text(options['linked-id']) ?? fail('delete-linked needs --linked-id <id>')
  const configFile =
    text(options.config) ?? process.env.FP_CONFIG ?? fail('delete-linked needs --config <file> or FP_CONFIG')
  const storage = await openExisting(loadConfig(configFile))
  const deleted = await storage.events.deleteByLinkedId(tenantId, linkedId)
  // A device that no remaining event points to is forgotten with them
  const devices = await storage.identity.removeOrphans()
  await storage.close()
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

const maxListBytes = 100 * 1024 * 1024

async function fetchIpList(positional: string[], options: Record<string, string | true>): Promise<void> {
  const kind = positional[1]
  if (kind !== 'aws' && kind !== 'gcp' && kind !== 'tor') {
    return fail('fetch-ip-list needs a list: aws, gcp or tor')
  }
  const target = text(options.out) ?? fail('fetch-ip-list needs --out <file>')
  const file = text(options.file)
  const source = file ?? text(options.url) ?? defaultListUrls[kind as ListKind]
  let body: string
  if (file) {
    body = readFileSync(file, 'utf8')
  } else {
    if (!source.startsWith('https://')) {
      return fail('The address of a list must start with https://')
    }
    const response = await fetch(source, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) {
      return fail(`The server answered ${response.status} for ${source}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxListBytes) {
      return fail('The list is larger than 100 MB. Is the address right?')
    }
    body = bytes.toString('utf8')
  }
  const services = (text(options.service) ?? '').split(',').filter((name) => name !== '')
  const parsed = parseList(kind, body, services)
  if (parsed.ranges.length === 0) {
    return fail('The list has no ranges. Nothing was written, so the old file stays as it was.')
  }
  writeFileSync(target, renderList(kind, parsed, source, new Date()))
  process.stderr.write(`${parsed.ranges.length} ranges written to ${target} (${parsed.skipped} entries skipped)\n`)
}

async function migrateSqlite(options: Record<string, string | true>): Promise<void> {
  const from = text(options.from) ?? fail('migrate-sqlite needs --from <events.db>')
  if (!existsSync(from)) {
    return fail(`There is no database file at "${from}"`)
  }
  const configFile =
    text(options.config) ?? process.env.FP_CONFIG ?? fail('migrate-sqlite needs --config <file> or FP_CONFIG')
  const config = loadConfig(configFile)
  if (config.database.type !== 'mysql') {
    return fail('The configuration must say database.type mysql: that is where the data goes')
  }
  const storage = await openStorage(config)
  const sqlite = new DatabaseSync(from, { readOnly: true })
  try {
    const database = storage.mysql
    if (!database) {
      return fail('The storage of the configuration is not MySQL')
    }
    const report = await migrateSqliteToMysql({
      sqlite,
      mysql: database,
      append: options.append === true,
      log: (line) => process.stderr.write(`${line}\n`),
    })
    if (report.problems.length > 0) {
      return fail(`The check found differences:\n${report.problems.map((line) => `  ${line}`).join('\n')}`)
    }
    process.stderr.write('Done. What is in MySQL is what was in SQLite, and the counters were counted again.\n')
  } finally {
    sqlite.close()
    await storage.close()
  }
}

async function importTenants(options: Record<string, string | true>): Promise<void> {
  const configFile =
    text(options.config) ?? process.env.FP_CONFIG ?? fail('import-tenants needs --config <file> or FP_CONFIG')
  const config = loadConfig(configFile)
  if (config.tenants.length === 0) {
    return fail('The configuration file has no tenants to copy.')
  }
  const storage = await openExisting(config)
  try {
    const dryRun = options['dry-run'] === true
    const report = await importFileTenants(config.tenants, storage.tenants, Date.now(), { dryRun })
    for (const id of report.imported) {
      process.stderr.write(`${dryRun ? 'would copy' : 'copied'}: ${id}\n`)
    }
    for (const item of report.skipped) {
      process.stderr.write(`left alone: ${item.id} (${item.reason})\n`)
    }
    process.stderr.write(
      dryRun
        ? 'Dry run: nothing was written.\n'
        : 'Done. Now remove "tenants" from the configuration file and restart the server: while a tenant is in the\n' +
            'file, the file wins and the tenant cannot be changed through the API.\n',
    )
  } finally {
    await storage.close()
  }
}

const list = (value: string | true | undefined): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    : []

const optionalColumn = (value: string | true | undefined, name: string): number | undefined =>
  value === undefined ? undefined : number(value, name, 0)

async function reachabilityReceiver(options: Record<string, string | true>): Promise<void> {
  const asnFile = text(options['asn-file'])
  const receiver = await startReceiver({
    db: text(options.db) ?? fail('reachability-receiver needs --db <file>'),
    port: number(options.port, 'port', 8090),
    host: text(options.host) ?? '127.0.0.1',
    path: text(options.path),
    allowedOrigins: list(options['allowed-origin']),
    trustForwardedFrom: list(options['trust-forwarded-from']),
    asnFile,
    asnColumns:
      asnFile === undefined
        ? undefined
        : {
            from: number(options['asn-from'], 'asn-from', 0),
            to: optionalColumn(options['asn-to'], 'asn-to'),
            asn: optionalColumn(options['asn-number'], 'asn-number'),
            name: optionalColumn(options['asn-name'], 'asn-name'),
          },
    keepDays: number(options['keep-days'], 'keep-days', 90),
    ratePerIp: options['rate-per-ip'] === undefined ? undefined : number(options['rate-per-ip'], 'rate-per-ip', 30),
    rateTotal: options['rate-total'] === undefined ? undefined : number(options['rate-total'], 'rate-total', 600),
    secretFile: text(options['secret-file']),
  })
  process.stderr.write(`Receiver listening on ${text(options.host) ?? '127.0.0.1'}:${receiver.port}\n`)
  const stop = () => {
    receiver.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

function reachabilitySummary(options: Record<string, string | true>): void {
  const file = text(options.db) ?? fail('reachability-summary needs --db <file>')
  if (!existsSync(file)) {
    fail(`There is no database file at "${file}"`)
  }
  const store = new ReportStore(file)
  const summary = summarize(store, {
    days: number(options.days, 'days', 30),
    now: Date.now(),
    utcOffsetHours: number(options['utc-offset'], 'utc-offset', -3),
  })
  store.close()
  out(options.json === true ? JSON.stringify(summary, null, 2) : renderSummary(summary).trimEnd())
}

/** Runs a command that waits for the database; a failure ends the program with the reason */
function run(work: Promise<void>): void {
  work.catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
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
} else if (command === 'admin-key') {
  const adminKey = `adm_${randomBytes(32).toString('base64url')}`
  out('Put this in the config file (the key itself is NOT in it, only its hash):')
  out(JSON.stringify({ adminKeySha256: [sha256Hex(adminKey)] }, null, 2))
  out('')
  out(`Admin key (shown once, keep it where only the operator of the platform can read it):  ${adminKey}`)
} else if (command === 'nonce-secret') {
  out(randomBytes(48).toString('base64url'))
} else if (command === 'export-events') {
  run(exportEvents(options))
} else if (command === 'last-events') {
  run(lastEvents(options))
} else if (command === 'feature-stability') {
  run(featureStability(options))
} else if (command === 'reachability-receiver') {
  run(reachabilityReceiver(options))
} else if (command === 'reachability-summary') {
  reachabilitySummary(options)
} else if (command === 'config-reference') {
  const target = text(options.out)
  if (target) {
    writeFileSync(target, renderReference())
    process.stderr.write(`Reference written to ${target}\n`)
  } else {
    process.stdout.write(renderReference())
  }
} else if (command === 'rules-reference') {
  const target = text(options.out)
  if (target) {
    writeFileSync(target, renderRulesReference())
    process.stderr.write(`Reference written to ${target}\n`)
  } else {
    process.stdout.write(renderRulesReference())
  }
} else if (command === 'fetch-ip-list') {
  fetchIpList(positional, options).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
} else if (command === 'fit-model') {
  fit(positional, options)
} else if (command === 'eval-identity') {
  evaluateIdentityCommand(positional, options)
} else if (command === 'migrate-sqlite') {
  run(migrateSqlite(options))
} else if (command === 'import-tenants') {
  run(importTenants(options))
} else if (command === 'delete-linked') {
  run(deleteLinked(options))
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
