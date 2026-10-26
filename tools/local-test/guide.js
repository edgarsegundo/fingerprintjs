#!/usr/bin/env node
/* eslint-disable no-console, max-len -- the text is prose for the person who follows the guide, kept one line each */
/**
 * A guide for the local test, in one terminal. It explains each step, asks before it does anything, starts the server
 * and the test page for you, tells you what to click in the browser, and then reads what the server stored and says
 * whether it is what it should be. The secret key is read from the file that `setup.js` made: nothing is copied by hand.
 *
 *   node tools/local-test/guide.js
 *
 * Answers: Enter or s = go on, n = skip this step, q = quit (the servers it started are stopped).
 */
const { spawn, spawnSync } = require('node:child_process')
const { existsSync, rmSync } = require('node:fs')
const net = require('node:net')
const { join } = require('node:path')
const readline = require('node:readline')

const root = join(__dirname, '..', '..')
// Folder and ports can be changed for a separate run (used to test the guide itself, beside a test that is running)
const dataDir = process.env.FP_LOCAL_DATA || join(root, 'server', 'data')
const apiPort = Number(process.env.FP_LOCAL_PORT || 8080)
const pagePort = Number(process.env.FP_LOCAL_PAGE_PORT || 8081)
process.env.FP_LOCAL_API = `http://127.0.0.1:${apiPort}`
process.env.FP_LOCAL_KEYS = join(dataDir, 'local-test-keys.json')

const { fetchState, render, readKeys, api } = require('./check')
// Only for testing the guide itself: visits are sent by the script instead of by a person in a browser
const simulate = process.env.FP_GUIDE_SIMULATE === '1'
const autoYes = process.env.FP_GUIDE_YES === '1'

const bold = (text) => `\u001b[1m${text}\u001b[0m`
const dim = (text) => `\u001b[2m${text}\u001b[0m`
const green = (text) => `\u001b[32m${text}\u001b[0m`
const yellow = (text) => `\u001b[33m${text}\u001b[0m`
const red = (text) => `\u001b[31m${text}\u001b[0m`

const children = []
// The question is the prompt of the interface: written any other way, the terminal can erase it when it redraws the line
const lines = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' })
const pending = []
// Lines typed before the guide asks (a fast typist, or a pasted block) wait here instead of being lost
const typed = []
let closed = false
lines.on('line', (line) => {
  const waiting = pending.shift()
  waiting ? waiting(line) : typed.push(line)
})
lines.on('close', () => {
  closed = true
  while (pending.length > 0) {
    pending.shift()?.('')
  }
})

function ask(question) {
  if (autoYes) {
    console.log(`${question} ${dim('(s)')}`)
    return Promise.resolve('s')
  }
  lines.setPrompt(question + ' ')
  lines.prompt()
  if (typed.length > 0) {
    return Promise.resolve(typed.shift() ?? '')
  }
  if (closed) {
    return Promise.resolve('q')
  }
  return new Promise((resolve) => pending.push(resolve))
}

function stop() {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM')
  }
}

async function quit(code = 0) {
  stop()
  lines.close()
  process.exit(code)
}
process.on('SIGINT', () => quit(0))

/** `true` to go on, `false` to skip the step. `q` ends the guide. */
async function confirm(question = 'Posso executar este passo? [Enter = sim, n = pular, q = sair]') {
  const answer = (await ask(question)).trim().toLowerCase()
  if (answer === 'q') {
    console.log('\nSaindo. Os servidores que o guia iniciou foram parados.')
    await quit(0)
  }
  return !(answer === 'n' || answer === 'não' || answer === 'nao')
}

async function wait(message = 'Quando terminar, aperte Enter.') {
  if (simulate) {
    return
  }
  const answer = (await ask(message)).trim().toLowerCase()
  if (answer === 'q') {
    await quit(0)
  }
}

let stepNumber = 0
function title(_number, text) {
  stepNumber++
  console.log('\n' + bold(`=== Passo ${stepNumber}: ${text} ===`))
}
const say = (text) => console.log(text)
const ok = (text) => console.log(green('  OK  ') + text)
const warn = (text) => console.log(yellow('  ATENÇÃO  ') + text)

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

