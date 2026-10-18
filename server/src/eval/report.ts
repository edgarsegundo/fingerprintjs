import { browserOf } from './browser'
import { Dataset, DatasetMeta, EvalEvent } from './dataset'
import { legacyVisitorId } from './legacy'
import { buildPairs, Pair, PairOptions } from './pairs'
import { Scorer } from './scorers'
import {
  auc,
  ClusterOutcome,
  clusterInterval,
  equalErrorRate,
  Interval,
  operatingPointAtFmr,
  rocCurve,
  ruleOfThree,
  shannonEntropyBits,
  wilson,
} from './stats'

const day = 24 * 60 * 60 * 1000

const gapBuckets = [
  { label: 'menos de 1 hora', max: 60 * 60 * 1000 },
  { label: '1 hora a 1 dia', max: day },
  { label: '1 a 7 dias', max: 7 * day },
  { label: '7 a 30 dias', max: 30 * day },
  { label: 'mais de 30 dias', max: Number.POSITIVE_INFINITY },
]

export interface ScorerReport {
  name: string
  description: string
  threshold: number
  positives: number
  negatives: number
  /** The same device called different */
  fnmr: Interval
  /** Different devices called the same */
  fmr: Interval
  auc: number
  eer: { rate: number; threshold: number }
  atTargetFmr: { target: number; verifiable: boolean; threshold?: number; fnmr?: Interval; fmr?: Interval }
  byGap: Array<{ bucket: string; positives: number; fnmr: Interval }>
  byBrowser: Array<{
    browser: string
    events: number
    positives: number
    negatives: number
    fnmr: Interval
    fmr: Interval
  }>
}

export interface AnonymityReport {
  labels: number
  distinctIds: number
  /** Devices whose id nobody else has */
  labelsWithUniqueId: Interval
  largestGroup: number
  entropyBits: number
  maxEntropyBits: number
}

export interface Report {
  meta: DatasetMeta
  events: number
  labels: number
  labelsWithRepeatVisits: number
  spanDays: number
  browsers: Record<string, number>
  anonymity: AnonymityReport
  scorers: ScorerReport[]
  warnings: string[]
  options: { seed: number; threshold: number; targetFmr: number }
}

export interface ReportOptions extends PairOptions {
  /** A pair is called "same device" at or above this score */
  threshold?: number
  /** The false match rate that the operating point is chosen for */
  targetFmr?: number
  /** Gives the id used for the anonymity part. Defaults to the visitor id of the original library. */
  idOf?: (event: EvalEvent) => string
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    groups.set(k, [...(groups.get(k) ?? []), item])
  }
  return groups
}

function anonymity(events: readonly EvalEvent[], idOf: (event: EvalEvent) => string): AnonymityReport {
  const firstOfLabel = new Map<string, EvalEvent>()
  for (const event of [...events].sort((a, b) => a.receivedAt - b.receivedAt)) {
    if (!firstOfLabel.has(event.label)) {
      firstOfLabel.set(event.label, event)
    }
  }
  const labelsPerId = new Map<string, number>()
  for (const event of firstOfLabel.values()) {
    const id = idOf(event)
    labelsPerId.set(id, (labelsPerId.get(id) ?? 0) + 1)
  }
  const sizes = [...labelsPerId.values()]
  const labels = firstOfLabel.size
  return {
    labels,
    distinctIds: labelsPerId.size,
    labelsWithUniqueId: wilson(sizes.filter((size) => size === 1).length, labels),
    largestGroup: sizes.length === 0 ? 0 : Math.max(...sizes),
    entropyBits: shannonEntropyBits(sizes),
    maxEntropyBits: labels === 0 ? 0 : Math.log2(labels),
  }
}

type Scored = { pair: Pair; score: number }

/** The outcomes of a group of pairs for the interval: a hit is an error at the given threshold */
function outcomesOf(group: readonly Scored[], isError: (score: number) => boolean): ClusterOutcome[] {
  return group.map(({ pair, score }) => ({ a: pair.a.label, b: pair.b.label, hit: isError(score) }))
}

