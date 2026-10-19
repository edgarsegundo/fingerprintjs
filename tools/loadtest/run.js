#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * A load test for the collect path, with no dependency. It plays browsers that ask for a challenge and then send a
 * visit, from a population of made-up devices, and reports throughput and latency.
 *
 *   node tools/loadtest/run.js --url http://127.0.0.1:8080 --pk pk_... --sk sk_... \
 *        --seconds 20 --concurrency 16 --devices 5000
 *
 * Use a server with generous limits (`limits.*` high), a throwaway tenant and a throwaway database: it writes events.
 * The numbers describe the machine and the setup that you ran it on, and nothing else.
 */
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg, index, all) => (arg.startsWith('--') ? [arg.slice(2), all[index + 1]] : undefined))
    .filter(Boolean),
)
const url = args.url ?? 'http://127.0.0.1:8080'
const pk = args.pk
const sk = args.sk
const seconds = Number(args.seconds ?? 10)
const concurrency = Number(args.concurrency ?? 8)
const devices = Number(args.devices ?? 1000)
const readEvery = Number(args['read-every'] ?? 0) // read back one event in this many visits, to time the API too
if (!pk) {
  console.error(
    'Usage: node tools/loadtest/run.js --url <address> --pk <public key> [--sk <secret key>] ' +
      '[--seconds n] [--concurrency n] [--devices n] [--read-every n]',
  )
  process.exit(2)
}

const signal = (value) => ({ value, duration: 1 })

/** The signals of device number n. Different devices share some values (as real ones do) and differ in others. */
function payload(n, nonce) {
  return {
    schema: 1,
    libVersion: '5.3.0',
    collectedAt: Date.now(),
    durationMs: 5,
    nonce,
    linkedId: `device-${n}`,
    components: {
      canvas: signal({ winding: true, geometry: `geometry-${n}`, text: `text-${n % 200}` }),
      webGlBasics: signal({
        rendererUnmasked: `gpu-${n % 50}`,
        vendorUnmasked: `vendor-${n % 5}`,
        renderer: 'r',
        vendor: 'v',
      }),
      fonts: signal([`font-${n % 400}`, `font-${(n * 7) % 400}`]),
      screenResolution: signal([1000 + (n % 20), 800 + (n % 9)]),
      platform: signal(n % 3 === 0 ? 'Win32' : 'MacIntel'),
      timezone: signal('America/Sao_Paulo'),
      hardwareConcurrency: signal(2 + (n % 4) * 2),
    },
    extended: {},
  }
}

const latencies = { nonce: [], collect: [], read: [] }
const statuses = {}
let stop = false

async function timed(kind, work) {
  const started = process.hrtime.bigint()
  let status = 0
  try {
    const response = await work()
    status = response.status
    await response.arrayBuffer()
  } catch {
    status = -1
  }
  latencies[kind].push(Number(process.hrtime.bigint() - started) / 1e6)
  statuses[`${kind} ${status}`] = (statuses[`${kind} ${status}`] ?? 0) + 1
  return status
}

async function worker() {
  let count = 0
  while (!stop) {
    const n = Math.floor(Math.random() * devices)
    let nonce
    await timed('nonce', async () => {
      const response = await fetch(`${url}/v1/nonce?k=${pk}`)
      const copy = response.clone()
      nonce = (await copy.json()).nonce
      return response
    })
    let requestId
    await timed('collect', async () => {
      const response = await fetch(`${url}/v1/collect?k=${pk}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload(n, nonce)),
      })
      requestId = (
        await response
          .clone()
          .json()
          .catch(() => ({}))
      ).requestId
      return response
    })
    count++
    if (sk && requestId && readEvery > 0 && count % readEvery === 0) {
      await timed('read', () => fetch(`${url}/v1/events/${requestId}`, { headers: { Authorization: `Bearer ${sk}` } }))
    }
  }
}

function percentile(sorted, p) {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

async function main() {
  const started = Date.now()
  setTimeout(() => (stop = true), seconds * 1000)
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const elapsed = (Date.now() - started) / 1000
  console.log(`\n${concurrency} workers, ${devices} devices, ${elapsed.toFixed(1)} s`)
  for (const [kind, values] of Object.entries(latencies)) {
    if (values.length === 0) continue
    const sorted = [...values].sort((a, b) => a - b)
    const ms = (p) => `${percentile(sorted, p).toFixed(1)} ms`
    const perSecond = (values.length / elapsed).toFixed(0)
    console.log(
      `${kind.padEnd(8)} ${String(values.length).padStart(7)} calls  ${perSecond.padStart(6)}/s  ` +
        `p50 ${ms(50)}  p95 ${ms(95)}  p99 ${ms(99)}  max ${sorted[sorted.length - 1].toFixed(1)} ms`,
    )
  }
  console.log('statuses', JSON.stringify(statuses))
}

main()