async function until(check, ms = 20000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

function run(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status === 0
}

function pageAddress() {
  return `http://127.0.0.1:${pagePort}/tools/local-test/index.html?k=${readKeys().publicKey}`
}

/** Opens the address in an application, on a Mac. Elsewhere the person pastes it. */
function openIn(application, address) {
  if (process.platform !== 'darwin' || simulate) {
    return false
  }
  return spawnSync('open', ['-a', application, address]).status === 0
}

// ---------------------------------------------------------------------------------------------------------------------
// What a visit from a browser looks like, for the guide's own test (FP_GUIDE_SIMULATE=1)

async function simulatedVisit({ device, token, found, withCode }) {
  const signal = (value) => ({ value, duration: 1 })
  const key = readKeys().publicKey
  const { nonce } = await (await fetch(`${api}/v1/nonce?k=${key}`)).json()
  const body = {
    schema: 1,
    libVersion: '5.3.0',
    collectedAt: Date.now(),
    durationMs: 1,
    nonce,
    linkedId: 'teste',
    components: {
      canvas: signal({ winding: true, geometry: 'g' + device, text: 't' }),
      webGlBasics: signal({ rendererUnmasked: 'gpu' + device, vendorUnmasked: 'v', renderer: 'r', vendor: 'v' }),
      fonts: signal(['f1-' + device, 'f2']),
      screenResolution: signal([1440, 900]),
      platform: signal('MacIntel'),
      timezone: signal('America/Sao_Paulo'),
      hardwareConcurrency: signal(8),
      deviceMemory: signal(8),
    },
    extended: withCode ? { storedId: signal({ token, foundIn: found, created: found.length === 0 }) } : {},
    ...(withCode ? { consent: { basis: 'legitimate_interest', version: 'guide' } } : {}),
  }
  const response = await fetch(`${api}/v1/collect?k=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error('A visita simulada foi recusada: ' + response.status)
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/** How to clear what ONE site stored, in each browser, without touching history, passwords or autofill */
function sayHowToClearSite(which) {
  const chrome = [
    'No Chrome (só este site):',
    `  1. Abra a página de teste: ${pageAddress()}`,
    '  2. Clique no ícone à esquerda da barra de endereço (o de configurações do site).',
    '  3. Clique em "Configurações do site" (ou "Cookies e dados do site").',
    '  4. Clique em "Limpar dados" (ou "Excluir dados"). Isso apaga só o que 127.0.0.1 gravou.',
    dim('  Alternativa: com a página aberta, F12 > aba Application > Storage > Clear site data.'),
  ]
  const firefox = [
    'No Firefox (só este site):',
    `  1. Abra a página de teste: ${pageAddress()}`,
    '  2. Clique no cadeado (ou no ícone) à esquerda da barra de endereço.',
    '  3. Clique em "Limpar cookies e dados do site".',
  ]
  const text = which === 'chrome' ? chrome : [...chrome, '', ...firefox]
  say('')
  text.forEach((line) => say(line))
  say(dim('\nIsso apaga só os dados de 127.0.0.1. Histórico, senhas e preenchimento automático ficam intactos.'))
}

// Set when the old data was wiped: the browsers may still hold the old stored code, to be cleared once the page is up
let browsersNeedCleaning = false

async function prepare() {
  say(bold('\nGuia do teste local'))
  say(
    'Este guia roda o servidor e a página de teste para você, diz o que clicar no navegador e confere o resultado.\n' +
      'Tudo roda na sua máquina, com SQLite. Nada sai dela.\n' +
      dim('Respostas: Enter = sim, n = pular o passo, q = sair.'),
  )

  title(1, 'Conferir o ambiente')
  say(
    'O que é: confere se você tem o que o teste precisa: Node 22 ou mais novo, Python 3 (serve a página de teste)\n' +
      'e os programas já compilados (o servidor em server/dist e o script do navegador em dist).\n' +
      'Por que importa: sem isso o servidor nem sobe, e o erro que apareceria depois seria confuso.',
  )
  if (!(await confirm())) {
    return false
  }
  const major = Number(process.versions.node.split('.')[0])
  major >= 22 ? ok(`Node ${process.versions.node}`) : warn(`Node ${process.versions.node}: precisa do 22 ou mais novo`)
  const python = spawnSync('python3', ['--version'])
  python.status === 0 ? ok(String(python.stdout || python.stderr).trim()) : warn('python3 não encontrado')
  const built = existsSync(join(root, 'server', 'dist', 'main.js')) && existsSync(join(root, 'dist', 'fp.min.js'))
  if (built) {
    ok('Os programas já estão compilados.')
  } else {
    warn('Faltam os programas compilados (server/dist ou dist).')
    say('Posso rodar: yarn install, yarn build e yarn server:build. Leva alguns minutos.')
    if (await confirm('Compilar agora? [Enter = sim, n = não]')) {
      const yarn = ['--yes', 'yarn@1.22.22']
      const done =
        run('npx', [...yarn, 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-engines']) &&
        run('npx', [...yarn, 'build']) &&
        run('npx', [...yarn, 'server:build'])
      if (!done) {
        console.log(red('A compilação falhou. Veja a mensagem acima.'))
        return false
      }
    } else {
      return false
    }
  }
  for (const port of [apiPort, pagePort]) {
    if (await listening(port)) {
      console.log(
        red(`A porta ${port} já está em uso (talvez um servidor deste teste ainda rodando em outro terminal).`) +
          `\nPare esse programa (Ctrl+C no terminal dele) ou rode: kill $(lsof -tiTCP:${port} -sTCP:LISTEN)`,
      )
      return false
    }
  }

  if (existsSync(join(dataDir, 'local-test.db'))) {
    title(2, 'Dados de testes anteriores')
    say(
      'O que é: já existe um banco de testes (server/data) com visitas de uma rodada anterior.\n' +
        'Por que importa: as visitas antigas aparecem na lista e o navegador pode ainda ter o código guardado de antes.\n' +
        'Para seguir o guia com resultados limpos, o melhor é recomeçar do zero.',
    )
    const answer = (await ask('Apagar server/data e recomeçar? [s = apagar, Enter = manter]')).trim().toLowerCase()
    if (answer === 's') {
      rmSync(dataDir, { recursive: true, force: true })
      ok('Apagado.')
      warn('Falta limpar o código guardado de antes nos navegadores (Chrome e Firefox), senão ele volta.')
      say(
        'Isso só pode ser feito com a página de teste aberta no navegador. Eu peço logo depois de ligar a página\n' +
          '(daqui a dois passos), com o endereço certo.',
      )
      browsersNeedCleaning = true
    }
  }

  title(3, 'Criar o tenant de teste')
  say(
    'O que é: um "tenant" é um cliente do servidor, com uma chave pública (vai na página) e uma chave secreta (lê os\n' +
      'resultados). Este passo cria os dois e escreve server/data/config.json, com o código guardado ligado.\n' +
      'Por que importa: sem tenant o servidor recusa toda visita. A chave secreta fica salva em um arquivo local,\n' +
      'e o guia a usa sozinho para consultar o servidor: você não precisa copiar nada.\n' +
      dim(
        'Exemplo do que aparece: Public key: pk_..., Secret key: sk_..., Test page: http://127.0.0.1:' +
          pagePort +
          '/...',
      ),
  )
  if (!(await confirm())) {
    return false
  }
  if (!run('node', ['tools/local-test/setup.js'])) {
    return false
  }

  title(4, 'Ligar o servidor')
  say(
    `O que é: o servidor de identificação, na porta ${apiPort}. Ele recebe as visitas que a página manda, guarda tudo e decide\n` +
      'se o navegador já era conhecido.\n' +
      'Por que importa: é o coração do sistema. O guia o liga em segundo plano e o desliga quando você sair.\n' +
      dim(`Exemplo do que aparece: "route":"started","port":${apiPort}`),
  )
  if (!(await confirm())) {
    return false
  }
  const server = spawn('node', ['server/dist/main.js', join(dataDir, 'config.json')], { cwd: root, stdio: 'ignore' })
  children.push(server)
  if (!(await until(() => fetch(`${api}/healthz`).then((r) => r.ok)))) {
    console.log(red('O servidor não subiu em 20 segundos. Rode à mão para ver o erro:'))
    console.log('  node server/dist/main.js server/data/config.json')
    return false
  }
  ok(`Servidor no ar em ${api}`)

  title(5, 'Ligar a página de teste')
  say(
    `O que é: um servidor de arquivos simples (Python), na porta ${pagePort}, que entrega a página com o botão "Send a visit".\n` +
      'Por que importa: o navegador precisa abrir a página por http://. É essa página que manda as visitas ao servidor.\n' +
      dim(`Exemplo de endereço: http://127.0.0.1:${pagePort}/tools/local-test/index.html?k=pk_...`),
  )
  if (!(await confirm())) {
    return false
  }
  const page = spawn('python3', ['-m', 'http.server', String(pagePort), '--bind', '127.0.0.1'], {
    cwd: root,
    stdio: 'ignore',
  })
  children.push(page)
  if (!(await until(() => fetch(pageAddress()).then((r) => r.ok)))) {
    console.log(red('A página de teste não subiu.'))
    return false
  }
  ok('Página de teste no ar.')
  say(`\n  Endereço da página: ${bold(pageAddress())}`)
  if (browsersNeedCleaning) {
    say(
      bold('\nAgora a limpeza dos navegadores.') +
        '\nComo você apagou os dados antigos, o Chrome e o Firefox ainda podem ter o código guardado de antes.\n' +
        'Se não limpar, a primeira visita sairia como "reconhecida" em vez de "nova".',
    )
    sayHowToClearSite('both')
    say(dim('\nSe você nunca abriu a página de teste em um dos navegadores, pode pular a limpeza dele.'))
    await wait('\nQuando terminar, aperte Enter.')
  }
  return true
}

/**
 * One visit in a browser: say what to do, wait, then read what the server stored and say whether it is as it should be.
 * `check(before, after)` returns the lines to print: [kind, text] with kind 'ok' or 'warn'.
 */
// What the server had after the last visit step
let lastState

async function visitStep(number, heading, explain, instructions, options) {
  title(number, heading)
  say(explain)
  if (!(await confirm('Quer fazer este passo agora? [Enter = sim, n = pular, q = sair]'))) {
    return
  }
  // The count is taken from the end of the previous visit, so that a click made while reading is not missed
  const before = lastState || (await fetchState())
  say('\nO que fazer:')
  instructions.forEach((line, index) => say(`  ${index + 1}. ${line.replace('{{PAGE}}', bold(pageAddress()))}`))
  say(
    dim(
      '  Se a página mostrar "Failed:", a aba é de uma rodada anterior (a chave dela não vale mais). Abra de novo o endereço:\n' +
        `  ${pageAddress()}`,
    ),
  )
  if (options.application) {
    say('')
    if (await confirm(`Abrir a página no ${options.application} para você? [Enter = sim, n = eu abro]`)) {
      if (!openIn(options.application, pageAddress())) {
        say(`Não consegui abrir sozinho. Cole este endereço no ${options.application}:\n  ${pageAddress()}`)
      }
    } else {
      say(`Cole este endereço no ${options.application}:\n  ${pageAddress()}`)
    }
  }
  if (simulate) {
    await simulatedVisit(options.simulated)
  } else {
    await wait('\nQuando tiver clicado e visto "Visit ... sent" na página, volte para ESTE terminal e aperte Enter.')
  }
  let after = await fetchState()
  // No visit arrived: say so, and let the person try again instead of judging an old visit as if it were the new one
  while (!simulate && after.list.length - before.list.length < 1) {
    warn('Nenhuma visita nova chegou ao servidor. O que aparece abaixo é a visita ANTERIOR, não a deste passo.')
    say(
      'Possíveis causas: o clique não foi dado, a página mostrou "Failed:", ou você apertou Enter antes de clicar.\n' +
        `Endereço da página, se precisar abrir de novo:\n  ${bold(pageAddress())}`,
    )
    const again = (
      await ask(
        'Quer tentar de novo agora? Clique em "Send a visit" e responda. [Enter = tentar de novo, n = seguir assim]',
      )
    )
      .trim()
      .toLowerCase()
    if (again === 'n') {
      lastState = after
      return
    }
    if (again === 'q') {
      await quit(0)
    }
    after = await fetchState()
  }
  lastState = after
  say('\nO que o servidor guardou:')
  render(after)
  say('')
  const added = after.list.length - before.list.length
  if (added > 1) {
    warn(`Esperava 1 visita nova e vieram ${added}. Clicou mais de uma vez? O resultado abaixo é o da mais nova.`)
  }
  for (const [kind, text] of options.check(before, after)) {
    kind === 'ok' ? ok(text) : warn(text)
  }
  if (options.why) {
    say(dim('\nPor que isso importa: ' + options.why))
  }
}

const newest = (state) => state.list[0]
const sameDevice = (a, b) => a && b && a.visitorId === b.visitorId
const topReason = (state) =>
  state.event && state.event.identity.explanation[0] && state.event.identity.explanation[0].feature

async function tests() {
  say(bold('\nAgora os testes. Em cada um, você faz uma coisa no navegador e o guia confere o resultado.'))
  say(
    '\n' +
      bold('Regra de ouro: só clique em "Send a visit" quando o guia mandar, e UMA vez por passo.') +
      '\nCada clique é uma visita que o servidor guarda. Cliques a mais (ou antes da hora) misturam os resultados e o guia\n' +
      'avisa "Esperava NOVO" ou "Esperava 1 visita nova". Se isso acontecer, o teste continua valendo, mas os avisos do\n' +
      'passo ficam confusos.',
  )

  await visitStep(
    6,
    'Primeira visita (Chrome)',
    'O que é: a primeira vez que o servidor vê o seu Chrome.\n' +
      'O que esperar: o servidor não conhece esse navegador, então o chama de "aparelho A" e diz NOVO. O navegador\n' +
      'também cria o "código guardado" (um código aleatório que ele passa a lembrar).',
    [
      'No Chrome, em janela normal, abra o endereço da página de teste: {{PAGE}}',
      'Marque a caixa "Use the code stored in the browser".',
      'Clique UMA vez em "Send a visit". Deve aparecer "Visit 1 sent".',
    ],
    {
      application: 'Google Chrome',
      simulated: { device: 1, token: 'AbCdEfGhIjKlMnOpQrStUv', found: [], withCode: true },
      check: (_before, after) => [
        newest(after) && !newest(after).matched
          ? ['ok', 'Aparelho novo, como esperado.']
          : ['warn', 'Esperava NOVO. Havia visitas antigas?'],
        after.stored && after.stored.created
          ? ['ok', 'O navegador criou o código guardado.']
          : ['warn', 'Esperava "CRIADO agora". A caixa estava marcada?'],
      ],
      why: 'Sem nenhuma visita anterior, o servidor não tem com o que comparar. É sempre assim na primeira vez.',
    },
  )

  let afterFirst = await fetchState()

  await visitStep(
    7,
    'Segunda visita, na mesma aba (Chrome)',
    'O que é: o mesmo navegador volta.\n' +
      'O que esperar: o servidor reconhece o aparelho A. O motivo principal é o código guardado (storedId), que é o sinal\n' +
      'mais forte que o motor tem: um código aleatório que só esse navegador carrega.',
    [
      'Volte para a aba do Chrome onde você enviou a primeira visita. Deixe a aba como está: NÃO recarregue (não aperte F5).',
      'Confira que a caixa "Use the code stored in the browser" continua marcada.',
      'Clique UMA vez em "Send a visit". O quadro cinza muda para "Visit 2 sent." com outro requestId.',
      'Volte para ESTE terminal e aperte Enter.',
    ],
    {
      simulated: {
        device: 1,
        token: 'AbCdEfGhIjKlMnOpQrStUv',
        found: ['cookie', 'localStorage', 'indexedDB'],
        withCode: true,
      },
      check: (_before, after) => [
        newest(after).matched ? ['ok', 'Reconhecido, como esperado.'] : ['warn', 'Esperava RECONHECIDO.'],
        sameDevice(newest(after), afterFirst.list[0])
          ? ['ok', 'É o mesmo aparelho da primeira visita.']
          : ['warn', 'Veio como outro aparelho.'],
        topReason(after) === 'storedId'
          ? ['ok', 'O motivo principal é o código guardado (storedId).']
          : [
              'warn',
              `O motivo principal foi ${topReason(after) || 'nenhum (nada para comparar)'}, não o código guardado.`,
            ],
      ],
      why: 'É o ganho do código guardado: reconhecer o navegador mesmo que outros sinais mudem (uma atualização, por exemplo).',
    },
  )
  afterFirst = await fetchState()

  await visitStep(
    8,
    'Aba nova do mesmo Chrome',
    'O que é: outra aba do mesmo navegador.\n' +
      'O que esperar: continua o aparelho A. O código guardado vale para o navegador inteiro, não para a aba.',
    [
      'No mesmo Chrome, abra uma ABA NOVA e cole este endereço: {{PAGE}}',
      'Marque a caixa e clique UMA vez em "Send a visit".',
    ],
    {
      simulated: {
        device: 1,
        token: 'AbCdEfGhIjKlMnOpQrStUv',
        found: ['cookie', 'localStorage', 'indexedDB'],
        withCode: true,
      },
      check: (_before, after) => [
        newest(after).matched && sameDevice(newest(after), afterFirst.list[0])
          ? ['ok', 'Reconhecido como o mesmo aparelho A, como esperado.']
          : ['warn', 'Esperava o mesmo aparelho A, reconhecido.'],
      ],
    },
  )
  const chromeDevice = (await fetchState()).list[0].visitorId

  await visitStep(
    9,
    'Outro navegador, o mesmo computador (Firefox)',
    'O que é: o Firefox no mesmo computador.\n' +
      'O que esperar: um aparelho DIFERENTE, "aparelho B", e NOVO. O Firefox tem outro código guardado e outros sinais\n' +
      '(placa de vídeo, fontes, etc.), e o servidor não deve confundir os dois.',
    [
      'Abra o Firefox em janela normal e cole este endereço (use exatamente 127.0.0.1, nunca localhost): {{PAGE}}',
      'Marque a caixa e clique UMA vez em "Send a visit".',
    ],
    {
      application: 'Firefox',
      simulated: { device: 2, token: 'ZyXwVuTsRqPoNmLkJiHgFe', found: [], withCode: true },
      check: (_before, after) => [
        newest(after).visitorId !== chromeDevice && !newest(after).matched
          ? ['ok', 'Aparelho diferente e novo, como esperado.']
          : ['warn', 'Esperava um aparelho novo, diferente do Chrome.'],
      ],
      why: 'Mostra que o sistema não junta dois navegadores só porque estão no mesmo computador.',
    },
  )
  const firefoxDevice = (await fetchState()).list[0].visitorId

  await visitStep(
    10,
    'Segunda visita no Firefox',
    'O que é: o Firefox volta.\nO que esperar: o servidor o reconhece como o aparelho B.',
    ['No Firefox, clique UMA vez em "Send a visit" (caixa marcada).'],
    {
      simulated: {
        device: 2,
        token: 'ZyXwVuTsRqPoNmLkJiHgFe',
        found: ['cookie', 'localStorage', 'indexedDB'],
        withCode: true,
      },
      check: (_before, after) => [
        newest(after).matched && newest(after).visitorId === firefoxDevice
          ? ['ok', 'Reconhecido como o aparelho B, como esperado.']
          : ['warn', 'Esperava o aparelho B, reconhecido.'],
      ],
    },
  )

  title(11, 'Apagar os dados do site no Chrome')
  say(
    'O que é: tirar do Chrome o código guardado.\n' +
      'Por que importa: o próximo passo mostra o que acontece quando o servidor perde esse sinal e precisa reconhecer o\n' +
      'navegador só pelos outros (placa de vídeo, fontes, tela...).',
  )
  if (await confirm('Quer fazer este passo agora? [Enter = sim, n = pular, q = sair]')) {
    sayHowToClearSite('chrome')
    await wait('\nQuando terminar, aperte Enter.')
  }

  await visitStep(
    12,
    'Visita do Chrome sem o código guardado',
    'O que é: o mesmo Chrome, agora sem o código antigo.\n' +
      'O que esperar: o navegador cria um código novo (CRIADO agora). O servidor provavelmente ainda reconhece o Chrome\n' +
      'como o aparelho A, só que pelos outros sinais. Também é válido vir como aparelho novo: com poucos aparelhos\n' +
      'conhecidos, os outros sinais podem não bastar para a certeza exigida (0,99).',
    [
      'No Chrome, recarregue a página de teste (F5), ou abra de novo: {{PAGE}}',
      'Marque a caixa e clique UMA vez em "Send a visit".',
    ],
    {
      simulated: { device: 1, token: 'QwErTyUiOpAsDfGhJkLzXc', found: [], withCode: true },
      check: (_before, after) => [
        after.stored && after.stored.created
          ? ['ok', 'O navegador criou um código novo, como esperado.']
          : ['warn', 'Esperava "CRIADO agora". Os dados do site foram apagados?'],
        newest(after).matched && sameDevice(newest(after), { visitorId: chromeDevice })
          ? ['ok', 'Reconhecido como o aparelho A pelos outros sinais (resultado provável).']
          : ['ok', 'Veio como aparelho novo ou outro: também é um resultado válido (veja a explicação acima).'],
      ],
      why: 'Mostra o limite do sistema: o código guardado ajuda muito, mas o navegador pode perdê-lo, e aí contam os outros sinais.',
    },
  )

  await visitStep(
    13,
    'Visita sem marcar a caixa',
    'O que é: a página não declara base legal para o código guardado.\n' +
      'O que esperar: o navegador nem lê nem envia o código. Isso é a proteção de privacidade: o código só é usado se a\n' +
      'página disser que o visitante concordou ou que o uso é para prevenção a fraude.',
    ['Na página de teste (se precisar, o endereço é {{PAGE}}), DESMARQUE a caixa e clique UMA vez em "Send a visit".'],
    {
      simulated: { device: 1, token: 'QwErTyUiOpAsDfGhJkLzXc', found: [], withCode: false },
      check: (_before, after) => [
        !after.stored
          ? ['ok', 'Nenhum código foi enviado, como esperado.']
          : ['warn', 'O código foi enviado. A caixa estava desmarcada?'],
      ],
      why: 'É a trava de privacidade do código guardado: sem base legal declarada, ele não é gravado nem lido.',
    },
  )
}

async function main() {
  const ready = await prepare()
  if (!ready) {
    console.log('\nO guia parou antes dos testes. Rode de novo quando quiser.')
    return quit(0)
  }
  await tests()
  say(bold('\n=== Fim ==='))
  say(
    'Resumo do que você viu:\n' +
      '  - Primeira visita: aparelho novo.\n' +
      '  - Mesmo navegador (mesma aba ou outra): reconhecido, pelo código guardado.\n' +
      '  - Outro navegador no mesmo computador: aparelho diferente.\n' +
      '  - Sem o código guardado: o servidor tenta pelos outros sinais.\n' +
      '  - Sem base legal declarada: o código não é usado.\n' +
      dim('\nNada disso mede acerto: os parâmetros do motor são provisórios (calibrated: false).'),
  )
  say('\nPara ver a lista a qualquer momento, com o servidor ligado: node tools/local-test/check.js')
  if (
    !simulate &&
    (await confirm('\nDesligar o servidor e a página agora? [Enter = sim, n = deixar ligados até Ctrl+C]'))
  ) {
    return quit(0)
  }
  if (simulate) {
    return quit(0)
  }
  say('Servidor e página continuam ligados. Aperte Ctrl+C para desligar.')
  await new Promise(() => undefined)
}

main().catch((error) => {
  console.error(red('\nErro: ' + (error && error.message ? error.message : error)))
  quit(1)
})
