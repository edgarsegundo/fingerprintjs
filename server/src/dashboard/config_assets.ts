/* eslint-disable max-len -- these are an embedded page, style sheet and script, not code of the server */
/**
 * The settings panel: one page, one script and one style sheet, served by the server itself, in the same way as the
 * dashboard of the visits (see `assets.ts`): fixed set, no path to traverse, nothing copied.
 *
 * It logs in with the key of the operator (`adm_...`) and keeps it in memory only. The explanation of every parameter
 * comes from `GET /admin/v1/parameters`; the values come from `GET /admin/v1/tenants/:id/settings`; a change is saved with
 * `PATCH /admin/v1/tenants/:id`. Everything that comes from the server is put on the page with `textContent` only.
 *
 * The script avoids template literals, backticks and backslashes, so this file can hold it as one literal.
 */
export const configIndex = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Configuração do servidor</title>
<link rel="stylesheet" href="/dashboard/config/style.css">
</head>
<body>
<header>
  <h1>Configuração</h1>
  <form id="connect" autocomplete="off">
    <label for="key">Chave de operador</label>
    <input id="key" type="password" placeholder="adm_..." autocomplete="off" spellcheck="false" required>
    <button type="submit">Entrar</button>
  </form>
</header>
<p id="status" role="status"></p>
<main id="app" hidden>
  <aside>
    <h2>Tenants</h2>
    <ul id="tenants"></ul>
    <button id="newTenantButton" type="button">Novo tenant</button>
    <form id="newTenant" hidden>
      <label>Identificador <input name="id" maxlength="64" pattern="[A-Za-z0-9_-]+" required></label>
      <label>Nome <input name="name" maxlength="100"></label>
      <label>Origens permitidas (uma por linha)<textarea name="origins" rows="3" placeholder="https://app.exemplo.com"></textarea></label>
      <button type="submit">Criar</button>
    </form>
    <div id="created" hidden></div>
    <p class="muted" id="coverage"></p>
    <p><a href="/dashboard/">Painel de visitas</a></p>
  </aside>
  <section id="tenant" hidden>
    <div id="summary"></div>
    <div id="toolbar">
      <input id="search" type="search" placeholder="Buscar parâmetro (nome, texto, caminho)" aria-label="Buscar parâmetro">
      <label class="inline"><input id="onlyChanged" type="checkbox"> só alterados</label>
      <span id="count" class="muted"></span>
      <button id="discard" type="button">Descartar</button>
      <button id="apply" type="button">Aplicar</button>
    </div>
    <div id="problems" role="alert" hidden></div>
    <div id="risk" hidden></div>
    <div id="groups"></div>
  </section>
