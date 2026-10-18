# Ingestion server

Receives the raw signals that the browser collector sends (`collect` / `collectAndSend`, see
[docs/collector.md](../docs/collector.md)), adds what only a server can see about the connection, and stores the event.
It does **not** decide who the visitor is yet: that is phase 3. The browser only ever receives a `requestId`.

No runtime dependencies: everything comes with Node 22 (including `node:sqlite`, which Node marks as experimental and
prints a warning for; the store is behind an interface so it can be replaced).

## Run

```bash
yarn server:build
node server/dist/cli.js nonce-secret          # random value for "nonceSecret"
node server/dist/cli.js new-tenant my-site    # tenant entry + keys (the secret key is shown once; only its hash is stored)
node server/dist/cli.js --help                # export-events, eval, delete-linked, synthetic (see "Evaluation" below)
FP_CONFIG=./config.json node server/dist/main.js
yarn server:test                              # builds and runs the tests
```

## Configuration (JSON file)

| Field | Default | Meaning |
|---|---|---|
| `nonceSecret` | required, 32+ chars | Signs the nonces. Changing it invalidates the nonces in flight. |
| `tenants[]` | required | `id`, `publicKey` (`pk_...`, goes in the page), `secretKeySha256[]` (hashes of `sk_...`), `allowedOrigins[]` |
| `listen` | `127.0.0.1:8080` | Use host `0.0.0.0` inside a container. |
| `tls` | none | `{ keyFile, certFile }`. With it, this process terminates TLS and reads the ClientHello (JA4). |
| `trustedProxies` | `[]` | Ranges of proxies whose forwarding headers are believed. |
| `clientIpHeader` | `x-forwarded-for` | Header with the visitor address, read from the right. |
| `ja4Header` | none | Header with a JA4 computed by a proxy. Believed only from a trusted proxy. |
| `requireNonce` | `true` | Must be a real boolean; a quoted `"false"` stops the server from starting. |
| `nonceTtlSeconds` | 300 | |
| `maxBodyBytes` | 524288 | The payload is about 45 KB. |
| `retentionDays` | 30 | Events older than this are deleted, at start and every hour. |
| `rateLimit` | 30 collects/min per IP, 6000/min per tenant, 60 nonces/min per IP | In memory, per process. |
| `databasePath` | `:memory:` | SQLite file. In a container, use `/data/events.db` on a volume. |
| `identity` | `{ "enabled": true }` | `modelFile`: a model written by `fit-model`. Without one the answers are marked as not calibrated. |
| `calibrationDir` | none | Folder with the collection page (`index.html`, `calibration.js`, `config.js`, `fp.min.js`). If set, this server also serves it at `/`, so test volunteers need only one address. Only those four paths are ever served. |
| `ipLists[]` | none | `{ tag, file }`: one CIDR per line. Labels the visitor address (`datacenter`, `tor_exit`...). No data is shipped. |

## Endpoints

| Method and path | Who calls it | Answer |
|---|---|---|
| `GET /v1/nonce?k=<publicKey>` | browser | `{ nonce }` |
| `POST /v1/collect?k=<publicKey>` | browser | `{ requestId }` and nothing else |
| `GET /v1/events/<requestId>` with `Authorization: Bearer <secretKey>` | the customer's backend | the stored event (payload, network signals) |
| `GET /healthz` | monitoring | `{ ok: true }` |

Errors are JSON `{ error: "..." }`: 400 bad JSON / nonce, 401 unknown key, 403 origin, 413 body, 415 media type,
422 invalid payload (with `problems`), 429 rate limited (with `Retry-After`).

## What the server adds to the payload (`network` in the event)

| Signal | Source | Note |
|---|---|---|
| `ip`, `ipVersion`, `ipPrefix` (/24, /64), `ipIntel.tags` | the connection | `X-Forwarded-For` is read only from trusted proxies, from the right |
| `viaProxy` | the connection | `true` means the header order and HTTP/2 data below describe the proxy |
| `tls.ja4`, `ja4_r`, `version`, `sni`, `alpn`, `negotiated` | the ClientHello (`source: front`) or a trusted proxy (`source: header`) | JA4 only; see below |
| `headers.order`, `casing`, `fp`, `values` | the request | `values` is a short allow-list; cookies and credentials are never stored |
| `http2.settings`, `pseudoHeaderOrder`, `fp` | the HTTP/2 connection | see limits |

