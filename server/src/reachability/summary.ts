import type { ReportReason } from './report'
import type { Count, NetworkCount, ReportStore } from './store'

/** The reasons that mean the visit did not reach the collector, as opposed to a refusal or a problem on the server */
export const unreachableReasons: readonly ReportReason[] = [
  'script_unreachable',
  'script_blocked',
  'script_broken',
  'request_unreachable',
  'request_blocked',
  'timeout',
]

const meanings: Record<ReportReason, string> = {
  ok: 'uma visita que funcionou (amostrada pelo carregador, se ele foi configurado para isso)',
  script_unreachable:
    'o script do coletor não carregou e o servidor não responde: a porta está bloqueada pela rede, ou o servidor caiu',
  script_blocked:
    'o script do coletor não carregou mas o servidor responde: bloqueador, política de conteúdo ou regra de caminho',
  script_broken: 'o script carregou mas não é o coletor: arquivo ou versão errada',
  request_unreachable: 'o script carregou mas o pedido não passou e o servidor não responde',
  request_blocked:
    'o script carregou mas o pedido falhou e o servidor responde: bloqueador, chave errada ou origem não permitida',
  timeout: 'o pedido demorou demais',
  server_refused: 'o servidor recusou (chave, origem, consentimento ou limite): problema de configuração',
  server_error: 'o servidor falhou (HTTP 5xx)',
  collect_error: 'o navegador falhou ao ler os sinais',
}

export interface Summary {
  days: number
  from: number
  to: number
  total: number
  byReason: Count[]
  byProbe: Count[]
  byBrowser: Count[]
  mobile: { mobile: number; desktop: number }
  byStatus: Count[]
  /** Reports per hour of the day, only of the visits that did not reach the collector */
  unreachableByHour: number[]
  utcOffsetHours: number
  unreachable: number
  /** The reports that were not a success */
  failures: number
  networks: NetworkCount[]
}

export function summarize(
  store: ReportStore,
  options: { days: number; now: number; utcOffsetHours: number; networks?: number },
): Summary {
  const since = options.now - options.days * 86_400_000
  const bad = reasonsOtherThanOk()
  return {
    days: options.days,
    from: since,
    to: options.now,
    total: store.count(since),
    byReason: store.countBy('reason', since),
    byProbe: store.countBy('probe', since, bad),
    byBrowser: store.countBy('browser', since, bad),
    mobile: store.countMobile(since, bad),
    byStatus: store.countBy('status', since, ['server_refused', 'server_error']),
    unreachableByHour: store.countByHour(since, options.utcOffsetHours, unreachableReasons),
    utcOffsetHours: options.utcOffsetHours,
    unreachable: store.count(since, unreachableReasons),
    failures: store.count(since, bad),
    networks: store.topNetworks(since, unreachableReasons, options.networks ?? 15),
  }
}

function reasonsOtherThanOk(): ReportReason[] {
  return [...unreachableReasons, 'server_refused', 'server_error', 'collect_error']
}

const percent = (part: number, whole: number): string => (whole === 0 ? '-' : `${((part / whole) * 100).toFixed(1)}%`)

function table(rows: Count[], total: number): string[] {
  return rows.length === 0
    ? ['  (nenhum)']
    : rows.map((row) => `  ${row.key.padEnd(22)} ${String(row.count).padStart(6)}  ${percent(row.count, total)}`)
}

/** The summary as text, in Portuguese, for the operator */
export function renderSummary(summary: Summary): string {
  const lines: string[] = []
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  lines.push(`Avisos de falha do coletor, de ${date(summary.from)} a ${date(summary.to)} (${summary.days} dias)`)
  lines.push('')
  lines.push(`Avisos recebidos: ${summary.total}`)
  lines.push(`Visitas que não chegaram ao coletor: ${summary.unreachable}`)
  lines.push(`Qualquer falha (inclui recusa e erro do servidor): ${summary.failures}`)
  lines.push('')
  lines.push('Por motivo:')
  lines.push(...table(summary.byReason, summary.total))
  lines.push('')
  lines.push('Sonda do servidor, nas falhas (reachable = a conexão funciona, unreachable = não funciona):')
  lines.push(...table(summary.byProbe, summary.failures))
  lines.push('')
  lines.push('Navegador, nas falhas:')
  lines.push(...table(summary.byBrowser, summary.failures))
  const phones = summary.mobile.mobile + summary.mobile.desktop
  lines.push(
    `  celular: ${summary.mobile.mobile} (${percent(summary.mobile.mobile, phones)}), computador: ${
      summary.mobile.desktop
    }`,
  )
  if (summary.byStatus.length > 0) {
    lines.push('')
    lines.push('Status HTTP das recusas e erros do servidor:')
    lines.push(
      ...table(
        summary.byStatus,
        summary.byStatus.reduce((sum, row) => sum + row.count, 0),
      ),
    )
  }
  lines.push('')
  const sign = summary.utcOffsetHours >= 0 ? '+' : ''
  lines.push(`Visitas que não chegaram ao coletor, por hora do dia (UTC${sign}${summary.utcOffsetHours}):`)
  const peak = Math.max(1, ...summary.unreachableByHour)
  summary.unreachableByHour.forEach((count, hour) => {
    lines.push(
      `  ${String(hour).padStart(2, '0')}h ${String(count).padStart(5)} ${'#'.repeat(Math.round((count / peak) * 30))}`,
    )
  })
  lines.push('')
  lines.push('Redes que mais aparecem entre as que não chegaram ao coletor:')
  if (summary.networks.length === 0) {
    lines.push('  (nenhuma)')
  }
  for (const network of summary.networks) {
    lines.push(
      `  ${network.label.padEnd(48)} ${String(network.reports).padStart(5)} avisos, ${network.prefixes} prefixos`,
    )
  }
  lines.push('')
  lines.push('Como ler:')
  lines.push('  - Os motivos são uma estimativa. A sonda só diz se a conexão com o servidor funciona naquele momento.')
  lines.push(
    '  - Um pico de "unreachable" em todas as redes ao mesmo tempo indica servidor fora do ar, não rede bloqueando.',
  )
  lines.push(
    '  - Muitos avisos de uma rede só e de poucos prefixos podem ser um visitante insistente, não a rede toda.',
  )
  lines.push('  - Para saber a fração de visitantes afetados, divida pelos cadastros do seu app no mesmo período.')
  lines.push('  - Quem fecha a página antes do aviso, ou bloqueia o próprio carregador, não aparece aqui.')
  lines.push('')
  lines.push('O que cada motivo quer dizer:')
  for (const row of summary.byReason) {
    const meaning = meanings[row.key as ReportReason]
    if (meaning) {
      lines.push(`  ${row.key}: ${meaning}`)
    }
  }
  return `${lines.join('\n')}\n`
}
