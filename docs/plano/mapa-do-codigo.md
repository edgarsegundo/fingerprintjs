# Mapa do código (Etapa 0)

Leitura direta do repositório em 2026-10-17, versão 5.3.0, base `dac5ae5`. O que é "presumo" está marcado.

## Arquitetura da biblioteca original

- `load()` em `src/agent.ts`: dispara `monitor()` (ping para `m1.openfpcdn.io` em 0,1% das cargas, desligável com `monitoring: false`), espera `requestIdleCallback` e carrega as fontes.
- `src/utils/entropy_source.ts`: cada fonte tem duas fases, "load" (uma vez) e "get" (a cada chamada). Cada componente vira `{value | error, duration}`. `loadSources(fontes, opções, excluir)` é o ponto de extensão reaproveitado pelo coletor.
- `get()` devolve `visitorId` (preguiçoso), `confidence`, `components`, `version`.
- Hash: string canônica com chaves ordenadas e `JSON.stringify`, depois MurmurHash3 x64 de 128 bits (`src/utils/hashing.ts`). Correspondência exata: qualquer componente diferente muda o ID. Erro vira a string `error`.
- `src/confidence.ts`: constante por plataforma (Android 0,4; Safari 0,3 ou 0,5; Windows 0,6; macOS 0,5; outros 0,7). Não é calibrada. O campo `comment` é um anúncio do Pro.
- Detecção de navegador sem User-Agent, contando recursos (`src/utils/browser.ts`). Envelhece a cada versão de navegador.
- Build Rollup 3 (IIFE, UMD, CJS, ESM, d.ts), alvo ES2018. Testes Karma + Jasmine; localmente Chrome e Firefox headless, no CI BrowserStack.
- CI: `test.yml` e `check_upcoming_browser_versions.yml` (testa betas de navegador em dias úteis; semente de um futuro monitor de drift).

## As 42 fontes por grupo (estimativas de estabilidade e entropia são "presumo")

| Grupo | Fontes | Estabilidade | Entropia | Risco |
|---|---|---|---|---|
| Render | canvas, webGlBasics, webGlExtensions | média | alta | Ruído no Safari 17+ e no Firefox 120+ (imagens puladas). Lista de parâmetros muda com driver. |
| Áudio | audio, audioBaseLatency | média | média | Pulado no Safari 17+ e Samsung 26+. Timeout em segundo plano. |
| Fontes | fonts (52 fontes), fontPreferences | média | alta | Instalação de software, zoom. |
| UA e plataforma | userAgentData, platform, vendor, vendorFlavors, osCpu, cpuClass, architecture | baixa a média | média | `platformVersion` muda a cada atualização do sistema e quebra o hash exato. |
| Hardware | hardwareConcurrency, deviceMemory, screenResolution, screenFrame, colorDepth, touchSupport | média | média | Monitor externo, dock. Pulado no Safari 17+ e Firefox 143+. |
| Locale | timezone, languages, dateTimeLocale | média | média | Viagem, VPN. |
| Preferências CSS | colorGamut, invertedColors, forcedColors, monochrome, contrast, reducedMotion, reducedTransparency, hdr | alta | baixa | Acessibilidade, troca de monitor. |
| Armazenamento e recursos | sessionStorage, localStorage, indexedDB, openDatabase, cookiesEnabled, pdfViewerEnabled, plugins, applePay, privateClickMeasurement | alta | baixa | Modo privado. |
| Motor JS | math (24 funções) | alta | baixa | Versão do motor. O bug do `sinhPf` foi mantido de propósito (#1191 revertido em #1194) para não quebrar IDs. |
| Bloqueadores | domBlockers (só Safari e Android) | baixa | média | Listas de filtro mudam. |

Colisões: iPhones do mesmo modelo e versão tendem a colidir, porque canvas, áudio e tela são pulados no Safari 17+.

## Pontos de extensão

Exports em `src/index.ts`: `sources`, `loadSources`, `transformSource`, `hashComponents`, `componentsToDebugString`, `getUnstable*`, `withIframe`, `murmurX64Hash128`. O `load()` não aceita fontes de fora. Por isso o coletor chama `loadSources` direto.

## Dívidas e fraquezas conhecidas

1. ID por hash exato, sem memória (o `docs/comparison.md` admite instabilidade acima de cerca de 2 semanas).
2. Tudo no cliente: falsificável e reproduzível.
3. Erro transitório vira a string `error` e muda o hash.
4. Heurísticas de navegador exigem manutenção manual.
5. ID só estável dentro da mesma versão menor (`docs/version_policy.md`).
6. Ferramental datado (ESLint 8, typescript-eslint 5, Rollup 3). Testes reais dependem de BrowserStack.
7. `plugins.ts` não tem teste.
8. O `load()` pinga o CDN do fornecedor em 0,1% das cargas. O coletor não pinga.
9. Dentro de iframe com `sandbox` sem `allow-same-origin`, nem o `load().get()` original termina (verificado na Fase 1).

## Licença

Resolvido em [decisoes.md](decisoes.md), D1.