The header fingerprint is the project's own format. It is **not** JA4H, and JA4H, JA4T and the other JA4+ methods are
not implemented: they are under the FoxIO License 1.1, which does not allow selling them without an OEM agreement.
Only JA4 (TLS client, BSD 3-Clause) is used. JA3 is not used because Chrome shuffles the extension order.

## Evaluation (phase 0)

Measures the visitor id of the original library, and later the matcher, against the truth given by `linkedId`.
The method and the data protocol are in [docs/plano/protocolo-coleta-etica.md](../docs/plano/protocolo-coleta-etica.md).

```bash
yarn build                                    # the evaluation uses the built browser library
node server/dist/cli.js export-events --config config.json --tenant my-site --out dataset.jsonl
node server/dist/cli.js eval dataset.jsonl --out report.md --json report.json
node server/dist/cli.js delete-linked --config config.json --tenant my-site --linked-id p01.iphone-safari
node server/dist/cli.js synthetic --out demo.jsonl    # MADE-UP data, only to try the tools
```

The report puts its warnings first: few devices, few pairs, a short period. Its confidence intervals resample devices,
because pairs that share a device are not independent. With fewer than 10 devices the interval is 0% to 100%.

## Visitor identification (phase 3)

Every stored visit gets a `visitorId`: the server compares it with the devices it already knows and either attaches it to
one or creates a new one. The browser never sees it; the backend of the customer reads it in `GET /v1/events/:id` as
`identity`:

```json
{ "visitorId": "v_...", "matched": true, "ambiguous": false, "calibrated": false, "probability": null,
  "provisionalProbability": 0.97, "logOdds": 7.1, "candidates": 3, "devices": 410,
  "explanation": [ { "feature": "canvas", "outcome": "agree", "weight": 4.2, "probabilityWithoutIt": 0.62 } ] }
```

- **Not calibrated until fitted.** Without a model file, `calibrated` is `false` and `probability` is `null`: the number
  in `provisionalProbability` is only a guess. Fit a model on labelled data (`fit-model`) and set `identity.modelFile`.
- **Explanation.** The features that weighed most, whether they agreed, and what the probability would be without each.
- **Per tenant.** A device of one tenant is never a candidate for another, and the same device has different ids in each.
- **Turn off** with `"identity": { "enabled": false }`.
- Limits: signals of the client cannot tell apart two physical devices that look identical; ids are not corrected afterwards
  (a merged pair stays merged); every resolution runs a few SQL queries, which fits thousands of devices, not millions.

```bash
node server/dist/cli.js fit-model dataset.jsonl --out model.json        # needs hundreds of labelled devices
node server/dist/cli.js eval-identity dataset.jsonl --model model.json  # in time order, against the original library
node server/dist/cli.js last-events --config config.json --tenant my-site   # shows the visitor of each visit
```

## Evidence of tampering (phase 4)

`GET /v1/events/:id` also returns `tamper`: the evidence found in that visit, never a verdict.

```json
{ "signals": [ { "id": "platform_inconsistent", "severity": "high",
                 "detail": "user-agent header says macos, but navigator.platform says windows." } ],
  "counts": { "high": 1, "medium": 0, "low": 0 } }
```

The checks compare views of the browser that a spoofing tool must all remember to change: the HTTP header, the page, a worker,
the client hints and the GPU. A visit that is consistent in every view shows nothing, and **a well-made anti-detect browser is
built to be consistent**, so an empty list is not proof that the visit is honest. The weaker signals (medium and low) also
fire for legitimate setups such as privacy extensions: read them as hints.

The challenge (nonce) is bound to the client that asked for it (network, TLS ciphers, user agent). If another client sends the
payload, the event gets `nonce_context_mismatch`; it is evidence and not a rejection, since a phone can change network
between the two requests. The result is computed when the event is read, so a better rule also applies to old visits.

## How to deploy, and what each choice gives you

The visitor's TLS handshake is only visible to whoever terminates TLS. That decides which signals you can have.

