# CLAUDE.md

Guia para quem (humano ou IA) continua este projeto. Leia primeiro. Mantenha atualizado ao fechar cada fase.

## O que é este repositório

Fork da biblioteca FingerprintJS v5.3.0 (licença MIT) que está sendo evoluído para uma plataforma de identificação de
visitantes para prevenção a fraude e a múltiplas contas, no estilo do Fingerprint Identification (Pro).
O cliente coleta sinais crus e o servidor decide quem é o visitante. O plano completo está em
[docs/plano/roadmap.md](docs/plano/roadmap.md).

- Uso próprio primeiro, SaaS multi-tenant depois (decisão do dono do projeto).
- Grafo de identidade compartilhado entre clientes foi escolhido pelo dono, com salvaguardas e trava jurídica.
  Veja [docs/plano/decisoes.md](docs/plano/decisoes.md), decisão D3. Não ligue isso em produção sem o parecer.
- Idioma: respostas ao usuário em pt-BR. Código, comentários, mensagens de commit e `docs/*.md` da biblioteca em inglês.
  Os documentos de plano em `docs/plano/` ficam em pt-BR.

## Onde estamos

Veja a tabela de status no [roadmap](docs/plano/roadmap.md). Resumo em 2026-10-19: **todas as fases do plano têm código e
testes** (0 a 10, a camada SaaS e o mecanismo do grafo compartilhado, que está **desligado e travado**). A fase 10 reúne tudo que
dava para fazer sem dados reais ([relatório](docs/plano/fases/fase-10-sem-dados.md)). O que falta não é código:

- **Dados reais da Fase 0** (só o dono recruta voluntários): sem eles não existe número de precisão, os parâmetros do motor
  são provisórios (`calibrated: false`) e os pesos do risco são palpites. Ver `docs/plano/guia-do-organizador.md` e
  `protocolo-coleta-etica.md`. Não calibre nem afirme nada com dado sintético.
- **Revisão jurídica** (adiada para o fim, a pedido do dono): texto de consentimento da página de coleta, LIA, RIPD, política
  de privacidade, o **código guardado no navegador** (D87, identificador persistente no aparelho do titular, desligado por padrão) (modelos em `docs/plano/privacidade/`) e o parecer sem o qual o grafo compartilhado não liga.
- **Navegadores anti-detecção profissionais** nunca foram testados contra a evidência de adulteração.
- **Faturamento, painel de cliente com login, DPA e SLA** do SaaS não existem.
- **Escala:** o banco de produção é o MySQL (D79); medido só em notebook, cerca de 30 visitas por segundo (D82). Vários servidores sobre um MySQL funcionam e foram testados com dois (D89). A busca de candidatos foi medida até 1 milhão de aparelhos **inventados** (D90): só latência.
- **Medir quem não alcança o servidor** (porta 8443 bloqueada, bloqueadores): carregador, receptor de avisos e resumo existem e foram testados (D96, D97); **Safari e uma rede que bloqueia a porta de verdade não foram verificados**. A mudança para a porta 443 está só documentada (D98) e o dono decidiu não arriscar o nginx compartilhado.
- **Pesquisa** (`docs/plano/01-pesquisa-e-fontes.md`) foi mais rasa que o pedido original: cerca de 30 buscas.

Documentos do plano: `01-pesquisa-e-fontes`, `02-inventario-de-capacidades`, `03-ideias-inovadoras`,
`05-riscos-privacidade-e-compliance`, `06-fechamento-e-autocritica` (comece por este), `decisoes.md` (D1 a D95), relatórios em `docs/plano/fases/`.
Para evoluir a busca de candidatos quando houver dados reais: `busca-de-candidatos-v2-como-evoluir-com-dados-reais`.
Para vender a vários clientes (domínio do cliente, CNAME, SNI): `vender-para-varios-clientes-dominio-do-cliente-cname-subdominio-first-party-ja4-sni-certificado-por-cliente-proxy-do-cliente`.
Para instalar na VPS (`id.empregoaqui.com.br`, passo a passo): `instalar-na-vps-passo-a-passo-id-empregoaqui-com-br-docker-tls-mysql-certificado-letsencrypt-coletor-no-pwa-fase-de-observacao`.
Para medir quem não alcança o servidor (porta 8443 bloqueada, bloqueadores): `detectar-bloqueio-da-porta-8443-e-do-coletor-aviso-de-falha-loader-receptor-asn-lgpd`.
Para usar a porta 443 sem derrubar o nginx (adiado, não recomendado agora): `usar-a-porta-443-para-o-fingerprint-sem-derrubar-o-nginx-sni-stream-ssl-preread-proxy-protocol-segundo-ip-opcoes-e-riscos`.
Para a decisão do banco e os cuidados em produção: `mysql-ou-sqlite-decisao-e-cuidados-em-producao-vps-compartilhada-retencao-conexoes-disco-backup`.

