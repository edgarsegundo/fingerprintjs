# Inventário de capacidades

Estado em 2026-10-19. "Feito" quer dizer código com testes; **nada aqui foi medido com dados reais** (a Fase 0 está sem dados). A coluna "Ganho" e "Risco" são julgamentos do autor, não medidas. Ordem de prioridade dentro de cada camada: (impacto × confiança) ÷ (custo × risco), em alta, média ou baixa.

Legenda do estado: **feito**, **parcial**, **pendente**, **não fazer**.

## Cliente (navegador)

| Capacidade | Estado | Onde | Ganho | Custo | Risco | Nota |
|---|---|---|---|---|---|---|
| 42 fontes originais, hash legado intacto | feito | `src/sources/` | base | n/a | baixo | Teste compara o coletor com o agente original |
| Coletor de sinais crus, sem identidade no cliente | feito | `src/collector/` | alto | médio | baixo | O cliente recebe só `requestId` |
| 9 sinais extras (worker, vozes, quota, mídia, integridade, automação, WebGPU, comportamento…) | feito | `src/collector/sources/` | médio | médio | médio | WebGPU e comportamento são opt-in |
| Desafio de uso único (nonce) | feito | `server/src/ingest/nonce.ts` | alto | baixo | baixo | Amarrado a rede, TLS e User-Agent como evidência |
| `exclude`, `include`, `consent` | feito | `src/collector/index.ts` | médio | baixo | baixo | Minimização no cliente |
| Mesmos sinais em iframe e worker | feito | `worker_context.ts`, `tamper/checks.ts` | médio | médio | médio | Service worker fora (D93): exige arquivo hospedado pelo site e persiste |
| Código guardado em cookie, local storage e IndexedDB | feito, **desligado por padrão** | `sources/stored_id.ts`, `identity/features.ts` | alto | médio | médio | D87: tenant liga e a página declara base legal (`consent` ou `legitimate_interest`). **Não medido**, e precisa de parecer jurídico. Sem ETag |
| SDKs de iOS e Android | pendente | n/a | alto no celular | alto | médio | Fora do escopo web atual |
| Coleta adaptativa ao risco (pedir mais sinais só quando suspeito) | feito | `app.ts` (perfil do desafio), `profileToOptions` | médio | médio | baixo | D76. Sem medida do ganho |

## Servidor e rede

| Capacidade | Estado | Onde | Ganho | Custo | Risco | Nota |
|---|---|---|---|---|---|---|
| Ingestão com limites, CORS, TLS e renovação de certificado | feito | `server/src/` | alto | médio | baixo | |
| JA4 (só TLS cliente, BSD-3) | feito | `server/src/tls/` | alto | médio | baixo | Só no modo direto (D9) |
| Impressão de cabeçalhos e de HTTP/2 | feito | `server/src/net/` | médio | médio | médio | Só vale com `viaProxy` falso |
| IP confiável por proxy, da direita | feito | `server/src/net/client_ip.ts` | alto | baixo | alto se errar | Bug real corrigido na Fase 2 |
| Rótulos de IP por lista (data center, Tor) e importadores | feito | `net/ip_lists.ts` | médio | baixo | baixo | AWS, Google Cloud, Tor lidos em 2026-10-19 |
| País do IP e fuso contra país | feito | `net/geo.ts`, `timezones.ts` | médio | baixo | médio | Geolocalização erra em celular e VPN |
| VPN comercial e proxy residencial | parcial | `net/ip_lists.ts` | alto | médio (dados pagos) | médio | Encaixe pronto para arquivos de faixas com colunas (D92); **o dado e o formato de um fornecedor específico não foram conferidos** |
| JA3, JA4H, JA4T | não fazer | n/a | n/a | n/a | licença | FoxIO License 1.1 (D8) |
| Impressão TCP/IP (p0f) | pendente | n/a | médio | alto | médio | Exige acesso ao pacote; só no modo direto |

## Identidade

| Capacidade | Estado | Onde | Ganho | Custo | Risco | Nota |
|---|---|---|---|---|---|---|
| Matching probabilístico (Fellegi-Sunter) com explicação contrafactual | feito | `server/src/identity/` | alto | alto | médio | Parâmetros **provisórios** |
| Perfil com todos os valores já vistos, ID aleatório por tenant | feito | `identity/store.ts` | alto | médio | baixo | |
| Calibração (Platt) com dados rotulados | feito (código) | `identity/fit.ts` | alto | médio | alto | **Sem dados reais** |
| Dois limiares (ligar e "possível ligação") | feito | `identity/engine.ts` | médio | baixo | baixo | Marca, não funde (D45) |
| Política de aprendizado com visita adulterada | feito | `settings` | médio | baixo | baixo | D44 |
| Corrigir ID depois (juntar e separar, por pessoa) | feito | `identity/edit.ts`, `engine.ts`, rotas `merge` e `split` | médio | alto | alto | D85. O motor nunca junta sozinho |
| Busca de candidatos que não cresce com a população | feito | `identity/*_store.ts` | alto em escala | médio | médio | D90: teto por valor e índice. Latência medida até 1 milhão de aparelhos inventados; **acerto em escala não medido**. LSH e índice vetorial seguem pendentes |
| Incerteza como distribuição, e não ponto | pendente | n/a | médio | alto | médio | Ideia I3 |

## Anti-adulteração