</main>
<script src="/dashboard/config/app.js"></script>
</body>
</html>
`

export const configStyle = `:root {
  color-scheme: light dark;
  --bg: #fafafa; --fg: #1b1b1f; --muted: #62626b; --line: #d9d9e0; --card: #ffffff; --accent: #2457d6;
  --low: #1f7a3d; --medium: #9a6a00; --high: #b3261e; --tip: #eef3ff;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #131316; --fg: #ececf1; --muted: #9a9aa5; --line: #2d2d34; --card: #1b1b20; --accent: #7aa2ff;
    --low: #5ccf86; --medium: #e5b53c; --high: #ff7b72; --tip: #1e2433; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
h1 { margin: 0; font-size: 20px; }
h2 { margin: 0 0 8px; font-size: 15px; }
h3 { margin: 0; font-size: 14px; }
form { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; margin: 8px 0; }
label { display: grid; gap: 2px; font-size: 12px; color: var(--muted); }
label.inline { display: inline-flex; gap: 6px; align-items: center; }
input, select, button, textarea { font: inherit; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--card); color: var(--fg); }
textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 12px; }
button { cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .5; cursor: not-allowed; }
button.primary, #apply { background: var(--accent); color: #fff; border-color: var(--accent); }
#status { min-height: 1.5em; color: var(--muted); }
#status.error { color: var(--high); }
main { display: grid; grid-template-columns: 240px 1fr; gap: 16px; align-items: start; }
aside, #tenant { min-width: 0; }
aside ul { list-style: none; margin: 0 0 8px; padding: 0; display: grid; gap: 4px; }
aside li button { width: 100%; text-align: left; }
aside li button[aria-pressed="true"] { background: var(--accent); color: #fff; border-color: var(--accent); }
.muted { color: var(--muted); font-size: 12px; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; }
#summary { padding: 12px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); margin-bottom: 12px; }
#summary p { margin: 4px 0; }
#toolbar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  padding: 8px 0; background: var(--bg); }
#toolbar input[type="search"] { flex: 1 1 240px; }
#problems, #risk, .banner { padding: 10px 14px; border-radius: 8px; border: 1px solid var(--high); margin: 8px 0; }
#risk { border-color: var(--medium); }
.banner { border-color: var(--medium); }
#problems ul, #risk ul { margin: 4px 0 0; padding-left: 18px; }
details.group { border: 1px solid var(--line); border-radius: 8px; background: var(--card); margin-bottom: 8px; }
details.group > summary { cursor: pointer; padding: 10px 14px; font-weight: 600; }
.param { padding: 10px 14px; border-top: 1px solid var(--line); }
.param.changed { border-left: 3px solid var(--accent); }
.param.invalid { border-left: 3px solid var(--high); }
.param .head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 4px; }
.param .path { font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); }
.param .control { max-width: 560px; }
.param .meta { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-top: 4px; font-size: 12px; color: var(--muted); }
.param .error { color: var(--high); font-size: 12px; margin-top: 2px; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid var(--line); color: var(--muted); }
.badge.changed { color: var(--accent); border-color: var(--accent); }
.badge.legal, .badge.attention { color: var(--medium); border-color: var(--medium); }
button.helptip { width: 24px; height: 24px; padding: 0; border-radius: 50%; line-height: 1; font-weight: 700; }
button.helptip[aria-expanded="true"] { background: var(--accent); color: #fff; border-color: var(--accent); }
button.link { border: 0; background: none; padding: 0; color: var(--accent); text-decoration: underline; }
.tip { margin: 6px 0 8px; padding: 10px 14px; border-radius: 8px; background: var(--tip); border: 1px solid var(--line); }
.tip p { margin: 4px 0; }
.tip h4 { margin: 12px 0 2px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.tip ul { margin: 2px 0; padding-left: 18px; }
.tip .note { margin: 8px 0 0; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--medium); }
code { font-family: ui-monospace, monospace; font-size: 12px; background: color-mix(in srgb, var(--accent) 12%, transparent);
  padding: 0 4px; border-radius: 4px; }
#created { margin: 8px 0; padding: 10px 14px; border: 1px solid var(--medium); border-radius: 8px; word-break: break-all; }
@media (max-width: 800px) { main { grid-template-columns: 1fr; } body { padding: 12px; } }
`

export const configScript = `'use strict';
(function () {
  var adminKey = ''
  var catalog = []
  var byPath = {}
  var tenants = []
  var current = null
  var base = {}
  var draft = {}
  var invalid = {}
  var serverProblems = {}
  var rows = {}
  var riskAcknowledged = false
  var tick = String.fromCharCode(96)
  var newline = String.fromCharCode(10)

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
    init.headers = { Authorization: 'Bearer ' + adminKey, Accept: 'application/json' }
    if (init.body) { init.headers['Content-Type'] = 'application/json' }
    init.cache = 'no-store'
    init.referrerPolicy = 'no-referrer'
    return fetch(path, init).then(function (response) {
      return response.json().catch(function () { return {} }).then(function (body) {
        if (!response.ok) {
          var error = new Error(body && body.error ? body.error : 'erro ' + response.status)
          error.status = response.status
          error.body = body
          if (response.status === 401) { error.message = 'a chave não foi aceita' }
          if (response.status === 404) { error.message = 'o servidor não tem chave de operador configurada (adminKeySha256)' }
          if (response.status === 429) { error.message = 'muitas tentativas, espere um momento' }
          throw error
        }
        return body
      })
    })
  }

  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
  function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key) }

  /** Text with inline code: what is between two backticks is shown as code. Nothing here becomes markup. */
  function richText(parent, text) {
    String(text).split(tick).forEach(function (piece, index) {
      parent.appendChild(index % 2 === 1 ? el('code', piece) : document.createTextNode(piece))
    })
  }

  function paragraphs(parent, text) {
    String(text).split(newline + newline).forEach(function (paragraph) {
      var p = el('p')
      richText(p, paragraph)
      parent.appendChild(p)
    })
  }

  function section(parent, title, content) {
    if (!content) { return }
    parent.appendChild(el('h4', title))
    if (typeof content === 'string') { paragraphs(parent, content); return }
    var list = el('ul')
    content.forEach(function (item) {
      var li = el('li')
      richText(li, item)
      list.appendChild(li)
    })
    parent.appendChild(list)
  }

  // ---- The explanation of a parameter (helptip)

  function buildTip(entry, id) {
    var help = entry.help
    var tip = el('div', null, 'tip')
    tip.id = id
    tip.hidden = true
    var summary = el('p')
    richText(summary, help ? help.summary : entry.description)
    tip.appendChild(summary)
    var flags = help && help.flags ? help.flags : {}
    if (flags.legal) { tip.appendChild(el('p', 'Exige base legal ou parecer jurídico antes de ligar.', 'note')) }
    if (flags.restart) { tip.appendChild(el('p', 'Só vale depois de reiniciar o servidor.', 'note')) }
    if (!help) {
      tip.appendChild(el('p', 'A explicação completa deste parâmetro ainda está sendo escrita. O texto acima é o resumo da tabela de parâmetros.', 'muted'))
      return tip
    }
    var full = el('div')
    full.hidden = true
    paragraphs(full, help.what)
    section(full, 'Quando aumentar', help.raise)
    section(full, 'Quando diminuir', help.lower)
    section(full, 'Casos de uso', help.useCases)
    section(full, 'Cuidado', help.caution)
    section(full, 'Enquanto só coleta amostras', help.whileCollecting)
    var toggle = el('button', 'Ver explicação completa', 'link')
    toggle.type = 'button'
    toggle.addEventListener('click', function () {
      full.hidden = !full.hidden
      toggle.textContent = full.hidden ? 'Ver explicação completa' : 'Esconder explicação completa'
    })
    tip.appendChild(toggle)
    tip.appendChild(full)
    return tip
  }

  // ---- Values

  function valueOf(path) { return has(draft, path) ? draft[path] : current.effective[path] }

  function short(value) {
    var text = JSON.stringify(value)
    if (text === undefined) { return '-' }
    return text.length > 80 ? text.slice(0, 77) + '...' : text
  }

  function changedPaths() {
    var seen = {}
    Object.keys(draft).concat(Object.keys(base)).forEach(function (path) { seen[path] = true })
    return Object.keys(seen).filter(function (path) { return !same(draft[path], base[path]) || has(draft, path) !== has(base, path) })
  }

  function setDraft(path, value) {
    if (same(value, current.inherited[path])) { delete draft[path] } else { draft[path] = value }
    riskAcknowledged = false
  }

  /** What is wrong with a value, by the allowed values of the parameter. The server checks again when it is saved. */
  function checkClient(entry, value) {
    var kind = entry.kind
    if (value === null) { return entry.nullable ? '' : 'não pode ficar vazio' }
    if (kind.type === 'integer' || kind.type === 'number') {
      if (typeof value !== 'number' || !isFinite(value)) { return 'precisa ser um número' }
      if (kind.type === 'integer' && Math.floor(value) !== value) { return 'precisa ser um número inteiro' }
      if (kind.exclusive ? (value <= kind.min || value >= kind.max) : (value < kind.min || value > kind.max)) {
        return 'fora da faixa: ' + entry.kindText
      }
    }
    return ''
  }

  // ---- Controls: each one reads its own value, and can be set from outside (to restore the default)

  function makeControl(entry, initial, onValue) {
    var kind = entry.kind
    var node
    var read
    var write
    var BAD = { bad: true }
    if (kind.type === 'boolean') {
      node = el('select')
      ;[['true', 'Ligado'], ['false', 'Desligado']].forEach(function (pair) {
        var option = el('option', pair[1]); option.value = pair[0]; node.appendChild(option)
      })
      read = function () { return node.value === 'true' }
      write = function (value) { node.value = String(value) }
    } else if (kind.type === 'enum') {
      node = el('select')
      kind.values.forEach(function (name) { var option = el('option', name); option.value = name; node.appendChild(option) })
      read = function () { return node.value }
      write = function (value) { node.value = value }
    } else if (kind.type === 'integer' || kind.type === 'number') {
      node = el('input')
      node.type = 'number'
      node.min = String(kind.min)
      node.max = String(kind.max)
      node.step = kind.type === 'integer' ? '1' : 'any'
      if (entry.nullable) { node.placeholder = 'vazio: usa o valor do modelo' }
      read = function () { return node.value === '' ? null : Number(node.value) }
      write = function (value) { node.value = value === null ? '' : String(value) }
    } else if (kind.type === 'string') {
      node = el('input')
      node.type = 'text'
      if (entry.nullable) { node.placeholder = 'vazio: sem valor' }
      read = function () { return node.value === '' && entry.nullable ? null : node.value }
      write = function (value) { node.value = value === null ? '' : String(value) }
    } else {
      node = el('textarea')
      node.rows = 3
      node.spellcheck = false
      read = function () {
        try { return JSON.parse(node.value) } catch (error) { return BAD }
      }
      write = function (value) { node.value = JSON.stringify(value, null, 2) }
    }
    write(initial)
    var handler = function () {
      var value = read()
      onValue(value === BAD ? undefined : value, value === BAD ? 'JSON inválido' : '')
    }
    node.addEventListener('input', handler)
    node.addEventListener('change', handler)
    return { node: node, set: write }
  }

  // ---- A row of the list

  function buildRow(entry) {
    var path = entry.path
    var row = el('div', null, 'param')
    row.setAttribute('data-path', path)
    var head = el('div', null, 'head')
    var help = entry.help
    head.appendChild(el('h3', help ? help.title : path))
    if (help) { head.appendChild(el('span', path, 'path')) }
    var tipId = 'tip-' + path.split('.').join('-')
    var tipButton = el('button', '?', 'helptip')
    tipButton.type = 'button'
    tipButton.setAttribute('aria-label', 'Ajuda: ' + (help ? help.title : path))
    tipButton.setAttribute('aria-expanded', 'false')
    tipButton.setAttribute('aria-controls', tipId)
    head.appendChild(tipButton)
    var flags = help && help.flags ? help.flags : {}
    if (flags.legal) { head.appendChild(el('span', 'exige base legal', 'badge legal')) }
    else if (flags.attention) { head.appendChild(el('span', 'cuidado', 'badge attention')) }
    var changedBadge = el('span', 'alterado', 'badge changed')
    head.appendChild(changedBadge)
    row.appendChild(head)
    var tip = buildTip(entry, tipId)
    tipButton.addEventListener('click', function () {
      tip.hidden = !tip.hidden
      tipButton.setAttribute('aria-expanded', String(!tip.hidden))
    })
    row.appendChild(tip)

    var errorNode = el('div', '', 'error')
    var restore = el('button', 'Restaurar padrão')
    restore.type = 'button'
    var control = null
    if (entry.readOnly) {
      row.appendChild(el('p', 'Este valor guarda segredos ou tem edição própria: aparece só para leitura. Mude pela API.', 'muted'))
      row.appendChild(el('pre', short(valueOf(path)), 'mono'))
    } else {
      control = makeControl(entry, valueOf(path), function (value, problem) {
        var message = problem
        if (!message) { message = checkClient(entry, value) }
        if (message) { invalid[path] = message } else { delete invalid[path]; setDraft(path, value) }
        delete serverProblems[path]
        update()
      })
      control.node.className = 'control'
      control.node.disabled = !current.editable
      var holder = el('div', null, 'control')
      holder.appendChild(control.node)
      row.appendChild(holder)
    }
    row.appendChild(errorNode)
    var meta = el('div', null, 'meta')
    meta.appendChild(el('span', 'Padrão: ' + short(entry.default)))
    var allowed = el('span')
    richText(allowed, 'Valores: ' + entry.kindText)
    meta.appendChild(allowed)
    var origin = current.origins[path]
    if (origin && origin !== 'built-in') { meta.appendChild(el('span', 'vem de: ' + (origin === 'tenant' ? 'este tenant' : origin === 'plan' ? 'o plano' : 'os padrões do arquivo'))) }
    if (!entry.readOnly) { meta.appendChild(restore) }
    row.appendChild(meta)

    function update() {
      var changed = !same(draft[path], base[path]) || has(draft, path) !== has(base, path)
      row.className = 'param' + (changed ? ' changed' : '') + (invalid[path] || serverProblems[path] ? ' invalid' : '')
      changedBadge.hidden = !(changed || has(draft, path))
      changedBadge.textContent = changed ? 'alterado' : 'definido neste tenant'
      restore.hidden = !has(draft, path) || !current.editable
      errorNode.textContent = invalid[path] || serverProblems[path] || ''
      updateToolbar()
    }
    restore.addEventListener('click', function () {
      setDraft(path, current.inherited[path])
      delete invalid[path]
      delete serverProblems[path]
      if (control) { control.set(current.inherited[path]) }
      update()
    })
    update()
    rows[path] = { node: row, entry: entry, update: update, tip: tip, tipButton: tipButton }
    return row
  }

  // ---- The list, the search and the toolbar

  function matches(entry, text) {
    if (!text) { return true }
    var haystack = [entry.path, entry.description, entry.help ? entry.help.title : '', entry.help ? entry.help.summary : '']
    return haystack.join(' ').toLowerCase().indexOf(text) !== -1
  }

  function applyFilter() {
    var text = $('search').value.trim().toLowerCase()
    var only = $('onlyChanged').checked
    Array.prototype.forEach.call($('groups').querySelectorAll('details.group'), function (group) {
      var visible = 0
      Array.prototype.forEach.call(group.querySelectorAll('.param'), function (node) {
        var path = node.getAttribute('data-path')
        var show = matches(rows[path].entry, text) && (!only || has(draft, path) || has(base, path))
        node.hidden = !show
        if (show) { visible += 1 }
      })
      group.hidden = visible === 0
      if (text || only) { group.open = visible > 0 }
    })
  }

  function updateToolbar() {
    var count = changedPaths().length
    var bad = Object.keys(invalid).length
    $('count').textContent = count === 0 ? 'nenhuma mudança' : count + (count === 1 ? ' mudança' : ' mudanças') + (bad ? ', ' + bad + ' inválida(s)' : '')
    $('apply').disabled = !current || !current.editable || count === 0 || bad > 0
    $('discard').disabled = count === 0
  }

  function renderGroups() {
    rows = {}
    var host = $('groups')
    host.textContent = ''
    var order = []
    var groups = {}
    catalog.forEach(function (entry) {
      if (!groups[entry.group]) {
        groups[entry.group] = []
        order.push(entry.group)
      }
      groups[entry.group].push(entry)
    })
    order.forEach(function (name) {
      var details = el('details', null, 'group')
      var list = groups[name]
      details.appendChild(el('summary', list[0].groupTitle + ' (' + list.length + ')'))
      list.forEach(function (entry) { details.appendChild(buildRow(entry)) })
      host.appendChild(details)
    })
    applyFilter()
    updateToolbar()
  }

  // ---- A tenant

  function showSummary(view) {
    var box = $('summary')
    box.textContent = ''
    var tenant = view.tenant
    var title = el('h2', (tenant.name || tenant.id) + ' ')
    title.appendChild(el('span', tenant.id, 'mono'))
    box.appendChild(title)
    box.appendChild(el('p', 'Situação: ' + (tenant.status === 'suspended' ? 'suspenso' : 'ativo') + '. Plano: ' + (tenant.plan || 'nenhum') + '. Origem: ' + (tenant.source === 'database' ? 'banco de dados' : 'arquivo de configuração') + '.'))
    var key = el('p')
    key.appendChild(document.createTextNode('Chave pública: '))
    key.appendChild(el('span', tenant.publicKey, 'mono'))
    box.appendChild(key)
    if (!view.editable) {
      box.appendChild(el('p', 'Este tenant vem do arquivo de configuração e não pode ser editado aqui. Rode o comando import-tenants (copia o tenant para o banco com as mesmas chaves), tire "tenants" do arquivo e reinicie o servidor.', 'banner'))
      return
    }
    var form = el('form')
    var label = el('label', 'Origens permitidas (uma por linha)')
    var area = el('textarea')
    area.rows = 2
    area.value = tenant.allowedOrigins.join(newline)
    label.appendChild(area)
    form.appendChild(label)
    var save = el('button', 'Salvar origens')
    save.type = 'submit'
    form.appendChild(save)
    form.addEventListener('submit', function (event) {
      event.preventDefault()
      var origins = area.value.split(newline).map(function (line) { return line.trim() }).filter(function (line) { return line !== '' })
      status('Salvando origens...')
      api('/admin/v1/tenants/' + encodeURIComponent(tenant.id), { method: 'PATCH', body: JSON.stringify({ allowedOrigins: origins }) })
        .then(function () { loadTenant(tenant.id, 'Origens salvas.') })
        .catch(function (error) { status('Não salvou as origens: ' + error.message + (error.body && error.body.detail ? ' (' + error.body.detail + ')' : ''), true) })
    })
    box.appendChild(form)
  }

  function nest(flat) {
    var result = {}
    Object.keys(flat).forEach(function (path) {
      var parts = path.split('.')
      var node = result
      parts.slice(0, -1).forEach(function (part) {
        if (typeof node[part] !== 'object' || node[part] === null) { node[part] = {} }
        node = node[part]
      })
      node[parts[parts.length - 1]] = flat[path]
    })
    return result
  }

  function loadTenant(id, message) {
    status('Carregando...')
    api('/admin/v1/tenants/' + encodeURIComponent(id) + '/settings').then(function (view) {
      current = view
      current.tenantId = id
      base = {}
      draft = {}
      invalid = {}
      serverProblems = {}
      riskAcknowledged = false
      Object.keys(view.overrides).forEach(function (path) {
        if (byPath[path] && !byPath[path].readOnly) { base[path] = view.overrides[path]; draft[path] = view.overrides[path] }
      })
      $('tenant').hidden = false
      $('problems').hidden = true
      $('risk').hidden = true
      showSummary(view)
      renderGroups()
      Array.prototype.forEach.call($('tenants').querySelectorAll('button'), function (button) {
        button.setAttribute('aria-pressed', String(button.getAttribute('data-id') === id))
      })
      status(message || '')
    }).catch(function (error) { status(error.message, true) })
  }

  function showProblems(problems) {
    var box = $('problems')
    box.textContent = ''
    box.appendChild(el('strong', 'O servidor não aceitou esta configuração:'))
    var list = el('ul')
    problems.forEach(function (problem) {
      list.appendChild(el('li', problem))
      Object.keys(byPath).forEach(function (path) { if (problem.indexOf(path) !== -1) { serverProblems[path] = problem } })
    })
    box.appendChild(list)
    box.hidden = false
    Object.keys(rows).forEach(function (path) { rows[path].update() })
  }

  function save() {
    var changed = changedPaths()
    if (changed.length === 0) { return }
    var risky = changed.filter(function (path) {
      var help = byPath[path].help
      return help && help.flags && (help.flags.legal || help.flags.attention)
    })
    if (risky.length > 0 && !riskAcknowledged) {
      var box = $('risk')
      box.textContent = ''
      box.appendChild(el('strong', 'Confirme antes de aplicar:'))
      var list = el('ul')
      risky.forEach(function (path) {
        var help = byPath[path].help
        var li = el('li')
        li.appendChild(el('strong', help.title + ': '))
        richText(li, help.caution || (help.flags.legal ? 'Exige base legal ou parecer jurídico.' : 'Mudança fácil de lamentar.'))
        list.appendChild(li)
      })
      box.appendChild(list)
      var confirm = el('button', 'Entendi, aplicar mesmo assim', 'primary')
      confirm.type = 'button'
      confirm.addEventListener('click', function () { riskAcknowledged = true; box.hidden = true; save() })
      box.appendChild(confirm)
      box.hidden = false
      return
    }
    $('risk').hidden = true
    $('problems').hidden = true
    serverProblems = {}
    status('Aplicando...')
    var body = { settings: nest(draft), keepReadOnly: true }
    api('/admin/v1/tenants/' + encodeURIComponent(current.tenantId), { method: 'PATCH', body: JSON.stringify(body) })
      .then(function () {
        loadTenant(current.tenantId, 'Aplicado. Este servidor já usa os novos valores; outros servidores sobre o mesmo banco leem em até 1 minuto.')
      })
      .catch(function (error) {
        if (error.body && error.body.problems) { showProblems(error.body.problems); status('Corrija os campos marcados.', true) }
        else { status('Não aplicou: ' + error.message, true) }
      })
  }

  // ---- The list of tenants

  function renderTenants() {
    var list = $('tenants')
    list.textContent = ''
    tenants.forEach(function (tenant) {
      var li = el('li')
      var button = el('button', (tenant.name || tenant.id) + (tenant.status === 'suspended' ? ' (suspenso)' : ''))
      button.type = 'button'
      button.setAttribute('data-id', tenant.id)
      button.setAttribute('aria-pressed', 'false')
      button.addEventListener('click', function () { loadTenant(tenant.id) })
      li.appendChild(button)
      list.appendChild(li)
    })
  }

  function loadAll() {
    status('Carregando...')
    return Promise.all([api('/admin/v1/parameters'), api('/admin/v1/tenants')]).then(function (results) {
      catalog = results[0].parameters
      byPath = {}
      catalog.forEach(function (entry) { byPath[entry.path] = entry })
      var coverage = results[0].coverage
      $('coverage').textContent = 'Explicação completa: ' + coverage.documented + ' de ' + coverage.total + ' parâmetros.'
      tenants = results[1].tenants
      renderTenants()
      $('app').hidden = false
      status(tenants.length === 0 ? 'Nenhum tenant ainda. Crie o primeiro.' : '')
      if (tenants.length === 1) { loadTenant(tenants[0].id) }
    })
  }

  $('connect').addEventListener('submit', function (event) {
    event.preventDefault()
    adminKey = $('key').value.trim()
    $('key').value = ''
    if (adminKey.indexOf('adm_') !== 0) {
      adminKey = ''
      status('Isso não é uma chave de operador. Ela começa com adm_.', true)
      return
    }
    loadAll().catch(function (error) { adminKey = ''; $('app').hidden = true; status(error.message, true) })
  })

  $('search').addEventListener('input', applyFilter)
  $('onlyChanged').addEventListener('change', applyFilter)
  $('apply').addEventListener('click', save)
  $('discard').addEventListener('click', function () { if (current) { loadTenant(current.tenantId) } })
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') { return }
    Object.keys(rows).forEach(function (path) {
      if (!rows[path].tip.hidden) { rows[path].tip.hidden = true; rows[path].tipButton.setAttribute('aria-expanded', 'false') }
    })
  })

  $('newTenantButton').addEventListener('click', function () { $('newTenant').hidden = !$('newTenant').hidden })
  $('newTenant').addEventListener('submit', function (event) {
    event.preventDefault()
    var data = new FormData($('newTenant'))
    var body = { id: String(data.get('id') || '').trim() }
    var name = String(data.get('name') || '').trim()
    if (name) { body.name = name }
    body.allowedOrigins = String(data.get('origins') || '').split(newline).map(function (line) { return line.trim() }).filter(function (line) { return line !== '' })
    api('/admin/v1/tenants', { method: 'POST', body: JSON.stringify(body) }).then(function (result) {
      var box = $('created')
      box.textContent = ''
      box.appendChild(el('strong', 'Tenant criado. Guarde a chave secreta agora: ela não aparece de novo.'))
      var pk = el('p'); pk.appendChild(document.createTextNode('Chave pública: ')); pk.appendChild(el('span', result.tenant.publicKey, 'mono')); box.appendChild(pk)
      var sk = el('p'); sk.appendChild(document.createTextNode('Chave secreta: ')); sk.appendChild(el('span', result.secretKey, 'mono')); box.appendChild(sk)
      box.hidden = false
      $('newTenant').reset()
      $('newTenant').hidden = true
      return loadAll().then(function () { loadTenant(result.tenant.id) })
    }).catch(function (error) {
      status('Não criou: ' + error.message + (error.body && error.body.parameter ? ' (' + error.body.parameter + ')' : ''), true)
    })
  })
})()
`