## Mapa do repositório

| Caminho | O que é |
|---|---|
| `src/` | Biblioteca do navegador. `src/sources/` são as 42 fontes originais, `src/agent.ts` é o `load()/get()` legado. |
| `src/collector/` | Coletor novo (Fase 1): `collect()`, `send()`, fontes extras em `sources/`. |
| `src/loader/` | Carregador (`dist/fp-loader.min.js`, global `FpLoader`): serve do site do cliente, carrega o coletor e avisa quando ele não é alcançado. |
| `server/` | Servidor de ingestão (Fase 2), TypeScript para Node 22, sem dependência de execução com SQLite; o MySQL (banco de produção, D79) usa só o driver opcional `mysql2`. Veja `server/README.md`. |
| `server/src/net/`, `tls/`, `ingest/`, `store/` | Sinais de rede (IP, cabeçalhos, HTTP/2), JA4 e front TLS, validação e nonce, armazenamento. |
| `server/src/identity/` | Motor de matching (Fase 3): características, modelo, motor, armazenamento, ajuste. |
| `server/src/settings/` | Configuração: tabela única de parâmetros, camadas, validação, recarga, referência gerada (`docs/configuracao.md`). |
| `server/src/webhooks/`, `sdk/`, `dashboard/` | Entrega de webhooks (fila, assinatura, rede segura), SDK de Node e painel (Fase 6). |
| `server/src/privacy/`, `audit/` | Forma do IP guardado e registro de acessos (Fase 7). Modelos jurídicos em `docs/plano/privacidade/`. |
| `server/src/risk/` | Risco composto, fatos e regras de decisão (Fase 5), sempre por parâmetros do tenant. |
| `server/src/tamper/` | Evidência de adulteração (Fase 4): 16 verificações puras e a leitura de plataforma. |
| `server/src/environment/`, `net/bots.ts` | Fatos do ambiente (janela privada, placa virtual) e robôs de busca verificados por DNS (Fase 10). |
| `server/src/reachability/`, `net/asn.ts` | Receptor dos avisos do carregador (SQLite, sem IP), resumo e tabela opcional de redes (ASN). |
| `server/src/mysql/`, `migrate.ts` | MySQL (banco de produção), vez entre instâncias, limites compartilhados e a migração do SQLite. |
| `server/src/eval/` | Harness de avaliação (Fase 0): dataset, pares, pontuadores, estatística, relatório, gerador sintético. |
| `tools/calibration/` | Página de coleta com consentimento para voluntários. |
| `tools/dev-receiver.js` | Receptor de desenvolvimento do cliente. Não é o servidor de verdade. |
| `docs/` | Docs da biblioteca (em inglês). `docs/collector.md` é o contrato do payload. |
| `docs/plano/` | Plano, decisões e relatórios de fase (em pt-BR). |
| `tests/` | Utilitários de teste do navegador e o teste de integração do bundle. |

## Comandos

O Yarn não vem instalado. Use `npx --yes yarn@1.22.22 <comando>` (abreviado aqui como `yarn`).

