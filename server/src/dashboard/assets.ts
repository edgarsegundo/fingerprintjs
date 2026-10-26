/* eslint-disable max-len -- these are an embedded page, style sheet and script, not code of the server */
/**
 * The dashboard: one page, one script and one style sheet, served by the server itself. They live in code (and not in
 * files on disk) so that the set that is served is fixed, there is no path to traverse, and nothing has to be copied.
 *
 * The page keeps the secret key in memory only. It never writes it to storage, so closing the tab forgets it. Everything
 * that comes from a visit (user agent, linked id, addresses) was sent by a browser that may be hostile, so the script
 * puts it on the page with `textContent` only. It never builds markup from data, and the content security policy
 * would stop an inline script anyway.
 */
export const dashboardIndex = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Visitor dashboard</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
  <h1>Visitors</h1>
  <a href="/dashboard/config">Settings</a>
  <form id="connect" autocomplete="off">
    <label for="key">Secret key</label>
    <input id="key" type="password" placeholder="sk_..." autocomplete="off" spellcheck="false" required>
    <button type="submit">Connect</button>
  </form>
</header>
<p id="status" role="status"></p>
<nav id="tabs" hidden>
  <button type="button" data-tab="visits" aria-pressed="true">Visits</button>
  <button type="button" data-tab="webhooks" aria-pressed="false">Webhooks</button>
</nav>
<main>
  <section id="visits" hidden>
    <form id="filters">
      <label>Linked id <input name="linkedId" maxlength="128"></label>
      <label>Address <input name="ip" maxlength="64"></label>
      <label>From <input name="since" type="datetime-local"></label>
      <label>Until <input name="until" type="datetime-local"></label>
      <label>Order
        <select name="order"><option value="desc">Newest first</option><option value="asc">Oldest first</option></select>
      </label>
      <button type="submit">Search</button>
    </form>
    <div class="scroll">
      <table id="list">
        <thead><tr><th>Time</th><th>Visitor</th><th>Linked id</th><th>Address</th><th>Country</th><th>Risk</th><th>Decision</th><th>Tamper</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <p><button id="more" type="button" hidden>Load more</button></p>
    <article id="detail" hidden></article>
  </section>
  <section id="webhooks" hidden>
    <form id="deliveryFilters">
      <label>Status
        <select name="status"><option value="failed">Failed</option><option value="pending">Pending</option><option value="done">Done</option><option value="">All</option></select>
      </label>
      <button type="submit">Show</button>
    </form>
    <div class="scroll">
      <table id="deliveries">
        <thead><tr><th>Created</th><th>Endpoint</th><th>Status</th><th>Attempts</th><th>Last error</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </section>