function evaluateScorer(
  scorer: Scorer,
  pairs: readonly Pair[],
  events: readonly EvalEvent[],
  options: { threshold: number; targetFmr: number; seed: number },
): ScorerReport {
  const { threshold, targetFmr, seed } = options
  const scored: Scored[] = pairs.map((pair) => ({ pair, score: scorer.score(pair.a, pair.b) }))
  const positives = scored.filter(({ pair }) => pair.same)
  const negatives = scored.filter(({ pair }) => !pair.same)
  const positiveScores = positives.map(({ score }) => score)
  const negativeScores = negatives.map(({ score }) => score)

  const missed = (score: number) => score < threshold
  const falselyMatched = (score: number) => score >= threshold
  const curve = rocCurve(positiveScores, negativeScores)
  const point = operatingPointAtFmr(curve, targetFmr)
  const verifiable = negatives.length >= 3 / targetFmr

  const byBrowser = [...groupBy(events, (event) => browserOf(event.userAgent)).entries()].map(
    ([browser, browserEvents]) => {
      const inBrowser = (event: EvalEvent) => browserOf(event.userAgent) === browser
      const p = positives.filter(({ pair }) => inBrowser(pair.a))
      const n = negatives.filter(({ pair }) => inBrowser(pair.a) && inBrowser(pair.b))
      return {
        browser,
        events: browserEvents.length,
        positives: p.length,
        negatives: n.length,
        fnmr: clusterInterval(outcomesOf(p, missed), { seed }),
        fmr: clusterInterval(outcomesOf(n, falselyMatched), { seed }),
      }
    },
  )

  return {
    name: scorer.name,
    description: scorer.description,
    threshold,
    positives: positives.length,
    negatives: negatives.length,
    fnmr: clusterInterval(outcomesOf(positives, missed), { seed }),
    fmr: clusterInterval(outcomesOf(negatives, falselyMatched), { seed }),
    auc: auc(positiveScores, negativeScores),
    eer: equalErrorRate(curve),
    atTargetFmr: {
      target: targetFmr,
      verifiable,
      threshold: point?.threshold,
      fnmr:
        point &&
        clusterInterval(
          outcomesOf(positives, (score) => score < point.threshold),
          { seed },
        ),
      fmr:
        point &&
        clusterInterval(
          outcomesOf(negatives, (score) => score >= point.threshold),
          { seed },
        ),
    },
    byGap: gapBuckets.map((bucket, index) => {
      const lower = index === 0 ? 0 : gapBuckets[index - 1].max
      const inBucket = positives.filter(({ pair }) => pair.gapMs >= lower && pair.gapMs < bucket.max)
      return {
        bucket: bucket.label,
        positives: inBucket.length,
        fnmr: clusterInterval(outcomesOf(inBucket, missed), { seed }),
      }
    }),
    byBrowser,
  }
}

export function buildReport(dataset: Dataset, scorers: readonly Scorer[], options: ReportOptions): Report {
  const { events } = dataset
  const threshold = options.threshold ?? 0.5
  const targetFmr = options.targetFmr ?? 0.001
  const seed = options.seed ?? 1
  const pairs = buildPairs(events, { ...options, seed })

  const byLabel = groupBy(events, (event) => event.label)
  const labelsWithRepeatVisits = [...byLabel.values()].filter((visits) => visits.length >= 2).length
  const times = events.map((event) => event.receivedAt)
  const spanDays = times.length === 0 ? 0 : (Math.max(...times) - Math.min(...times)) / day
  const browsers: Record<string, number> = {}
  for (const event of events) {
    const family = browserOf(event.userAgent)
    browsers[family] = (browsers[family] ?? 0) + 1
  }

  const idOf = options.idOf ?? legacyVisitorId
  const scorerReports = scorers.map((scorer) => evaluateScorer(scorer, pairs, events, { threshold, targetFmr, seed }))

  const positives = pairs.filter((pair) => pair.same).length
  const negatives = pairs.length - positives
  const warnings: string[] = []
  if (dataset.meta.source === 'synthetic') {
    warnings.push(
      'DADOS SINTÉTICOS: servem só para validar o harness. Nada aqui diz algo sobre a precisão no mundo real.',
    )
  }
  if (byLabel.size < 2) {
    warnings.push(`Há ${byLabel.size} rótulo(s): sem pelo menos 2 aparelhos não dá para medir falso match.`)
  }
  if (labelsWithRepeatVisits === 0) {
    warnings.push('Nenhum aparelho tem mais de uma visita: não dá para medir estabilidade.')
  } else if (positives < 100) {
    warnings.push(`Só ${positives} pares do mesmo aparelho: os intervalos de confiança de FNMR são largos.`)
  }
  if (byLabel.size >= 2 && negatives < 3 / targetFmr) {
    warnings.push(
      `Com ${negatives} pares de aparelhos diferentes, a menor taxa de falso match que dá para afirmar é cerca de ` +
        `${(ruleOfThree(negatives) * 100).toFixed(2).replace('.', ',')}% (regra dos três). Para afirmar ` +
        `${(targetFmr * 100).toString().replace('.', ',')}% são precisos pelo menos ${Math.ceil(3 / targetFmr)} pares.`,
    )
  }
  if (byLabel.size < 30) {
    warnings.push(`Só ${byLabel.size} aparelhos distintos: a unicidade medida não representa uma população.`)
  }
  if (labelsWithRepeatVisits > 0 && spanDays < 7) {
    warnings.push(
      `Os dados cobrem ${spanDays
        .toFixed(1)
        .replace('.', ',')} dias: nada pode ser dito sobre estabilidade em 7 ou 30 dias.`,
    )
  }
  const viaProxy = events.filter((event) => event.network.viaProxy).length
  if (viaProxy > 0) {
    warnings.push(
      `${viaProxy} eventos vieram atrás de proxy: a ordem dos cabeçalhos e o HTTP/2 deles descrevem o proxy.`,
    )
  }
  warnings.push(
    'Os intervalos de confiança reamostram aparelhos (bootstrap), porque pares que dividem um aparelho não são ' +
      'independentes. Com menos de 10 aparelhos o intervalo é 0% a 100%: os dados não bastam para dizer nada.',
  )
  warnings.push(
    'O rótulo precisa ser por aparelho e navegador. Se um rótulo juntar dois aparelhos, o FNMR sai inflado.',
  )

  return {
    meta: dataset.meta,
    events: events.length,
    labels: byLabel.size,
    labelsWithRepeatVisits,
    spanDays,
    browsers,
    anonymity: anonymity(events, idOf),
    scorers: scorerReports,
    warnings,
    options: { seed, threshold, targetFmr },
  }
}