```bash
yarn install --frozen-lockfile --ignore-scripts --ignore-engines   # primeira vez; --ignore-scripts evita o husky mexer no git
yarn build            # bundles do navegador em dist/: fp.min.js (coletor) e fp-loader.min.js (carregador)
yarn lint             # tem de passar com zero avisos (--max-warnings 0)
yarn test:local       # Karma: Chrome e Firefox headless (283 testes)
yarn check:dts && yarn check:ssr   # as duas checagens extras do CI
yarn server:build && yarn server:test   # servidor (Fase 2); precisa de Node 22 por causa do node:sqlite
FP_TEST_MYSQL_URL=mysql://root:senha@127.0.0.1:3306 yarn server:test   # inclui os testes de contrato do MySQL (cada teste cria e apaga um banco)
node server/dist/cli.js config-reference --out docs/configuracao.md   # regenera a referência; um teste falha se ela envelhecer
node server/dist/cli.js rules-reference --out docs/regras.md   # regras e fatos; idem, um teste vigia
node server/dist/cli.js fetch-ip-list aws|gcp|tor --out lista.txt   # lista pública de IPs no formato de ipLists
node tools/loadtest/run.js --url http://127.0.0.1:8080 --pk pk_... --seconds 20 --concurrency 16 --devices 5000   # carga na coleta (servidor de teste, banco descartável)
node server/dist/cli.js new-tenant <id>   # cria chaves de um tenant; a chave secreta aparece uma vez
node server/dist/cli.js export-events --config cfg.json --tenant <id> --out dataset.jsonl   # dataset rotulado (IP em hash)
node server/dist/cli.js eval dataset.jsonl --out relatorio.md      # precisa de `yarn build` antes
node server/dist/cli.js fit-model dataset.jsonl --out model.json   # aprende os parâmetros (precisa de centenas de aparelhos)
node server/dist/cli.js eval-identity dataset.jsonl --model model.json   # motor contra o hash original, em ordem de tempo
node server/dist/cli.js last-events --config cfg.json --tenant <id>   # últimas visitas e o IP que o servidor viu
node server/dist/cli.js reachability-receiver --db reach.db --port 8090 --allowed-origin https://app.exemplo.com   # recebe os avisos do carregador (coletor inalcançável); não grava IP
node server/dist/cli.js reachability-summary --db reach.db --days 30   # resumo desses avisos, em português
node server/dist/cli.js migrate-sqlite --from events.db --config cfg-mysql.json   # copia um SQLite para o MySQL e confere
node server/dist/cli.js delete-linked --config cfg.json --tenant <id> --linked-id <codigo>  # retirada de participante
docker build -f server/Dockerfile -t fingerprint-server .   # na raiz do repositório
```

`--ignore-engines` só existe porque o Node local é 22.22.0 e uma dependência de desenvolvimento pede 22.22.1.

## Regras que não se negocia

1. **Não mude as 42 fontes originais** em `src/sources/` nem o hash em `src/utils/hashing.ts`: o `visitorId` legado
   precisa continuar idêntico. Há um teste que compara o coletor com o agente original.
2. **Uma fonte de sinal não faz efeito colateral visível**: sem mensagem no console, sem DOM alterado, sem pop-up.
   Foi assim que o WebGPU virou opt-in. Se um sinal não puder cumprir, ele é opt-in.
3. **O cliente nunca calcula nem recebe identidade.** Ele manda sinais e recebe só um `requestId`.
4. **Licenças de terceiros**: só JA4 (TLS cliente, BSD 3-Clause) pode ser implementado. JA4H, JA4T, JA4X e os demais
   JA4+ são FoxIO License 1.1, que não permite monetização sem acordo OEM. Não implemente nem copie.
   Nada de código do produto Pro da Fingerprint. Detalhes na decisão D8.
5. **Privacidade é requisito de projeto**: coletar o mínimo, `exclude` para cortar sinais, retenção definida,
   `tenant_id` em todo dado desde o primeiro dia.
6. **Não afirme que algo é melhor que o Pro sem dizer como foi medido.** Sem harness de avaliação, não há número.
7. **Nunca faça commit, push, checkout, rename nem crie ou apague branch, a menos que o dono peça naquela mensagem: os commits
   e os branches são sempre do dono.** Só há um branch de trabalho, `v5.3.0-fork`. (Antes dessa regra, a IA criou dois branches
   `fase-N-...` sem pedido; o dono mandou juntar tudo em `v5.3.0-fork`.) Deixe o trabalho no diretório de trabalho e diga o que
   mudou. Comandos de git só de leitura (`status`, `diff`, `log`) são livres.
8. **No servidor, todo dado e toda leitura levam `tenantId`.** Não registre IP, payload nem chave em log. Chave secreta só
   existe como hash. Cabeçalho de IP só vale de proxy confiável, lido da direita.
9. **Impressões de ordem de cabeçalhos e de HTTP/2 só valem quando `viaProxy` é `false`.** Atrás de proxy elas descrevem o
   proxy e geram falso positivo. O JA4 só existe no modo direto (o servidor termina o TLS).
10. **Segurança se prova com teste que falha quando a defesa é removida.** Teste de mutação nas defesas é parte do fechamento
    de fase. E teste com cliente que não seja `127.0.0.1`: todos os clientes locais escondiam o pior defeito da Fase 2.
11. **Intervalo de confiança só por aparelho.** Nunca reporte uma taxa sem o número de **aparelhos** por trás. Pares que dividem
    um aparelho não são independentes (D18). Dado sintético só valida o harness e vem sempre marcado como tal.