| Capacidade | Estado | Onde | Ganho | Custo | Risco | Nota |
|---|---|---|---|---|---|---|
| 16 verificações de consistência entre camadas | feito | `server/src/tamper/` | alto | alto | alto (falsa acusação) | Cada uma com teste do caso legítimo |
| Contra navegadores anti-detecção profissionais | **não testado** | n/a | alto | alto | alto | Dependem do produto deles, em contas do dono |
| Resultado selado | não fazer | n/a | baixo | médio | baixo | D38 |
| Modelo estatístico de impressão por versão de navegador | pendente | n/a | alto | alto | médio | O que o fornecedor descreve; precisa de dados |

## Smart Signals e decisão

| Capacidade | Estado | Onde | Ganho | Custo | Risco | Nota |
|---|---|---|---|---|---|---|
| Risco composto, desmontável, não calibrado | feito | `server/src/risk/` | médio | médio | médio | Pesos são palpites |
| Velocidade (contas por aparelho, aparelhos por IP) | feito | `identity/*_store.ts` | alto | médio | médio | CGNAT confunde |
| Regras de decisão configuráveis | feito | `risk/rules.ts` | alto | médio | baixo | Sem `eval` |
| Comportamento (contagens) | feito (opt-in) | `behavior.ts` | baixo a médio | baixo | médio (privacidade) | |
| Modo anônimo e máquina virtual (como fato do ambiente, peso 0) | feito | `server/src/environment/` | médio | médio | médio | D88. Jailbreak e root ficam fora (sem SDK de celular). Sinal de janela privada é fraco e envelhece |
| Robô de busca verdadeiro contra copia do nome | feito | `net/bots.ts` | médio | baixo | baixo | D86. Verificação por DNS; sem resposta do DNS é "não sei" |

## Plataforma

| Capacidade | Estado | Onde | Ganho | Custo | Risco | Nota |
|---|---|---|---|---|---|---|
| Multi-tenant (chaves, limites, configuração, recarga) | feito | `settings/`, `tenants/` | alto | médio | baixo | |
| API de consulta, webhooks assinados, painel, SDK de Node | feito | Fase 6 | alto | médio | baixo | SDK não publicado |
| Administração, planos, uso, cotas, suspensão | feito | `admin.ts` | alto (SaaS) | médio | baixo | Sem faturamento |
| Proxy de primeira parte (`basePath`, script próprio) | feito | `app.ts` | alto | baixo | baixo | |
| Painel com usuários e login | pendente | n/a | médio | alto | médio | |
| Várias instâncias sobre um MySQL | feito | `mysql/`, `webhooks/queue.ts`, `storage.ts` | alto em escala | alto | médio | D89. Só testado com duas instâncias |

## Engenharia, escala e operação

| Capacidade | Estado | Onde | Ganho | Custo | Risco | Nota |
|---|---|---|---|---|---|---|
| Testes (mais de 570 no servidor, 243 no navegador) e teste de mutação | feito | | alto | médio | baixo | |
| CI (lint, build, testes) | parcial | `.github/workflows/test.yml` | médio | baixo | baixo | Navegador no CI usa BrowserStack, que precisa de segredos |
| Métricas, prontidão, encerramento limpo | em andamento | Fase 8 | alto | baixo | baixo | |
| Teste de carga e medidas | em andamento | `tools/loadtest/` | alto | baixo | baixo | |
| Contadores incrementais para a escala da identidade | feito | `identity/*_store.ts` | alto em escala | médio | médio | D69 (SQLite, gatilhos) e D80 (MySQL, no código) |
| Banco de produção além do SQLite | feito | `server/src/mysql/` | alto em escala | alto | médio | MySQL, decisão D79. Ferramenta de migração do SQLite (D94) |

## Ciência de dados

| Capacidade | Estado | Onde | Ganho | Custo | Risco | Nota |
|---|---|---|---|---|---|---|
| Harness de avaliação com intervalo por aparelho | feito | `server/src/eval/` | alto | médio | baixo | Dado sintético só valida o código |
| Protocolo ético e página de coleta com consentimento | feito | `tools/calibration/`, `docs/plano/` | alto | médio | médio | **Dados reais pendentes** |
| Benchmark aberto reprodutível | pendente | n/a | alto | médio | médio | Ideia I7 |
| Relatório de deriva por característica | feito | `server/src/drift/` | alto | médio | baixo | D75. Dica para olhar, não alarme |
| Medir quem não alcança o servidor (carregador, aviso de falha, receptor sem IP, resumo, ASN opcional) | feito | `src/loader/`, `server/src/reachability/`, `server/src/net/asn.ts` | médio | médio | baixo | D96, D97. Causa é estimativa; Safari não testado |
| Porta 443 para o fingerprint (SNI, segundo IP, reserva) | só documentado | `docs/plano/usar-a-porta-443-...md` | médio | alto | **alto** | D98. Adiado por decisão do dono; nada testado |

## Privacidade e conformidade

| Capacidade | Estado | Onde | Ganho | Custo | Risco | Nota |
|---|---|---|---|---|---|---|
| Forma do IP, sinais descartados, consentimento declarado | feito | Fase 7 | alto | baixo | baixo | |
| Auditoria de acessos, exportação, exclusão | feito | Fase 7 | alto | médio | baixo | Não alcança cópias de segurança |
| Modelos de LIA, RIPD e política | feito (rascunho) | `docs/plano/privacidade/` | alto | baixo | alto se usados sem revisão | |
| Parecer jurídico | **pendente** | n/a | alto | n/a | alto | Adiado para o fim por decisão do dono |
| Grafo compartilhado entre clientes | pendente (D3) | n/a | alto | alto | **alto** | Só com parecer, RIPD próprio e opt-in |
