# Ingestion server

Receives the raw signals that the browser collector sends (`collect` / `collectAndSend`, see
[docs/collector.md](../docs/collector.md)), adds what only a server can see about the connection, and stores the event.
It does **not** decide who the visitor is yet: that is phase 3. The browser only ever receives a `requestId`.

Two databases. **MySQL** (8.0.19 or newer) is the production one and needs the `mysql2` package, which the server loads
only when the configuration asks for MySQL (`npm install mysql2@3.24.5` next to the build; the Docker image has it).
**SQLite** needs nothing but Node 22 (`node:sqlite`, which Node marks as experimental and prints a warning for) and is
meant for development and tests. The stores are behind interfaces, and the same contract tests run over memory, SQLite and
MySQL.

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
| `databasePath` | `:memory:` | SQLite file. In a container, use `/data/events.db` on a volume. Ignored when `database` is set. |
| `database` | none | `{ "type": "sqlite", "path" }` or `{ "type": "mysql", "host", "port"?, "user", "database", "password"?, "passwordEnv"?, "connectionLimit"?, "ssl"?, "connectTimeoutMs"? }`. The MySQL password comes from the environment variable `FP_MYSQL_PASSWORD` (or the name in `passwordEnv`), so that it is not in the file. The tables are created at start. |
| `identity` | `{ "enabled": true }` | `modelFile`: a model written by `fit-model`. Without one the answers are marked as not calibrated. |
| `calibrationDir` | none | Folder with the collection page (`index.html`, `calibration.js`, `config.js`, `fp.min.js`). If set, this server also serves it at `/`, so test volunteers need only one address. Only those four paths are ever served. |
| `ipGeoFile` | none | CSV with the country of each IP range (`first,last,CC` or `cidr,CC`). Read at start. |
| `timezoneTable` | none | The `zone.tab` of the IANA time zone database, to compare the browser time zone with the country of the IP. Read at start. |
| `ipLists[]` | none | `{ tag, file }`: one CIDR per line. Labels the visitor address (`datacenter`, `tor_exit`...). No data is shipped. With `ranges: { from, to, numeric, match? }` the file is a table of comma separated values with the first and last address of each range in columns `from` and `to` (`numeric`: whole numbers, as some commercial free databases write them) and only the rows whose `match.column` has one of `match.equals`. List the same file twice with different `match` to give different tags. A wrong column refuses the start. The format of a particular database was not checked against a real file. |
| `sharedLimits` | `false` | Count the rate limits in the database so that they hold across all instances (needs MySQL). |

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
- **Turn off** with `"identity": { "enabled": false }`, for all tenants (`defaults`) or for one (`settings`).
- **Tune** every number of the decision (thresholds, how many devices are compared, the ambiguity margin, the weights,
  which features count) with the settings in [docs/configuracao.md](../docs/configuracao.md).
- **Possible link.** With `identity.possibleLinkProbability` set, a visit that was not attached but whose closest device
  is certain enough carries `possibleLink`. The identifiers stay separate: it is a lead, not a merge.
- **Same machine, other browser.** The visitor id is per browser. With `identity.sameMachine.enabled` (on by default), a visit
  that came from the same address as other devices a short while ago, and looks like the same machine as some of them
  seen only in other browsers, carries `identity.sameMachine.links` (each with the `visitorId`, the browsers, the machine
  features that agreed and the ones that differed). A crowded address gives `skipped: "shared_ip"` and no links. It is
  evidence for a rule or a person, never a merge, and `logOdds` is provisional (not calibrated). The risk fact is
  `identity.sameMachineCount`.
- **Tampered visits.** `identity.learnFromTampered` decides whether a visit with evidence of tampering may teach the
  engine (`not_high` by default). The resolution says `learned: false` when it did not.
- Limits: signals of the client cannot tell apart two physical devices that look identical; ids are not corrected afterwards
  (a merged pair stays merged); every resolution runs a few SQL queries, which fits thousands of devices, not millions.

```bash
node server/dist/cli.js fit-model dataset.jsonl --out model.json        # needs hundreds of labelled devices
node server/dist/cli.js eval-identity dataset.jsonl --model model.json  # in time order, against the original library
node server/dist/cli.js last-events --config config.json --tenant my-site   # shows the visitor of each visit
```

## Settings