12. **Nunca mostre uma probabilidade do motor sem calibração.** Sem modelo ajustado com dados rotulados, a resposta traz
    `calibrated: false` e `probability: null`. Não ajuste pesos, limiar nem escala com dado sintético: isso ajusta ao gerador (D29, D30).
13. **Propriedades do modelo são invariantes, com teste direto:** concordar nunca pesa contra, discordar nunca pesa a favor,
    o prior encolhe com a população, valor raro pesa mais que comum. Teste de mutação nelas é parte do fechamento.
14. **Adulteração é evidência, nunca veredito, e a cautela contra falsa acusação vem primeiro.** Toda verificação nova precisa
    de um teste do caso legítimo que não pode disparar, além do que a dispara (D35, D36). Lista vazia não prova que a visita é honesta.
15. **Laboratório de adversário: só navegadores do dono, e nenhuma ferramenta de evasão entra no repositório** (D40).
16. **O nginx do dono** está em `/Users/edgar/Repos/reverse-proxy-config` (VPS compartilhado, ~20 sites). Foi dada permissão
    para ler e, se preciso, adicionar coisas. Nada foi alterado até agora. Não reorganize a porta 443 nem os `sites/`
    sem pedido explícito. Decisão D14.
17. **Todo número de comportamento é parâmetro** (D41). Limite, limiar, janela, tamanho e política entram em
    `server/src/settings/parameters.ts`, com padrão, faixa e descrição, valem por tenant e se recarregam com `SIGHUP`.
    Depois regenere `docs/configuracao.md` (um teste falha se ela envelhecer). Nada de constante solta no código de decisão.

## Convenções de código

- ESLint com `--max-warnings 0`. Prettier: sem ponto e vírgula, aspas simples, 120 colunas, vírgula final.
- Ordem de imports alfabética com linha em branco entre grupos. Sem desestruturação com resto (`...rest`) em variáveis.
- Nos testes do navegador, nada de `!`. Use `defined()` de `tests/utils`.
- Alvo ES2018 no navegador. Não use API mais nova sem checar `docs/browser_support.md`.
- Funções que dependem de `window` só tocam nela dentro do corpo (o `check:ssr` quebra se tocarem no topo do módulo).

## Como adicionar um sinal ao coletor

1. Crie `src/collector/sources/<nome>.ts` com uma função de fonte (mesmo formato de `src/sources/`).
2. Registre em `src/collector/sources/index.ts`. Se tiver efeito colateral visível, coloque em `optInSourceNames`.
3. Crie `<nome>.test.ts` ao lado: teste a forma do resultado e, se for sinal de adulteração, simule a falsificação e restaure.
4. Documente na tabela de `docs/collector.md` (o que é, uso, ressalva).
5. Rode `yarn lint && yarn test:local && yarn build`.

## Ritual ao terminar uma fase

1. Rodar lint, testes, build e checagens do CI. Registrar o que **não** foi verificado (por exemplo Safari).
2. Rodar `/revisar` e corrigir tudo que for Crítico ou Maior antes de seguir.
3. Escrever `docs/plano/fases/fase-N-....md` (o que foi feito, como foi verificado, limites, o que ficou pendente).
4. Atualizar o status em `docs/plano/roadmap.md`, novas decisões em `docs/plano/decisoes.md` e este arquivo se mudou comando ou regra.
5. Só então começar a fase seguinte.

## Armadilhas do ambiente (macOS, zsh)

- `run` é alias no zsh desta máquina; não nomeie função de shell assim.
- Processos em segundo plano morrem quando a chamada de shell termina. Suba o servidor e use na mesma chamada.
- Antes de reiniciar um servidor de teste, mate pela porta (`kill $(lsof -tiTCP:PORTA -sTCP:LISTEN)`), senão sobra instância velha.
- `chrome --dump-dom` só mostra o documento de topo, não iframes.
- `.claude/` aparece como não rastreado; não é do projeto.
- Docker Desktop só enxerga caminhos sob `/Users`: um volume em `/private/tmp/...` chega vazio ao contêiner. Use `server/data/`
  (ignorado pelo git) para testes e apague depois.
- `node:sqlite` imprime `ExperimentalWarning` ao iniciar; é esperado.
- Certificado do Let's Encrypt é legível só por root, e o contêiner roda como `node` (uid 1000): copie com `chown 1000`.
- Ao testar HTTPS local com Chrome, use `--ignore-certificate-errors`; o servidor de teste precisa de CORS (`allowedOrigins`).
