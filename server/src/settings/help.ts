/* eslint-disable max-len -- the texts are prose for the person who operates the server; one line per paragraph */
/**
 * The long explanation of each parameter, shown by the settings panel (and in the reference document).
 *
 * `parameters.ts` says what a parameter is (default, allowed values, a short description). This file says what to do
 * with it: when to raise it, when to lower it, a few real situations, and what to watch for. A parameter without an
 * entry here shows its short description with a note that the documentation is still being written.
 *
 * To document a parameter: add an entry below and remove its path from `helpPending` in `help_pending.ts`. A test
 * fails if a parameter has neither, so a new parameter cannot be added without deciding where its explanation goes.
 */
export interface ParameterHelp {
  /** A short name, in words, for the label of the field */
  title: string
  /** One sentence: what it is. It is what the helptip shows first. */
  summary: string
  /** The explanation, in a few paragraphs separated by a blank line */
  what: string
  /** What happens, and when it is worth it, if the value goes up */
  raise?: string
  /** What happens, and when it is worth it, if the value goes down */
  lower?: string
  /** Real situations: "Situação: ... Faça: ..." */
  useCases: string[]
  /** What to watch for */
  caution?: string
  /** What I would use while only collecting samples */
  whileCollecting?: string
  /**
   * `legal`: turning it on needs a legal basis or an opinion, so the panel asks twice and says why.
   * `attention`: a change that is easy to regret, so the panel asks twice.
   * `restart`: only takes effect after the server restarts.
   * `preview`: what the preview before saving can show: `risk`, `rules` or `tamper` (read-time results) or `none`
   * (the decision is made and stored when the visit arrives, so the past cannot be replayed).
   */
  flags?: { legal?: boolean; attention?: boolean; restart?: boolean; preview?: 'risk' | 'rules' | 'tamper' | 'none' }
}

/** Parameters that hold secrets or that the panel cannot edit safely: shown, not edited */
export const readOnlyParameters: ReadonlySet<string> = new Set(['webhooks.endpoints'])