Every behavior has a setting, listed in [docs/configuracao.md](../docs/configuracao.md) (generated from the code, so it is
always current). Layers, lowest first: code defaults, the old top-level fields of the file, `defaults`, and the `settings`
of each tenant. An unknown name stops the server with the closest known one. Edit the file and send `SIGHUP` to apply it
without a restart; a file with a mistake is refused and the running one stays.

```json
{ "defaults": { "retention": { "eventsDays": 60 } },
  "tenants": [ { "id": "shop", "settings": { "limits": { "collectPerMinutePerIp": 120 },
                                              "tamper": { "disabledChecks": ["clock_skew"] } } } ] }
```

## Network labels, risk and rules (phase 5)

`GET /v1/events/:id` also returns `risk` and `decision`, each `null` when the tenant turned it off.

```bash
node server/dist/cli.js fetch-ip-list aws --out lists/aws.txt      # also gcp and tor; --file reads a saved copy
```

```json
{ "ipLists": [ { "tag": "datacenter", "file": "lists/aws.txt" }, { "tag": "tor_exit", "file": "lists/tor.txt" } ],
  "ipGeoFile": "geo/dbip-country-lite.csv", "timezoneTable": "/usr/share/zoneinfo/zone.tab" }
```

- **Lists.** The project ships no data. Files from commercial databases with columns are read with `ranges` (see the table above). Download the public lists again from time to time (the server reads them at start).
- **Country.** `ipGeoFile` is a CSV of `first,last,CC` (the free DB-IP Lite layout) or `cidr,CC`.
- **Risk.** A sum of weights that you set (`risk.*`), cut at 100. Every `factors` item shows its weight. It is marked
  `heuristic: true` and `calibrated: false`: it is not the chance of fraud.
- **Velocity.** Accounts (`linkedId`) per device, devices per address and addresses per device in a window before the
  visit. Behind a shared address (an office, a mobile carrier) many devices are normal: the default threshold is high.
- **Rules.** `rules.list` turns facts into a decision you name (`review`, `block`...). The server does not act on it. See
  [docs/regras.md](../docs/regras.md) for the facts and operators.
- **Behavior.** The page can turn on a count of interactions (`collect({ include: ['behavior'] })`). Never their content.

## Query API, webhooks, dashboard and SDK (phase 6)

All of these need the secret key (`Authorization: Bearer sk_...`) and show only the tenant that owns it.

| Request | Answer |
|---|---|
| `GET /v1/events?since&until&linkedId&ip&order&limit&after` | `{ events: [summary], next }`. `since` is included, `until` is not. Times are milliseconds or an ISO date. Newest first by default. Follow `next` as `after`. |
| `GET /v1/visitors/:id?limit` | `{ visitorId, firstSeen, lastSeen, visits, events }` |
| `GET /v1/webhooks/deliveries?status=failed\|pending\|done` | The deliveries and why a failed one failed |
| `POST /v1/webhooks/deliveries/:id/retry` | Puts a failed delivery back in the queue |

**Webhooks.** Set `webhooks.endpoints` (per tenant). Each visit is sent as `{ id, type: "visit.completed", createdAt, tenantId, visit }`
with `X-Fingerprint-Signature: t=<seconds>,v1=<hmac>`. Check it with the SDK:

```js
const { verifyWebhook } = require('./server/dist/sdk')
const ok = verifyWebhook({ secret: process.env.WEBHOOK_SECRET, body: rawBody, signature: req.headers['x-fingerprint-signature'] })
```

Use the raw body, as received. Delivery is at least once: the `id` lets you ignore a repeat. A failure is retried with a wait that
doubles up to `webhooks.maxDelaySeconds`; a 4xx other than 408 and 429 is final. Private addresses are refused unless
`webhooks.allowPrivateNetworks` is on.

**SDK.** `const { FingerprintClient } = require('./server/dist/sdk')`, then `new FingerprintClient({ baseUrl, secretKey })` with
`getEvent`, `listEvents`, `iterateEvents` and `getVisitor`. It belongs to your backend: never put the secret key in a browser.

**Dashboard.** `"dashboard": true` serves it at `/dashboard/`. The key is typed into the page and kept in memory only.

**First-party integration.** Put the server behind your own hostname so that the page, the script and the API share it:

```json
{ "basePath": "/fp", "collectorFile": "/app/fp.min.js", "collectorPath": "/static/app-7f3a.js", "trustedProxies": ["10.0.0.0/8"] }
```

```nginx
location /fp/ { proxy_pass http://127.0.0.1:8080; proxy_set_header X-Forwarded-For $remote_addr; }
```

With `basePath` the server answers only under `/fp/`. The log line `collector_ready` prints the `integrity` value for the script tag.
Behind a proxy the JA4 and header order are the proxy's, not the visitor's (`viaProxy`): run the server in direct mode if you need them.

## Privacy and the rights of the visitor (phase 7)

Templates for the legal texts are in [docs/plano/privacidade/](../docs/plano/privacidade/README.md). They are working templates, not legal advice.

| Setting | What it does |
|---|---|
| `privacy.ipStorage` | `full`, `truncated` (/24, /48), `hash` (keyed per tenant; pseudonymous, not anonymous) or `none`. The list labels and the country are kept in every mode. Set `ipHashSecret` (32+ characters) for the hash key. |
| `privacy.dropSignals` | Signals the server throws away on arrival, before the matcher, the checks and the storage |
| `privacy.requireConsent` | Refuse (422) a visit that does not declare `consent: { basis: "consent" }` |
| `audit.*` | Record of accesses: `GET /v1/audit?since&until&limit&after` |
| `api.allowDeletion`, `api.allowIdentityEdits`, `api.maxExportEvents` | Turn deletion off; turn merge and split off; cut an export |

