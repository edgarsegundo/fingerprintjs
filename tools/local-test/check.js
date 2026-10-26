#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Shows the latest visits that the local test server stored, in plain words, and the detail of one of them. It reads
 * the secret key that `setup.js` saved, so nothing has to be copied.
 *
 *   node tools/local-test/check.js        the list, and the detail of the newest visit
 *   node tools/local-test/check.js 2      the list, and the detail of visit #2 of the list
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const api = process.env.FP_LOCAL_API || 'http://127.0.0.1:8080'
const keysFile = process.env.FP_LOCAL_KEYS || join(__dirname, '..', '..', 'server', 'data', 'local-test-keys.json')

async function get(path, secretKey) {
  const response = await fetch(api + path, { headers: { Authorization: 'Bearer ' + secretKey } })
  if (!response.ok) {
    throw new Error('O servidor respondeu ' + response.status + ' para ' + path)
  }
  return response.json()
}

/** Reads the keys that `setup.js` saved */
function readKeys() {
  try {
    return JSON.parse(readFileSync(keysFile, 'utf8'))
  } catch {
    throw new Error('Não achei as chaves. Rode antes: node tools/local-test/setup.js')
  }
}

const tamperText = (t) =>
  t.high + t.medium + t.low === 0 ? 'nenhuma' : `ALTA ${t.high}, média ${t.medium}, baixa ${t.low}`

/**
 * What the server has stored, ready to print or to check. `list` is the newest first; `letters` names the devices in
 * the order they were first seen, oldest first, so that "A" stays "A". `chosen` and `event` are visit #wanted.
 */
async function fetchState(wanted = 1) {
  const keys = readKeys()
  let list
  try {
    list = (await get('/v1/events?limit=50', keys.secretKey)).events
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Não consegui falar com o servidor em ' + api + '. Ele está rodando?')
    }
    throw error
  }
  const letters = new Map()
  for (const visit of [...list].reverse()) {
    if (!letters.has(visit.visitorId)) {
      letters.set(visit.visitorId, String.fromCharCode(65 + letters.size))
    }
  }
  const chosen = list[wanted - 1]
  const event = chosen ? await get('/v1/events/' + chosen.requestId, keys.secretKey) : undefined
  const stored = event && event.payload.extended.storedId && event.payload.extended.storedId.value
  return { list, letters, chosen, event, stored, wanted }
}

/** Prints the state in plain words */
function render(state) {
  const { list, letters, chosen, event, stored, wanted } = state
  if (list.length === 0) {
    console.log('Ainda não há nenhuma visita. Envie uma pela página de teste e rode de novo.')
    return
  }
  console.log('Visitas guardadas (a mais nova primeiro):')
  list.slice(0, 10).forEach((visit, index) => {
    const status = visit.matched ? 'RECONHECIDO' : 'NOVO       '
    console.log(
      `  #${index + 1}  aparelho ${letters.get(visit.visitorId)}  ${status}  adulteração: ${tamperText(
        visit.tamper,
      )}  ` + `(${visit.requestId.slice(0, 8)})`,
    )
  })
  console.log(`Aparelhos diferentes: ${letters.size} (${[...letters.values()].sort().join(', ')})`)
  if (!chosen || !event) {
    console.log(`\nNão existe a visita #${wanted} na lista.`)
    return
  }
  const identity = event.identity
  console.log(`\nDetalhe da visita #${wanted}:`)
  console.log(`  aparelho: ${letters.get(chosen.visitorId)} (${identity.visitorId})`)
  console.log(`  reconhecido: ${identity.matched ? 'sim' : 'não, é um aparelho novo para o servidor'}`)
  if (identity.explanation.length === 0) {
    console.log('  motivos: nenhum aparelho conhecido para comparar')
  } else {
    console.log('  motivos (peso maior = pesou mais; agree bate com o aparelho conhecido, disagree não bate):')
    for (const item of identity.explanation.slice(0, 5)) {
      console.log(`    ${item.outcome.padEnd(8)} ${item.feature.padEnd(18)} ${item.weight.toFixed(1)}`)
    }
  }
  if (!stored) {
    console.log('  código guardado: não enviado nesta visita')
  } else {
    const where = stored.foundIn.length > 0 ? 'achado em ' + stored.foundIn.join(', ') : 'nenhum lugar tinha'
    console.log(`  código guardado: ${stored.created ? 'CRIADO agora' : 'já existia'} (${where})`)
  }
  if (event.tamper.signals.length > 0) {
    console.log('  adulteração encontrada (evidência, não prova):')
    for (const signal of event.tamper.signals) {
      console.log(`    ${signal.severity.padEnd(6)} ${signal.id}: ${signal.detail}`)
    }
    if (event.tamper.signals.some((s) => s.severity === 'high')) {
      console.log(
        '  ATENÇÃO: com a configuração padrão, uma visita com evidência ALTA não ensina o motor, e por isso\n' +
          '  não seria reconhecida na próxima. Neste teste o tenant foi configurado para ensinar mesmo assim.',
      )
    }
  }
}

module.exports = { fetchState, render, readKeys, api }

if (require.main === module) {
  fetchState(Number(process.argv[2] || 1))
    .then(render)
    .catch((error) => {
      console.error(error.message)
      process.exit(1)
    })
}