export const parameterHelp: Record<string, ParameterHelp> = {
  'identity.learnFromTampered': {
    title: 'Quais visitas ensinam o motor',
    summary: 'Define se visitas com sinais de adulteração são guardadas no perfil dos aparelhos.',
    what: 'O motor reconhece um aparelho porque guardou o que viu dele nas visitas anteriores. Uma visita "ensina" o motor quando cria um aparelho novo ou acrescenta valores a um aparelho conhecido. Visitas com evidência de adulteração (veja a aba de adulteração) podem ser ruins para ensinar: uma ferramenta de fraude poderia contaminar o perfil de um aparelho de verdade.\n\n`not_high` (padrão): só deixa de ensinar a visita com evidência de severidade alta. `never_flagged`: só ensina visita sem nenhuma evidência. `always`: todas ensinam.\n\nUma visita que não ensina ainda recebe um identificador (`visitorId`), mas ele não fica guardado. Por isso a próxima visita do mesmo navegador não encontra nada parecido e vira "aparelho novo" de novo.',
    raise:
      'Mudar para `never_flagged` ensina menos: o perfil fica mais limpo, mas mais navegadores honestos viram "aparelho novo" a cada visita.',
    lower:
      'Mudar para `always` ensina mais: o mesmo navegador passa a ser reconhecido mesmo com um sinal estranho, mas ferramentas de fraude também entram no perfil.',
    useCases: [
      'Situação: seu Chrome tem uma extensão que altera uma função do navegador, recebe severidade alta e cada aba vira um aparelho novo. Faça: use `always` enquanto só coleta amostras, ou corrija a causa (veja `tamper.severity`).',
      'Situação: você vai começar a barrar contas repetidas. Faça: volte para `not_high` ou `never_flagged`, para que quem fraude não consiga se passar por um aparelho legítimo.',
    ],
    caution:
      'Aparelhos aprendidos não são esquecidos ao voltar para um valor mais rígido. Mudar o valor vale só para as visitas novas.',
    whileCollecting: '`always`, para ver como cada navegador é reconhecido.',
    flags: { preview: 'none' },
  },
  'identity.enabled': {
    title: 'Identificar visitantes',
    summary: 'Liga o motor que dá um código de aparelho (`visitorId`) a cada visita.',
    what: 'Desligado, as visitas continuam sendo guardadas, mas ninguém recebe um código de aparelho e não há reconhecimento entre visitas.',
    useCases: [
      'Situação: quer só registrar visitas, sem reconhecer ninguém. Faça: desligue. Para a maioria dos casos, deixe ligado.',
    ],
    flags: { preview: 'none' },
  },
  'identity.matchProbability': {
    title: 'Certeza para ligar uma visita a um aparelho conhecido',
    summary: 'Quanto o motor precisa ter de certeza para dizer "é o mesmo aparelho".',
    what: 'Cada visita é comparada com os aparelhos conhecidos. Se o mais parecido passa deste valor, a visita é ligada a ele. Se não, vira um aparelho novo.\n\nLigar duas pessoas diferentes é o erro mais caro (uma acusação injusta), por isso o padrão sem modelo calibrado é 0,99. Sem dados rotulados o valor é provisório, e não existe uma probabilidade confiável (`calibrated: false`).',
    raise:
      'Liga menos: mais aparelhos separados, menos pessoas misturadas. Os navegadores que mudam de sinais viram "aparelho novo" com mais frequência.',
    lower: 'Liga mais: menos aparelhos duplicados, mas sobe o risco de misturar duas pessoas com aparelhos parecidos.',
    useCases: [
      'Situação: muitas pessoas usam o mesmo modelo de celular (aparelhos quase iguais). Faça: mantenha alto, para não misturar.',
      'Situação: o mesmo navegador aparece como vários aparelhos porque um sinal varia. Faça: investigue o sinal (`identity.disabledFeatures`) antes de baixar este valor.',
    ],
    caution:
      'Não ajuste com dados sem rótulo. Sem pares de visitas em que se sabe quem é quem, qualquer valor é um palpite.',
    flags: { preview: 'none' },
  },
  'identity.possibleLinkProbability': {
    title: 'Certeza para marcar uma possível ligação',
    summary: 'A partir de quanto uma visita que não foi ligada é marcada como "parecida com" outro aparelho.',
    what: 'É um aviso mais fraco que a ligação: a visita continua sendo um aparelho novo, mas o painel mostra qual aparelho conhecido era o mais parecido. Deve ser menor que a certeza para ligar. `null` desliga a marcação.',
    useCases: [
      'Situação: quer ver candidatos a "mesma pessoa em outro navegador" sem juntar os códigos. Faça: ligue com um valor abaixo do de ligação.',
    ],
    caution: 'Precisa ser menor que `identity.matchProbability`, senão o servidor recusa a configuração.',
    flags: { preview: 'none' },
  },
  'identity.onAmbiguous': {
    title: 'O que fazer quando dois aparelhos servem quase igual',
    summary: 'Escolhe entre não ligar a nenhum (`separate`) ou ligar ao melhor mesmo assim (`attach`).',
    what: '`separate` cria um aparelho novo e marca o mais próximo como possível ligação. `attach` liga ao melhor. Um aparelho duplicado se junta depois (pelo painel de visitas); duas pessoas misturadas são mais difíceis de desfazer.',
    useCases: ['Situação: quer o menor risco de acusar a pessoa errada. Faça: `separate` (padrão).'],
    flags: { preview: 'none' },
  },
  'identity.storedId.enabled': {
    title: 'Código guardado no navegador',
    summary: 'Grava um código aleatório no navegador do visitante para reconhecê-lo com mais certeza.',
    what: 'É o sinal mais forte para reconhecer o mesmo navegador, mesmo quando outros sinais mudam. Mas é um **identificador persistente gravado no aparelho de quem visita**: exige base legal definida e texto de privacidade que o mencione.\n\nA página precisa declarar a base legal (`consent` ou `legitimate_interest`) em cada visita; o servidor descarta o código de uma visita que não declarou. Limpar os dados do site ou usar janela privada apaga o código.',
    useCases: [
      'Situação: você quer reconhecer melhor quem usa navegadores que embaralham sinais. Faça: só ligue depois do parecer jurídico e de atualizar a política de privacidade.',
    ],
    caution: 'Decisão pendente de parecer jurídico (D87). O padrão é desligado.',
    flags: { legal: true, preview: 'none' },
  },
  'identity.disabledFeatures': {
    title: 'Sinais que o motor ignora',
    summary: 'Lista de sinais que não entram na comparação entre visitas.',
    what: 'Use para tirar um sinal que se mostrou instável (muda a cada visita no mesmo aparelho) ou que você não quer usar por privacidade. O sinal continua sendo coletado e guardado; só não conta para decidir quem é quem. Para não guardá-lo, use `privacy.dropSignals`.',
    useCases: [
      'Situação: o painel de "por que virou aparelho novo" mostra sempre o mesmo sinal divergindo no mesmo navegador. Faça: adicione-o aqui e veja se o reconhecimento melhora.',
    ],
    flags: { preview: 'none' },
  },
  'tamper.enabled': {
    title: 'Evidência de adulteração',
    summary: 'Liga as verificações que procuram sinais de navegador falsificado ou automatizado.',
    what: 'Cada verificação olha uma contradição possível (por exemplo, o navegador diz ser um Chrome de Mac mas a placa de vídeo é de Windows) e registra um sinal com gravidade baixa, média ou alta. O resultado é **evidência, nunca veredito**: uma lista vazia não prova que a visita é honesta, e um sinal pode ter explicação inocente.\n\nDesligado, nenhuma evidência aparece e a política `identity.learnFromTampered` deixa de ter efeito.',
    useCases: [
      'Situação: quer só coletar amostras sem nenhuma avaliação. Faça: pode desligar, mas perde a informação de quais navegadores são alterados.',
    ],
    flags: { preview: 'tamper' },
  },
  'tamper.disabledChecks': {
    title: 'Verificações desligadas',
    summary: 'Lista de verificações de adulteração que não rodam.',
    what: 'Desligue uma verificação que acuse injustamente o seu público, por exemplo porque muitos dos seus visitantes usam uma extensão que altera o navegador. O sinal dela nunca mais aparece. Se a verificação tem utilidade parcial, prefira mudar a severidade em `tamper.severity`.',
    useCases: [
      'Situação: uma verificação marca como alta quase todo visitante que usa uma extensão popular. Faça: rebaixe a severidade primeiro; desligue só se ainda atrapalhar.',
    ],
    caution: 'Desligar uma verificação também esconde fraudes reais que ela pegaria.',
    flags: { preview: 'tamper' },
  },
  'tamper.severity': {
    title: 'Gravidade de cada verificação',
    summary: 'Troca a gravidade (`low`, `medium`, `high`) de uma verificação, só para este tenant.',
    what: 'A tabela padrão de gravidades é um julgamento. Aqui você muda uma verificação específica. A gravidade alimenta o risco (`risk.tamperWeights`) e a política de aprendizado (`identity.learnFromTampered`).',
    useCases: [
      'Situação: `navigator_overridden_on_instance` marca como alta um navegador com um polyfill inofensivo. Faça: rebaixe para `low` neste tenant.',
      'Situação: no seu fluxo de pagamento, qualquer automação é grave. Faça: suba `automation_markers` e `headless_user_agent` (já altas) e as verificações de inconsistência para `high`.',
    ],
    flags: { preview: 'tamper' },
  },
  'tamper.clockSkewSeconds': {
    title: 'Diferença de relógio tolerada',
    summary: 'Quantos segundos o relógio do navegador pode diferir do servidor antes de virar evidência.',
    what: 'Um relógio muito diferente indica um navegador com horário falso ou um dispositivo com a data errada. Muita gente tem o relógio atrasado alguns minutos, então o padrão é de 5 minutos.',
    raise: 'Mais tolerante: menos falsos positivos em aparelhos com a hora errada.',
    lower: 'Mais rígido: pega relógios falsificados por pouco, mas acusa quem só esqueceu de ajustar a hora.',
    useCases: [
      'Situação: aparecem muitas evidências `clock_skew` em celulares de quem nunca mexeu em nada. Faça: aumente.',
    ],
    flags: { preview: 'tamper' },
  },
  'risk.enabled': {
    title: 'Risco composto',
    summary: 'Liga a nota de risco (0 a 100) na resposta de cada visita.',
    what: 'O risco é uma soma de pesos que **você** define para cada fator (adulteração, tipo de IP, muitas contas num aparelho...). É uma heurística, não uma probabilidade: nenhum peso foi calibrado com dados reais. Serve para ordenar o que olhar primeiro, não para acusar.',
    useCases: [
      'Situação: quer só observar. Faça: deixe ligado e olhe a distribuição das notas antes de decidir limiares.',
    ],
    flags: { preview: 'risk' },
  },
  'risk.levels.medium': {
    title: 'Nota a partir da qual o risco é médio',
    summary: 'Pontuação mínima para o nível `medium` (abaixo disso é `low`).',
    what: 'A nota de risco vai de 0 a 100 e vira um nível por dois cortes. Este é o primeiro. Precisa ser menor que o corte de `high`.',
    raise: 'Menos visitas médias.',
    lower: 'Mais visitas médias.',
    useCases: [
      'Situação: quase toda visita sai `medium` e a marcação perdeu a utilidade. Faça: suba o corte até que `medium` seja a minoria.',
    ],
    flags: { preview: 'risk' },
  },
  'risk.levels.high': {
    title: 'Nota a partir da qual o risco é alto',
    summary: 'Pontuação mínima para o nível `high`.',
    what: 'Segundo corte da nota de risco. Com os pesos padrão, uma evidência de adulteração de gravidade alta (40) soma 40 e entra em `medium`; alta + média + baixa (40+15+5) soma 60 e entra em `high`.',
    raise: 'Menos visitas altas: só os casos com vários fatores somados.',
    lower: 'Mais visitas altas.',
    useCases: [
      'Situação: quer revisar manualmente só os casos mais fortes. Faça: suba o corte e olhe os `high` primeiro.',
    ],
    caution: 'Precisa ser maior que `risk.levels.medium`.',
    flags: { preview: 'risk' },
  },
  'risk.tamperWeights': {
    title: 'Peso de cada gravidade de adulteração',
    summary: 'Quantos pontos de risco cada evidência de adulteração soma, por gravidade.',
    what: 'Cada sinal de adulteração soma uma vez, pelo peso da sua gravidade (`low`, `medium`, `high`). O padrão é 40, 15 e 5.',
    useCases: [
      'Situação: seu público usa muitas extensões e a evidência de gravidade alta infla o risco. Faça: baixe o peso de `high` ou rebaixe as verificações em `tamper.severity`.',
    ],
    flags: { preview: 'risk' },
  },
  'risk.newVisitorWeight': {
    title: 'Peso de ser um aparelho novo',
    summary: 'Pontos de risco por a visita vir de um aparelho nunca visto.',
    what: 'O padrão é 0, porque todo cliente novo é um aparelho novo. Só faz sentido em fluxos em que um aparelho desconhecido é raro, como o login de uma conta antiga.',
    useCases: [
      'Situação: você mede login de contas que já existem. Faça: use um peso positivo, porque um aparelho novo numa conta antiga merece atenção.',
    ],
    flags: { preview: 'risk' },
  },
  'risk.velocity.windowMinutes': {
    title: 'Janela para contar repetições',
    summary: 'Quantos minutos para trás contam visitas do mesmo aparelho ou do mesmo IP.',
    what: 'Os fatores de "muitas contas num aparelho", "muitos aparelhos num IP" e "muitos IPs num aparelho" contam eventos dentro desta janela. O padrão é um dia.',
    raise: 'Pega abuso espalhado em dias (contas criadas com intervalo), mas junta mais visitas legítimas.',
    lower: 'Pega só rajadas rápidas.',
    useCases: [
      'Situação: o abuso que você quer achar cria uma conta por dia durante uma semana. Faça: suba para 10080 (7 dias).',
    ],
    flags: { preview: 'risk' },
  },
  'risk.velocity.linkedIdsPerDevice.threshold': {
    title: 'Contas por aparelho antes de acusar',
    summary: 'Quantos `linkedId` diferentes o mesmo aparelho pode ter na janela antes de contar como várias contas.',
    what: 'O `linkedId` é o id da conta que o seu site manda junto com a visita. Passando deste número, o fator pesa (veja o peso ao lado). Uma família ou uma lan house legitimamente tem várias contas num aparelho.',
    raise: 'Menos acusações, mais abuso passa.',
    lower: 'Mais acusações, e mais gente honesta marcada.',
    useCases: [
      'Situação: depois de algumas semanas coletando, a tabela de contas por aparelho mostra 97% com 1 conta e quase ninguém com 4 ou mais. Faça: use 4 como corte.',
      'Situação: seu produto é usado em computadores compartilhados. Faça: suba o corte.',
    ],
    caution: 'Escolha o corte olhando a distribuição real (estatística 6 do `help.sh`), não por palpite.',
    flags: { preview: 'risk' },
  },
  'risk.velocity.devicesPerIp.threshold': {
    title: 'Aparelhos por IP antes de acusar',
    summary: 'Quantos aparelhos diferentes podem sair do mesmo IP na janela.',
    what: 'Escritórios, escolas e operadoras de celular (CGNAT) têm muitos aparelhos atrás de um IP, por isso o padrão é alto (10).',
    useCases: [
      'Situação: muito tráfego de celular móvel. Faça: mantenha alto, para não marcar redes de operadora inteiras.',
    ],
    flags: { preview: 'risk' },
  },
  'privacy.ipStorage': {
    title: 'O que guardar do endereço IP',
    summary: 'Escolhe entre guardar o IP inteiro, truncado, só um hash, ou nada.',
    what: '`full`: o IP inteiro. `truncated`: IPv4 até /24 e IPv6 até /48. `hash`: um hash com chave diferente por tenant: visitas do mesmo IP ainda se reconhecem, mas o IP não volta (é pseudonimização, não anonimização). `none`: nada.\n\nOs rótulos das listas de IP, o país e o limite por IP não são afetados. Vale só para as visitas novas; as já guardadas ficam como estão.',
    useCases: [
      'Situação: quer reconhecer visitas do mesmo IP sem guardar o endereço. Faça: `hash`.',
      'Situação: quer investigar um caso e ver o IP. Faça: `full`, com consciência de que o IP é dado pessoal.',
    ],
    caution: 'Mudar não altera o que já foi guardado.',
    flags: { attention: true, preview: 'none' },
  },
  'privacy.requireConsent': {
    title: 'Exigir declaração de consentimento',
    summary: 'Recusa visitas cuja página não declare uma base legal de consentimento.',
    what: 'A declaração é feita pela página e o navegador não consegue prová-la: serve para auditoria, não como prova. Com isto ligado, uma visita sem declaração recebe erro 422 e não é guardada.',
    useCases: [
      'Situação: seu site tem um banner de consentimento e só quer coletar de quem aceitou. Faça: ligue e faça a página declarar `consent`.',
    ],
    caution: 'Com isto ligado e a página sem a declaração, a coleta para por completo.',
    flags: { attention: true, preview: 'none' },
  },
  'privacy.dropSignals': {
    title: 'Sinais descartados ao chegar',
    summary: 'Lista de sinais que o servidor joga fora assim que a visita chega.',
    what: 'É o mesmo que `exclude` no coletor, mas imposto pelo servidor: nem as verificações nem o motor de identidade verão esses sinais, e eles não serão guardados.',
    useCases: [
      'Situação: quer reduzir a coleta ao mínimo por privacidade. Faça: liste os sinais que não usa (por exemplo `speechVoices`).',
    ],
    caution: 'Tirar um sinal reduz a capacidade de reconhecer o aparelho e de achar adulteração.',
    flags: { preview: 'none' },
  },
  'retention.eventsDays': {
    title: 'Dias de retenção das visitas',
    summary: 'Por quantos dias uma visita fica guardada antes de ser apagada.',
    what: 'Depois deste prazo o evento é apagado, e o aparelho também, se nenhum outro evento o usa. Cada visita guarda cerca de 45 KB, então o número de dias define quanto disco o banco usa.',
    raise: 'Mais histórico para analisar, e mais disco e mais dado pessoal guardado.',
    lower: 'Menos disco e menos exposição, mas menos histórico para reconhecer quem volta depois de semanas.',
    useCases: [
      'Situação: 5.000 visitas por dia com 60 dias de retenção dão cerca de 13 GB. Faça: confira o disco livre antes de aumentar.',
      'Situação: o abuso que você procura se espalha por meses. Faça: suba a retenção para cobrir o intervalo.',
    ],
    caution: 'Reduzir apaga dados na próxima limpeza, sem como desfazer.',
    flags: { attention: true, preview: 'none' },
  },
  'rules.list': {
    title: 'Regras de decisão',
    summary:
      'Regras que transformam o que o servidor sabe sobre a visita numa decisão (`allow`, `review`, `block`...).',
    what: 'Cada regra tem `id`, uma condição `when` e uma `decision`. A primeira que valer decide. A condição combina `all`, `any`, `not` e comparações de um campo (por exemplo `risk.score` ou `velocity.linkedIdsPerDevice`) com um valor. Uma regra com erro impede a configuração de ser salva.\n\nO servidor só **informa** a decisão: quem age é o seu sistema. Comece com `review` (marcar para olhar), não com `block`.',
    useCases: [
      'Situação: depois de observar, aparelhos com 4 ou mais contas são raros. Faça: uma regra `velocity.linkedIdsPerDevice >= 4` com decisão `review`.',
    ],
    caution: 'Veja `docs/regras.md` para os campos e operadores.',
    whileCollecting: 'Lista vazia: nenhuma decisão, só registro.',
    flags: { attention: true, preview: 'rules' },
  },
  'rules.defaultDecision': {
    title: 'Decisão quando nenhuma regra vale',
    summary: 'O que responder quando há regras mas nenhuma delas se aplica à visita.',
    what: 'Só tem efeito quando existe pelo menos uma regra em `rules.list`. O padrão é `allow`.',
    useCases: ['Situação: quer que tudo que não casou com nenhuma regra seja revisado. Faça: `review`.'],
    flags: { preview: 'rules' },
  },
  'limits.collectPerMinutePerIp': {
    title: 'Envios por minuto por IP',
    summary: 'Quantas visitas por minuto o servidor aceita de um mesmo endereço IP.',
    what: 'Protege o servidor de rajadas. Muitas pessoas atrás de um mesmo IP (escritório, operadora) podem bater neste limite e receber erro 429.',
    raise: 'Tolera redes grandes compartilhando um IP.',
    lower: 'Barra mais cedo um IP que despeja visitas.',
    useCases: ['Situação: uma campanha traz muito tráfego de uma operadora móvel e aparecem erros 429. Faça: aumente.'],
    flags: { preview: 'none' },
  },
  'nonce.required': {
    title: 'Exigir desafio (nonce)',
    summary: 'Recusa envios que não passaram pelo desafio que o servidor emitiu.',
    what: 'O desafio é uma senha de uso único que a página pede antes de enviar. Impede que alguém reenvie o mesmo pacote ou invente visitas sem passar pelo servidor. Desligar tira essa proteção e só deve ser feito em teste.',
    useCases: ['Situação: está testando o coletor com um script. Faça: desligue só no tenant de teste.'],
    caution: 'Em produção, deixe ligado.',
    flags: { attention: true, preview: 'none' },
  },
  'api.allowDeletion': {
    title: 'Permitir apagar dados pela API',
    summary: 'Deixa o seu sistema apagar visitas de uma pessoa pela API (`DELETE /v1/...`).',
    what: 'Serve para atender o pedido de um titular de dados. Desligue se quiser que a exclusão só aconteça por um caminho com mais controle.',
    useCases: ['Situação: um usuário pede para apagar os dados. Faça: mantenha ligado para poder atender pela API.'],
    flags: { attention: true, preview: 'none' },
  },
  'sharedGraph.participate': {
    title: 'Participar do grafo compartilhado',
    summary: 'Troca contagens agregadas de aparelhos marcados como abusivos com outros clientes.',
    what: 'Nunca atravessa evento, conta, endereço ou nome de tenant, só contagens agregadas. Só pode ser ligado se o grafo estiver habilitado no arquivo de configuração, o que exige a referência de um parecer jurídico.',
    useCases: [
      'Situação: você vende o serviço a vários clientes e quer que um aparelho abusivo num cliente seja visto nos outros. Faça: só depois do parecer.',
    ],
    caution: 'Decisão D3: não ligue em produção sem o parecer jurídico.',
    flags: { legal: true, preview: 'none' },
  },
}