| Request | What it does |
|---|---|
| `GET /v1/subjects/export?linkedId=` | Everything kept about the visits with that linked id |
| `DELETE /v1/subjects?linkedId=` | Deletes those visits, the webhook deliveries that mention them and the devices left with no visit |
| `DELETE /v1/visitors/:id` | The same for one visitor |
| `POST /v1/visitors/:id/merge` `{ "into": "<visitor id>" }` | Joins two devices into one: the values and the visits of both, and the old id keeps working as a name for the new one. A person's decision, never the engine's. |
| `POST /v1/visitors/:id/split` `{ "requestIds": ["..."] }` | Takes those visits off the device into a new one. Never all of its visits. What an older visit taught, whose event is gone, stays with the device. |
| `GET /v1/visitors/:id/person` | The person this device belongs to (`identity.person.enabled`): `devices`, the account ids they used (`linkedIds`), the `edges` that group them (same account, same machine, a person's decision), the `evidence` that groups nothing (same address, a device that was not close enough to join), `evidenceDevices` and `truncated`. Worked out when read, per tenant. |
| `POST /v1/visitors/:id/links` `{ "with": "<visitor id>", "decision": "confirm" \| "reject" \| "clear" }` | A person's decision about two devices. `confirm`: same person, whatever the ties say. `reject`: not the same person, final (nothing brings the tie back). `clear`: takes the decision back. Needs `api.allowIdentityEdits`; audited as `visitor.link`. |

Merging and splitting go to the audit log (`visitor.merge`, `visitor.split`; reading a person is `visitor.person` and a decision about a tie is `visitor.link`) and can be turned off with `api.allowIdentityEdits`. They are the way to fix a duplicate that `identity.onAmbiguous: separate` left on purpose, using the `possibleLink` mark as the lead.

A deletion does not reach backups. Every export and deletion is written to the audit log (action, target, key, caller, status; never the content).

## Moving from SQLite to MySQL

```bash
node server/dist/cli.js migrate-sqlite --from /data/events.db --config config-mysql.json
```

The MySQL database of the configuration must be empty (`--append` adds to one that is not, and fails on a row that is
already there). It copies tenants, events, devices and their values, resolutions, aliases, webhook deliveries, the audit
log, the usage and the graph, counts the counters of the identity again from the facts, and checks that the number of rows
of each table is the same and that the counters agree with the ones SQLite had. It does not copy the challenges (they live
minutes). Stop the old server first, so that nothing is written during the copy. It copies in batches of a thousand rows
and cannot be resumed: on a failure, empty the MySQL database and start again.

## Insight reports and the shared graph (phase 9)

| Request | What it shows |
|---|---|
| `GET /v1/drift?windowDays=7` | Per feature, how its values moved between the last window and the one before (Jensen-Shannon divergence, share of new values). A hint, not an alarm. Settings: `drift.*` |
| `GET /v1/anonymity?k=5` | Per feature, the share of devices whose value fewer than k devices share (how much the feature singles out) |
| `GET /v1/nonce` | May carry `profile` (what the server asks the page to leave out or add). Apply it with `profileToOptions(profile)` of the browser library. Settings: `collection.*` |

The **shared graph** between tenants is off and locked: it needs `sharedGraph.enabled`, the reference of a legal opinion and its
own secret in the configuration, and each tenant must join. Read
[docs/plano/privacidade/grafo-compartilhado.md](../docs/plano/privacidade/grafo-compartilhado.md) first. Do not turn it on without the opinion.

## Operations (phase 8)

| What | How |
|---|---|
| Alive | `GET /healthz` |
| Ready | `GET /readyz`: the storage answers and no webhook due has waited more than 10 minutes. The reason goes to the log, not to the caller. The container `HEALTHCHECK` asks this (`node dist/healthcheck.js`). |
| Metrics | `GET /metrics` in the Prometheus text format, with `Authorization: Bearer <key>`. Set `metricsKeySha256` (a list of SHA-256 hashes); without it the path answers 404. A metrics key reads nothing else. |
| Connections | `maxConnections` (default 10000): more are closed at once |
| Stopping | `SIGTERM` or `SIGINT` closes the listeners, lets the webhook pass finish and closes the database; after 15 seconds it exits anyway |
| Load test | `node tools/loadtest/run.js --url ... --pk ... --sk ... --seconds 20 --concurrency 16 --devices 5000` (use a throwaway tenant and database) |

The log has one JSON line per request with the route, the tenant, the status and the time. It never has an address, a key, a
payload or what a visitor sent, and a test looks for exactly those. The metrics have no label that a client chooses.

## More evidence about the visit

| What | How it works | Settings |
|---|---|---|
| **Search crawlers** | A visit whose user agent says it is Googlebot, Bingbot, Applebot, YandexBot or Baiduspider is checked by DNS the way those engines ask for it: the name of the address must be in the domain that the engine publishes, and the name must lead back to the address. The result is `network.crawler = { claimed, verified }`, with `verified` true, false or null (DNS did not answer: never called false). A visit that claims a crawler and is not one adds the risk factor `fake_crawler`. Only a user agent that claims a crawler is ever looked up. Each lookup sends the visitor's address to the DNS server of the machine. | `bots.*`, `risk.fakeCrawlerWeight`, facts `crawler.claimed`, `crawler.verified` |
| **Stored code** | A random code kept in the browser (cookie, local storage and IndexedDB) that the matcher counts as the strongest evidence of the same browser. Off by default. A tenant turns it on (`identity.storedId.enabled`) and chooses the bases it accepts (`identity.storedId.bases`); the server throws the signal away from a visit that did not declare one of them. A visit with the code of a known device that disagrees with that device on what does not change is marked `storedIdConflict` (the code may have been copied to another machine) and adds the risk factor `stored_id_conflict`. See `docs/collector.md` for the browser side. | `identity.storedId.*`, `identity.storedIdConflictThreshold`, `risk.storedIdConflictWeight` |
| **Environment** | Facts about the place the visit comes from: `private_mode_likely` (a small storage quota), `virtual_machine_gpu`, `software_renderer`. They are not tampering and weigh nothing in the risk until the tenant gives them a weight. | `environment.*`, `risk.environmentWeights`, fact `environment.signals` |

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
fire for legitimate setups such as privacy extensions: read them as hints. Per tenant you can turn the evidence off
(`tamper.enabled`, then `tamper` is `null`), turn single checks off (`tamper.disabledChecks`), change how serious a
check is (`tamper.severity`) and how far off a clock may be (`tamper.clockSkewSeconds`).

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

## Several instances on one MySQL database

You can run more than one server on the same database. What is shared, and what is not:

| Shared through the database | Per instance |
|---|---|
| The turn on a tenant: while one instance decides about a visit of a tenant, the others wait (`GET_LOCK`, on connections kept apart, `database.lockConnections` and `database.lockWaitSeconds`). Without it, one device seen by two instances at once would become two devices. | The rate limits, unless `sharedLimits: true` (needs MySQL). Then they are counted in the database in fixed windows of a minute, a little coarser than the token bucket. |
| The challenges (one use, whichever instance issued it), the usage and quotas, the audit log, the graph | The settings. `SIGHUP` reloads one instance, so send it to all. |
| The webhook queue: each delivery is reserved for one instance for two minutes, and the reservation ends by itself if the instance dies | The memory of verified crawlers and the metrics (scrape every instance) |
| The tenants made through the admin API: each instance reads them again every `tenants.refreshSeconds` (60) | |
| The schema: instances that start together take a lock, and the steps run once | |

The retention pass runs in every instance and is safe to repeat. Not verified: more than two instances, a database behind a
proxy that changes connections between statements (named locks need a connection that stays), and a cluster of MySQL.

## Reports of a collector that could not be reached

The server cannot see a visitor whose network blocks its port or whose blocker stops the collector. The loader in the
browser (`docs/collector.md`, "Loader") sees it and posts a small report to an address on the customer's own site. A
second process of the same image receives those reports:

```bash
node dist/cli.js reachability-receiver --db /data/reach.db --host 0.0.0.0 --port 8090 \
  --allowed-origin https://app.example.com --trust-forwarded-from 172.18.0.0/16 --keep-days 90
node dist/cli.js reachability-summary --db /data/reach.db --days 30 [--utc-offset -3] [--json]
```

- It is public and has no key, so the body is limited to 4 KB, the shape is closed (anything else in the body is dropped),
  the `Origin` is checked, and there is a limit per address (an IPv6 one by its /64) and a total one
  (`--rate-per-ip`, `--rate-total`, per minute). `X-Forwarded-For` is believed only from `--trust-forwarded-from`, read from
  the right. Put it behind the proxy of the customer's site and do not publish its port.
- **The address is never stored.** It is used at that moment to look up the network and to make `prefix_hash`, a keyed hash
  of the /24 (IPv4) or /64 (IPv6) that counts distinct networks. The key is in `<db>.secret` (mode 0600) or `--secret-file`.
  The `User-Agent` is read and dropped: only the browser family and whether it is a phone are kept.
- `--asn-file networks.csv --asn-from 0 [--asn-to 1] --asn-number 2 --asn-name 3` names the networks. The project ships no
  data and assumes no provider's layout: the columns are the operator's (counted from 0), a wrong one stops the start with
  the line number, and only the number and the name are stored. Check the licence of the file you use.
- The summary is in Portuguese: by reason, probe, browser, hour of the day (a peak in every network at once means the server
  was down, not a network blocking it) and network. It counts reports, not visitors: divide by the sign-ups of the period.

Analysis, limits and what was not verified (Safari, a real network that blocks the port):
`docs/plano/detectar-bloqueio-da-porta-8443-e-do-coletor-aviso-de-falha-loader-receptor-asn-lgpd.md`.

## Limits you should know

- **Node cannot see everything.** `remoteSettings` of an HTTP/2 client lists every setting with the protocol default for the
  ones that were not sent, so "not sent" and "sent the default" look the same. The first `WINDOW_UPDATE` and the `PRIORITY`
  frames are not exposed at all. Passive TCP/IP fingerprints (p0f style) need a packet-level view and are not available.
- **Storage.** Each event keeps the whole payload (about 45 KB). A million events in the retention window is tens of GB.
  Phase 3 will move the heavy parts (canvas images) out of every row. SQLite writes block the event loop for a moment each.
- **MySQL throughput was measured only on a laptop** (MySQL in Docker on macOS, one tenant): about 30 visits per second and
  a median of about 500 ms with 16 workers, 45 ms with one. The cause of the ceiling was not isolated. Visits of one tenant
  decide one at a time, on purpose (otherwise two simultaneous visits of one device make two devices). Not checked: MariaDB,
  managed MySQL, read replicas, and moving a large SQLite database to MySQL (`migrate-sqlite` exists, tested with little data).
- **Rate limits are per process.** With more than one process, the real limit is multiplied.
- **The nonce proves the flow, not honesty.** The client code is public, so a determined attacker can craft any payload.
  Signed results and stronger checks are phase 4.
- **Nothing here is production-hardened.** Key rotation, metrics, structured alerts and load tests are phase 8.
- **Slow clients.** The TLS front waits up to 5 seconds for a ClientHello and keeps up to 64 KB per waiting connection.
  Many such connections cost memory; a limit on concurrent connections is phase 8.