const num = (value: number, digits = 2) => (Number.isNaN(value) ? 'n/d' : value.toFixed(digits).replace('.', ','))
const pct = (value: number) => (Number.isNaN(value) ? 'n/d' : `${num(value * 100)}%`)
const intervalOfDevices = (x: Interval) =>
  x.n === 0 ? 'n/d' : `${pct(x.value)} (IC 95%: ${pct(x.low)} a ${pct(x.high)}; ${x.n} aparelhos)`
const interval = (x: Interval) =>
  x.n === 0
    ? 'n/d (sem casos)'
    : `${pct(x.value)} (IC 95%: ${pct(x.low)} a ${pct(x.high)}; ${x.n} pares de ${x.clusters ?? '?'} aparelhos)`

export function renderMarkdown(report: Report): string {
  const lines: string[] = ['# Relatório de avaliação', '']
  if (report.meta.source === 'synthetic') {
    lines.push('> **DADOS SINTÉTICOS.** Este relatório só valida o harness e não diz nada sobre precisão real.', '')
  }
  lines.push(
    `- Origem dos dados: ${report.meta.source}${
      report.meta.ipPseudonymized ? ' (endereços de IP trocados por hashes)' : ''
    }`,
    `- Eventos: ${report.events}, aparelhos (rótulos): ${report.labels}, ` +
      `com mais de uma visita: ${report.labelsWithRepeatVisits}`,
    `- Período coberto: ${num(report.spanDays, 1)} dias`,
    `- Navegadores: ${
      Object.entries(report.browsers)
        .map(([name, count]) => `${name} ${count}`)
        .join(', ') || 'n/d'
    }`,
    `- Limiar de decisão: ${num(report.options.threshold)}; semente da amostragem: ${report.options.seed}`,
    '',
    '## Avisos',
    '',
    ...report.warnings.map((warning) => `- ${warning}`),
    '',
    '## Unicidade do identificador da biblioteca original',
    '',
    `- Identificadores distintos: ${report.anonymity.distinctIds} para ${report.anonymity.labels} aparelhos`,
    `- Aparelhos com identificador só seu: ${intervalOfDevices(report.anonymity.labelsWithUniqueId)}`,
    `- Maior grupo que compartilha um identificador: ${report.anonymity.largestGroup} aparelhos`,
    `- Entropia: ${num(report.anonymity.entropyBits)} bits de no máximo ${num(report.anonymity.maxEntropyBits)}`,
    '',
  )

  for (const scorer of report.scorers) {
    lines.push(
      `## Pontuador: ${scorer.name}`,
      '',
      scorer.description,
      '',
      `- Pares do mesmo aparelho: ${scorer.positives}; de aparelhos diferentes: ${scorer.negatives}`,
      `- FNMR (mesmo aparelho tratado como outro): ${interval(scorer.fnmr)}`,
      `- FMR (aparelhos diferentes tratados como o mesmo): ${interval(scorer.fmr)}`,
      `- AUC: ${num(scorer.auc, 3)}; EER: ${pct(scorer.eer.rate)}`,
      scorer.atTargetFmr.fnmr
        ? `- No ponto com FMR de no máximo ${pct(scorer.atTargetFmr.target)}: FNMR ${interval(
            scorer.atTargetFmr.fnmr,
          )}${scorer.atTargetFmr.verifiable ? '' : ' (**não verificável**: faltam pares de aparelhos diferentes)'}`
        : `- Nenhum limiar atinge FMR de ${pct(scorer.atTargetFmr.target)}.`,
      '',
      '**Estabilidade: FNMR por tempo entre as duas visitas**',
      '',
      '| Intervalo | Pares | FNMR |',
      '|---|---|---|',
      ...scorer.byGap.map(
        (row) => `| ${row.bucket} | ${row.positives} | ${row.fnmr.n === 0 ? 'n/d' : interval(row.fnmr)} |`,
      ),
      '',
      '**Por navegador**',
      '',
      '| Navegador | Eventos | Pares iguais | Pares diferentes | FNMR | FMR |',
      '|---|---|---|---|---|---|',
      ...scorer.byBrowser.map(
        (row) =>
          `| ${row.browser} | ${row.events} | ${row.positives} | ${row.negatives} | ` +
          `${row.fnmr.n === 0 ? 'n/d' : pct(row.fnmr.value)} | ${row.fmr.n === 0 ? 'n/d' : pct(row.fmr.value)} |`,
      ),
      '',
    )
  }
  return `${lines.join('\n')}\n`
}
