# Collector (experimental)

`load()` + `get()` compute the visitor identifier in the browser. The collector does the opposite: it gathers the **raw
signals** and sends them to **your server**, which decides who the visitor is. The browser never computes, and never
receives, an identity.

This API is experimental and may change in a minor version. It is exported by name only (not in the default export),
so it adds nothing to the bundle of those who use `FingerprintJS.load()` from a bundler.

```js
import { collectAndSend } from '@fingerprintjs/fingerprintjs'

// 1. Ask your server for a one-time challenge (optional but needed for replay protection)
const { nonce } = await (await fetch('/api/nonce')).json()

// 2. Collect the signals and send them. Use an endpoint of your own domain.
const { requestId } = await collectAndSend({ endpoint: '/api/collect' }, { nonce })

// 3. Send `requestId` to your backend, which reads the identification result from your server.
```

`collect(options)` returns the payload without sending it; `send(payload, options)` sends a payload.
Neither contacts the library's CDN (unlike `load()`, which pings it unless `monitoring: false`).

## Options

| Option | Meaning |
|---|---|
| `nonce` | A challenge issued by your server, echoed in the payload. Reject payloads with an unknown or reused nonce. |
| `exclude` | Names of signals not to collect (both groups). Use it for data minimization, or to skip a signal that conflicts with your page. |
| (server profile) | `profileToOptions(profile)` turns the `profile` that may come with `GET /v1/nonce` into `exclude` and `include`. It accepts only valid signal names and, for `include`, only the opt-in signals of this library. |
| `consent` | `{ basis, version }`: the legal basis you rely on and the version of the privacy text. Stored with the visit. A server set to require consent refuses a visit whose `basis` is not `consent`. It records the decision; it does not make it. |
| `include` | Names of signals that are off by default: `webGpu`, `behavior` and `storedId`. `exclude` wins. `storedId` also needs `consent.basis` to be `consent` or `legitimate_interest`: without it the signal is left out even if it was asked for. |
| `forgetStoredId({ name? })` | Removes the stored code from the cookie, local storage and IndexedDB. Call it when the visitor takes back their agreement. It is a separate function, not an option of `collect`. |
| `storedIdName`, `storedIdMaxAgeDays` | The name of the cookie, local storage key and database of the stored code (default `_fpid`; 1 to 32 characters of letters, digits and `_`), and how long the cookie lives (default 365, at most 400). The server profile can set the lifetime. |
| `linkedId` | An opaque id of your own (1 to 128 characters of letters, digits and `_ - . :`; an e-mail is refused). The server stores it with the event. Never use a name, e-mail, phone or document number. |
| `delayFallback`, `debug` | Same as in `load()`. |

`send` options: `endpoint` (required), `timeoutMs` (10000), `credentials` (`same-origin`; use `include` for another
subdomain), `headers`, `fetch`.

## Payload (schema version 1)

```ts
{
  schema: 1,                 // reject versions you don't know
  libVersion: string,
  collectedAt: number,       // client clock: untrusted
  durationMs: number,
  nonce?: string,
  components: Record<string, Signal>,  // the 42 built-in sources, same keys and values as GetResult.components
  extended: Record<string, Signal>,    // the signals below
}
// Signal = { value?: unknown, error?: { name, message }, duration: number }
// Neither value nor error: the source succeeded and returned undefined (e.g. the API doesn't exist).
```

JSON turns `NaN`/`Infinity` into `null` and drops `undefined` fields. Error stacks are never sent.
A payload is about 45 KB, half of it the two canvas images.

## Server contract

The ingestion server in [server/](../server/README.md) implements this contract.
The simpler [tools/dev-receiver.js](../tools/dev-receiver.js) is only for trying the client; it stores nothing.

1. `GET /v1/nonce?k=<public key>` returns `{ nonce }`: random, single use, short lived, bound to the tenant.
2. `POST /v1/collect?k=<public key>` receives the payload and returns `{ requestId }` only. The client ignores any other field.
3. The server rejects: unknown `schema`, missing/unknown/used/expired `nonce`, bodies above a size limit, and too many requests.
4. The identification result is read by your backend with `requestId` and a secret key, never by the browser.