</main>
<script src="app.js"></script>
</body>
</html>
`

export const dashboardStyle = `:root {
  color-scheme: light dark;
  --bg: #fafafa; --fg: #1b1b1f; --muted: #62626b; --line: #d9d9e0; --card: #ffffff; --accent: #2457d6;
  --low: #1f7a3d; --medium: #9a6a00; --high: #b3261e;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #131316; --fg: #ececf1; --muted: #9a9aa5; --line: #2d2d34; --card: #1b1b20; --accent: #7aa2ff;
    --low: #5ccf86; --medium: #e5b53c; --high: #ff7b72; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
h1 { margin: 0; font-size: 20px; }
form { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; margin: 8px 0; }
label { display: grid; gap: 2px; font-size: 12px; color: var(--muted); }
input, select, button { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); }
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
button[aria-pressed="true"] { background: var(--accent); color: #fff; border-color: var(--accent); }
#status { min-height: 1.5em; color: var(--muted); }
#status.error { color: var(--high); }
nav { display: flex; gap: 8px; margin: 8px 0; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.low { color: var(--low); } .medium { color: var(--medium); } .high { color: var(--high); }
.mono { font-family: ui-monospace, monospace; font-size: 12px; }
article { margin-top: 16px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
article h2 { margin: 0 0 8px; font-size: 16px; }
article h3 { margin: 16px 0 4px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
article ul { margin: 0; padding-left: 18px; }
pre { margin: 0; overflow-x: auto; font-size: 12px; }
@media (max-width: 600px) { body { padding: 12px; } }
`

/**
 * The script. It avoids template literals, so that this file can hold it as one literal without escaping.
 * It builds the page with `el` and `textContent` only.
 */
export const dashboardScript = `'use strict';
(function () {
  var secret = ''
  var cursor = null
  var lastQuery = ''

  function $(id) { return document.getElementById(id) }

  function el(tag, text, className) {
    var node = document.createElement(tag)
    if (text !== undefined && text !== null) { node.textContent = String(text) }
    if (className) { node.className = className }
    return node
  }

  function status(message, isError) {
    var node = $('status')
    node.textContent = message || ''
    node.className = isError ? 'error' : ''
  }

  function api(path, options) {
    var init = options || {}
    init.headers = { Authorization: 'Bearer ' + secret, Accept: 'application/json' }
    if (init.body) { init.headers['Content-Type'] = 'application/json' }
    init.cache = 'no-store'
    init.referrerPolicy = 'no-referrer'
    return fetch(path, init).then(function (response) {
      return response.json().catch(function () { return {} }).then(function (body) {
        if (!response.ok) {
          var detail = body && body.error ? body.error : 'error ' + response.status
          if (response.status === 401) { detail = 'the key was not accepted' }
          if (response.status === 429) { detail = 'too many requests, wait a moment' }
          throw new Error(detail)
        }
        return body
      })
    })
  }

  function when(ms) { return new Date(ms).toLocaleString() }

  function riskCell(risk) {
    if (!risk) { return el('td', '-') }
    return el('td', risk.score + ' ' + risk.level, risk.level)
  }

  function row(visit) {
    var tr = el('tr')
    tr.appendChild(el('td', when(visit.receivedAt)))
    var visitor = el('td', visit.visitorId ? visit.visitorId.slice(0, 10) : '-', 'mono')
    tr.appendChild(visitor)
    tr.appendChild(el('td', visit.linkedId || '-'))
    tr.appendChild(el('td', visit.ip, 'mono'))
    tr.appendChild(el('td', visit.country || '-'))
    tr.appendChild(riskCell(visit.risk))
    tr.appendChild(el('td', visit.decision || '-'))
    tr.appendChild(el('td', visit.tamper ? visit.tamper.high + '/' + visit.tamper.medium + '/' + visit.tamper.low : '-'))
    tr.addEventListener('click', function () { showEvent(visit.requestId) })
    return tr
  }

  function toIso(value) {
    if (!value) { return '' }
    var date = new Date(value)
    return isNaN(date.getTime()) ? '' : String(date.getTime())
  }

  function search(append) {
    var data = new FormData($('filters'))
    var query = new URLSearchParams()
    ;['linkedId', 'ip', 'order'].forEach(function (name) {
      var value = String(data.get(name) || '').trim()
      if (value) { query.set(name, value) }
    })
    ;['since', 'until'].forEach(function (name) {
      var value = toIso(String(data.get(name) || ''))
      if (value) { query.set(name, value) }
    })
    query.set('limit', '50')
    if (append && cursor) { query.set('after', cursor) }
    lastQuery = query.toString()
    status('Loading...')
    return api('/v1/events?' + query.toString()).then(function (page) {
      var body = $('list').tBodies[0]
      if (!append) { body.textContent = '' }
      page.events.forEach(function (visit) { body.appendChild(row(visit)) })
      cursor = page.next
      $('more').hidden = !page.next
      status(page.events.length === 0 && !append ? 'No visits found.' : '')
    }).catch(function (error) { status(error.message, true) })
  }

  function list(parent, items, render) {
    if (!items.length) { parent.appendChild(el('p', 'None.', 'muted')); return }
    var ul = el('ul')
    items.forEach(function (item) { ul.appendChild(render(item)) })
    parent.appendChild(ul)
  }

  function showEvent(requestId) {
    status('Loading...')
    api('/v1/events/' + encodeURIComponent(requestId)).then(function (event) {
      var box = $('detail')
      box.textContent = ''
      box.hidden = false
      box.appendChild(el('h2', 'Visit ' + requestId))
      box.appendChild(el('p', when(event.receivedAt) + ' from ' + event.network.ip + (event.network.ipIntel.country ? ' (' + event.network.ipIntel.country + ')' : '')))

      box.appendChild(el('h3', 'Decision'))
      box.appendChild(el('p', event.decision ? event.decision.action + (event.decision.reason ? ' - ' + event.decision.reason : '') + ' (rule ' + (event.decision.ruleId || 'default') + ')' : 'No rules configured.'))

      box.appendChild(el('h3', 'Risk' + (event.risk ? ': ' + event.risk.score + ' ' + event.risk.level + ' (heuristic, not calibrated)' : '')))
      if (event.risk) {
        list(box, event.risk.factors, function (factor) { return el('li', '+' + factor.weight + ' ' + factor.id + ': ' + factor.detail) })
      } else { box.appendChild(el('p', 'Turned off.')) }

      box.appendChild(el('h3', 'Tamper evidence'))
      if (event.tamper) {
        list(box, event.tamper.signals, function (signal) { return el('li', signal.severity + ' ' + signal.id + ': ' + signal.detail) })
      } else { box.appendChild(el('p', 'Turned off.')) }

      box.appendChild(el('h3', 'Identity'))
      if (event.identity) {
        var identity = event.identity
        var who = el('p')
        who.appendChild(el('span', identity.visitorId, 'mono'))
        who.appendChild(el('span', identity.matched ? ' - known device' : ' - new device'))
        who.appendChild(el('span', identity.calibrated ? ' - probability ' + identity.probability : ' - not calibrated (provisional ' + identity.provisionalProbability + ')'))
        box.appendChild(who)
        var open = el('button', 'Show this visitor', 'link')
        open.type = 'button'
        open.addEventListener('click', function () { showVisitor(identity.visitorId) })
        box.appendChild(open)
        list(box, identity.explanation, function (item) {
          return el('li', item.outcome + ' ' + item.feature + ' (weight ' + Number(item.weight).toFixed(2) + ', without it ' + Number(item.probabilityWithoutIt).toFixed(3) + ')')
        })
        addCorrections(box, requestId, identity.visitorId)
      } else { box.appendChild(el('p', 'Turned off.')) }

      box.appendChild(el('h3', 'Whole record'))
      var raw = el('pre')
      raw.textContent = JSON.stringify(event, null, 2)
      box.appendChild(raw)
      status('')
      box.scrollIntoView()
    }).catch(function (error) { status(error.message, true) })
  }

  /** A button that asks for a second click before it acts: merging and splitting cannot be undone by the panel */
  function confirmed(label, action) {
    var button = el('button', label)
    button.type = 'button'
    var timer = null
    button.addEventListener('click', function () {
      if (timer === null) {
        button.textContent = 'Click again to confirm'
        timer = setTimeout(function () { button.textContent = label; timer = null }, 5000)
        return
      }
      clearTimeout(timer)
      timer = null
      button.textContent = label
      action()
    })
    return button
  }

  /** Lets a person fix a decision of the engine: join this device to another one, or take this visit off its device */
  function addCorrections(box, requestId, visitorId) {
    box.appendChild(el('h3', 'Correct who is who'))
    box.appendChild(el('p', 'These change what the engine knows. A person decides; the engine never does it alone.', 'muted'))
    var target = el('input')
    target.type = 'text'
    target.placeholder = 'Visitor id to join this device to'
    target.setAttribute('aria-label', 'Visitor id to join this device to')
    target.autocomplete = 'off'
    var merge = confirmed('Merge this device into that one', function () {
      var into = target.value.trim()
      if (into === '') { status('Type the visitor id to join to.', true); return }
      api('/v1/visitors/' + encodeURIComponent(visitorId) + '/merge', { method: 'POST', body: JSON.stringify({ into: into }) })
        .then(function (result) { status('Merged. Now ' + result.visitorId + ' has ' + result.visits + ' visits.'); showEvent(requestId) })
        .catch(function (error) { status(error.message, true) })
    })
    var split = confirmed('Move this visit to a new device', function () {
      api('/v1/visitors/' + encodeURIComponent(visitorId) + '/split', { method: 'POST', body: JSON.stringify({ requestIds: [requestId] }) })
        .then(function (result) { status('Moved to the new device ' + result.visitorId + '.'); showEvent(requestId) })
        .catch(function (error) { status(error.message, true) })
    })
    var row1 = el('p')
    row1.appendChild(target)
    row1.appendChild(merge)
    box.appendChild(row1)
    box.appendChild(el('p')).appendChild(split)
  }

  function showVisitor(visitorId) {
    status('Loading...')
    api('/v1/visitors/' + encodeURIComponent(visitorId) + '?limit=50').then(function (visitor) {
      var body = $('list').tBodies[0]
      body.textContent = ''
      visitor.events.forEach(function (visit) { body.appendChild(row(visit)) })
      cursor = null
      $('more').hidden = true
      status('Visitor ' + visitor.visitorId + ': ' + visitor.visits + ' visits, first seen ' + when(visitor.firstSeen) + ', last seen ' + when(visitor.lastSeen) + '.')
    }).catch(function (error) { status(error.message, true) })
  }

  function loadDeliveries() {
    var data = new FormData($('deliveryFilters'))
    var statusFilter = String(data.get('status') || '')
    var query = statusFilter ? '?status=' + encodeURIComponent(statusFilter) + '&limit=100' : '?limit=100'
    status('Loading...')
    api('/v1/webhooks/deliveries' + query).then(function (result) {
      var body = $('deliveries').tBodies[0]
      body.textContent = ''
      result.deliveries.forEach(function (delivery) {
        var tr = el('tr')
        tr.style.cursor = 'default'
        tr.appendChild(el('td', when(delivery.createdAt)))
        tr.appendChild(el('td', delivery.endpointId))
        tr.appendChild(el('td', delivery.status))
        tr.appendChild(el('td', delivery.attempts))
        tr.appendChild(el('td', delivery.lastError || '-'))
        var cell = el('td')
        if (delivery.status === 'failed') {
          var button = el('button', 'Send again')
          button.type = 'button'
          button.addEventListener('click', function () {
            api('/v1/webhooks/deliveries/' + encodeURIComponent(delivery.id) + '/retry', { method: 'POST' })
              .then(loadDeliveries).catch(function (error) { status(error.message, true) })
          })
          cell.appendChild(button)
        }
        tr.appendChild(cell)
        body.appendChild(tr)
      })
      status(result.deliveries.length === 0 ? 'Nothing here.' : '')
    }).catch(function (error) { status(error.message, true) })
  }

  function selectTab(name) {
    ;['visits', 'webhooks'].forEach(function (id) { $(id).hidden = id !== name })
    Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-tab') === name))
    })
    status('')
    if (name === 'webhooks') { loadDeliveries() }
  }

  $('connect').addEventListener('submit', function (event) {
    event.preventDefault()
    secret = $('key').value.trim()
    $('key').value = ''
    if (secret.indexOf('sk_') !== 0) {
      secret = ''
      status('That is not a secret key. It starts with sk_.', true)
      return
    }
    $('tabs').hidden = false
    selectTab('visits')
    search(false)
  })
  $('filters').addEventListener('submit', function (event) { event.preventDefault(); search(false) })
  $('deliveryFilters').addEventListener('submit', function (event) { event.preventDefault(); loadDeliveries() })
  $('more').addEventListener('click', function () { search(true) })
  Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (button) {
    button.addEventListener('click', function () { selectTab(button.getAttribute('data-tab')) })
  })
})()
`