| | A. Direct: this server terminates TLS on its own port | B. Behind an existing reverse proxy |
|---|---|---|
| JA4 | yes | no (the proxy would have to compute it) |
| Header order, HTTP/2 settings | the visitor's | the proxy's (`viaProxy: true`): do not compare |
| Visitor IP | yes | yes, with `trustedProxies` and the proxy writing the header |
| Same origin as the customer's site | no, needs `allowedOrigins` and `credentials: 'include'` | yes |
| Changes in the existing proxy | none | one `location` |

**A is the one that gives the signals that make the identification better.** Run it on a hostname of its own
(for example `fp.example.com`) and a port that is free on the host (for example 8443). The browser calls it across origins,
which is first-party in the cookie sense (same registrable domain) and needs `allowedOrigins` in the tenant.

With the nginx described in `reverse-proxy-config` (the `macbre/nginx-http3` image, TLS on 443 for the sites, a `stream`
block already used for MQTT), option A does not touch nginx or the sites at all. A service for `docker-compose.yml`
(not applied anywhere; adapt names and paths):

```yaml
  fingerprint:
    image: fingerprint-server:latest   # docker build -f server/Dockerfile -t fingerprint-server:latest .
    container_name: fingerprint
    restart: unless-stopped
    ports:
      - "8443:8443"
    volumes:
      - ./fingerprint/config:/config:ro   # config.json, key.pem, cert.pem
      - fingerprint_data:/data
    networks:
      - proxy-network
```

Things that bite in practice:

- **Key permissions.** The container runs as user `node` (uid 1000). A Let's Encrypt `privkey.pem` is readable only by root.
  Copy the certificate and key to a folder with a renewal hook and `chown 1000`. Do not run the container as root to avoid this.
- **Renewal needs no restart.** The server compares the certificate files every 10 minutes and switches to the new ones for new
  connections. If the pair does not match yet (a renewal caught half way), it keeps the working one and logs the failure at
  every check.
- **One certificate.** The server loads one certificate. For several customer hostnames, issue one certificate with all the names.
  Choosing the certificate by name (SNI) is not implemented.
- **Check the address.** After deploying, confirm that the stored `ip` is the visitor's and not the Docker gateway.
- **Firewall and DNS.** Open the port and point the hostname to the host.

Option B, for the same nginx (nginx writes the header, the server trusts the Docker network):

```nginx
location /fp/ {
    proxy_pass http://fingerprint:8080/;
    proxy_set_header X-Forwarded-For $remote_addr;   # replace, do not append: this nginx is the edge
    proxy_set_header Host $host;
}
```

with `"trustedProxies": ["<subnet of nginx-proxy-network>"]`, no `tls`, and `listen.host` `0.0.0.0`. If a CDN such as Cloudflare
is in front of nginx, `$remote_addr` is the CDN, and nginx needs its real-IP setup first.

A third option, passing the TCP connection through nginx's `stream` module with the PROXY protocol, would keep the
ClientHello and the address, but needs PROXY protocol support in the TLS front (not implemented) and moving the sites off
port 443 behind an SNI router. It is a large change to a shared production proxy, so it was not attempted.

## Limits you should know

- **Node cannot see everything.** `remoteSettings` of an HTTP/2 client lists every setting with the protocol default for the
  ones that were not sent, so "not sent" and "sent the default" look the same. The first `WINDOW_UPDATE` and the `PRIORITY`
  frames are not exposed at all. Passive TCP/IP fingerprints (p0f style) need a packet-level view and are not available.
- **Storage.** Each event keeps the whole payload (about 45 KB). A million events in the retention window is tens of GB.
  Phase 3 will move the heavy parts (canvas images) out of every row. SQLite writes block the event loop for a moment each.
- **Rate limits are per process.** With more than one process, the real limit is multiplied.
- **The nonce proves the flow, not honesty.** The client code is public, so a determined attacker can craft any payload.
  Signed results and stronger checks are phase 4.
- **Nothing here is production-hardened.** Key rotation, metrics, structured alerts and load tests are phase 8.
- **Slow clients.** The TLS front waits up to 5 seconds for a ClientHello and keeps up to 64 KB per waiting connection.
  Many such connections cost memory; a limit on concurrent connections is phase 8.