```js
await collectAndSend(
  { endpoint: 'https://fp.example.com:8443/v1/collect?k=pk_...', credentials: 'include' },
  { nonce }, // from GET https://fp.example.com:8443/v1/nonce?k=pk_...
)
```

A nonce prevents replaying a captured payload; it does not prove the payload is honest. The client code is public, so a
determined attacker can craft any payload. The extended signals below are evidence for the server to weigh, not verdicts.

## Extended signals

| Key | What it is | Use | Caveat |
|---|---|---|---|
| `workerContext` | `navigator` and `Intl` values in the page and in a Web Worker, plus the worker's WebGL strings | Spoofing tools often patch the page only; any difference is evidence | The worker is a `blob:` URL: a Content Security Policy without `worker-src blob:` blocks it (reported as `unavailable`) and the browser logs a CSP error. Exclude it in that case. |
| `speechVoices` | Installed text-to-speech voices | High entropy: depends on OS, language packs, browser | Chrome loads the list asynchronously (up to 750 ms wait). Network voices (`local: false`) depend on the connection: don't use them to identify. |
| `webGpu` | WebGPU adapter info, features, limits | Precise GPU description; `adapter: false` is common in VMs and headless | **Off by default** (`include: ['webGpu']`): without a usable GPU, Chrome itself prints "Failed to create WebGPU Context Provider" in the console, which breaks the no-console-output rule for sources. |
| `behavior` | **Counts only** of pointer moves, clicks, key presses, scrolls and touches, plus how many such events a script made (`isTrusted` false) and how long the page was observed | A script that fills a form without touching the page, or that dispatches synthetic events | **Off by default** (`include: ['behavior']`). It is a form of monitoring, so say it in your privacy notice. Start it early with `observeBehavior()`: a summary taken by `collect` alone has seen almost nothing (`observedMs` says so, and the server then treats it as unknown). Never the content: no coordinates, no key identity, no timing of each event. Password managers and some accessibility tools also dispatch synthetic clicks. |
| `storedId` | A random 128-bit code that the page keeps in a cookie, local storage and IndexedDB and sends with each visit, as `{ token, foundIn, created }` | The strongest evidence that it is the same browser, even when other signals changed. The server compares only a digest of it, and a different or missing code is weak evidence, never proof of a different device | **A persistent identifier written to the visitor's device**, so it is off by default and the page must declare `consent.basis` of `consent` or `legitimate_interest` (the tenant chooses which on the server). Say it in your privacy notice. Clearing site data or a private window removes it; Safari limits what a script writes to 7 days without a visit. The code is random and says nothing about the visitor. A copy of it on another machine is flagged by the server (`storedIdConflict`). |
| `storageQuota` | Origin storage quota in bytes | Disk size; much smaller in private mode in some browsers | Compare in buckets, not exactly. Usage is deliberately not collected. |
| `notificationPermission` | `Notification.permission` and the Permissions API answer | Disagreement was a headless tell | Chrome 155 headless no longer shows it; weak evidence on its own. |
| `mediaSupport` | `canPlayType`, Media Source and `MediaRecorder` answers for 23 types | Depends on browser build, OS and hardware decoders | Changes with browser updates. |
| `nativeIntegrity` | Whether key getters/methods look native; own properties of `navigator` and `screen` | Spoofers replace functions or define values on the instance | A `Proxy` can imitate the native look; privacy extensions also patch APIs. |
| `automationHints` | `navigator.webdriver`, known automation globals and attributes, ChromeDriver keys, `outerWidth/Height` | Catches careless automation | Trivial to remove: a headless Chrome 155 without flags is not flagged. |

## Privacy notes

- Collecting is for fraud prevention and security on your own properties. Describe it in your privacy policy and
  document the legal basis (for example, legitimate interest under LGPD art. 7 IX with a balancing test).
- Collect the minimum: use `exclude` to drop signals you don't need.
- The payload contains no URL, no page content, no cookies, no storage usage and no error stacks.
- The identifier is created and kept on the server. Define a retention period there.
