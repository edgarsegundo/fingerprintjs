/*
 * A development-only receiver for the raw signals sent by `collect` / `collectAndSend`.
 * It exists to try the client end to end and to document the contract the real server (phase 2) must implement.
 * It is NOT a server: it stores nothing on disk, keeps only the last payload in memory and listens on localhost.
 *
 * Usage:  yarn build && node tools/dev-receiver.js [port]    then open http://127.0.0.1:8787/
 *
 * Contract:
 *   GET  /nonce    -> { nonce }        a single-use challenge (anti-replay, see `CollectOptions.nonce`)
 *   POST /collect  -> { requestId }    accepts a `CollectPayload`; the answer never contains an identity
 *   GET  /last     -> the last payload and how it was validated (development only)
 */
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')

const port = Number(process.argv[2]) || 8787
const maxBodyBytes = 1024 * 1024
const nonceTtlMs = 5 * 60 * 1000
const supportedSchema = 1

const issuedNonces = new Map() // nonce -> issue time
let last = null

const demoPage = `<!doctype html><meta charset="utf-8"><title>collector demo</title><body>running</body>
<script src="/fp.min.js"></script>
<script>
  (async () => {
    try {
      const { nonce } = await (await fetch('/nonce')).json()
      const result = await FingerprintJS.collectAndSend({ endpoint: '/collect' }, { nonce })
      document.body.textContent = 'done ' + JSON.stringify(result)
    } catch (error) {
      document.body.textContent = 'failed ' + error
    }
  })()
</script>`

function validate(payload) {
  const problems = []
  if (!payload || payload.schema !== supportedSchema) {
    problems.push(`unsupported schema: ${payload && payload.schema}`)
    return problems
  }
  if (typeof payload.nonce !== 'string') {
    problems.push('nonce missing')
  } else if (!issuedNonces.has(payload.nonce)) {
    problems.push('nonce unknown or already used') // a replayed payload ends up here
  } else if (Date.now() - issuedNonces.get(payload.nonce) > nonceTtlMs) {
    problems.push('nonce expired')
    issuedNonces.delete(payload.nonce)
  } else {
    issuedNonces.delete(payload.nonce) // single use
  }
  for (const group of ['components', 'extended']) {
    if (!payload[group] || typeof payload[group] !== 'object') {
      problems.push(`${group} missing`)
    }
  }
  return problems
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        reject(new Error('payload too large'))
        request.destroy()
      } else {
        chunks.push(chunk)
      }
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(demoPage)
    } else if (request.method === 'GET' && request.url === '/fp.min.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' })
      response.end(fs.readFileSync(path.join(__dirname, '..', 'dist', 'fp.min.js')))
    } else if (request.method === 'GET' && request.url === '/nonce') {
      const nonce = crypto.randomBytes(16).toString('hex')
      issuedNonces.set(nonce, Date.now())
      sendJson(response, 200, { nonce })
    } else if (request.method === 'POST' && request.url === '/collect') {
      const payload = JSON.parse(await readBody(request))
      const problems = validate(payload)
      const requestId = crypto.randomUUID()
      last = { requestId, problems, userAgentHeader: request.headers['user-agent'], payload }
      process.stdout.write(
        `[collect] ${requestId} problems=${JSON.stringify(problems)} ` +
          `components=${Object.keys(payload.components || {}).length} extended=${
            Object.keys(payload.extended || {}).length
          }\n`,
      )
      sendJson(response, problems.length ? 400 : 200, problems.length ? { problems } : { requestId })
    } else if (request.method === 'GET' && request.url === '/last') {
      sendJson(response, last ? 200 : 404, last || {})
    } else {
      sendJson(response, 404, { error: 'not found' })
    }
  } catch (error) {
    sendJson(response, 400, { error: String(error.message || error) })
  }
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`Dev receiver: http://127.0.0.1:${port}/\n`))
