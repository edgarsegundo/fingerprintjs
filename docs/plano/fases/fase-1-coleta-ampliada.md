# Fase 1: coleta ampliada no cliente

Status: concluída com ressalvas. Branch `fase-1-coleta-ampliada`, nada commitado.

## O que foi feito

- **Coletor** em `src/collector/`: `collect()` devolve um payload com os 42 componentes originais mais os sinais extras, sem `visitorId`. `send()` faz POST e devolve só `{ requestId }`. `collectAndSend()` junta os dois. Não pinga o CDN do fornecedor.
- **Sinais extras** (`src/collector/sources/`): `workerContext` (página contra Web Worker), `speechVoices`, `storageQuota`, `notificationPermission`, `mediaSupport`, `nativeIntegrity`, `automationHints`. `webGpu` existe, mas é opt-in (D7).
- **Opções**: `nonce` (desafio do servidor, base do anti-replay), `exclude` (minimização), `include` (liga sinais opt-in).
- **Contrato** do payload e do servidor em [docs/collector.md](../../collector.md). Schema versão 1.
- **Receptor de desenvolvimento** `tools/dev-receiver.js`: emite nonce de uso único, valida e devolve só `requestId`.

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do navegador (Chrome 155 e Firefox 152 headless) | 229 de 229, três execuções seguidas sem instabilidade |
| Lint, `check:dts`, `check:ssr` | limpos |
| Hash legado | teste compara componente a componente com o agente original: idêntico |
| Ponta a ponta em Chrome real | 42 + 7 componentes, nonce aceito, reenvio, nonce ausente e schema desconhecido rejeitados |
| CSP restritiva | coleta termina, worker aparece como indisponível, `exclude` evita o erro de CSP |
| Revisão cética (`/revisar`) | 0 críticos, 1 maior (console do WebGPU), corrigido com D7 |

Tamanho: bundle IIFE minificado de 37 KB para 46 KB, e de 16,3 KB para 19,3 KB gzip (+3 KB). Payload cerca de 45 KB, metade das imagens do canvas.

## Achados que importam para as próximas fases

- O Chrome 155 headless sem flags **não** é pego por `navigator.webdriver` nem pela divergência de notificação. As pistas de automação só pegam automação descuidada.
- `navigator.webdriver` não existe em Workers. Não compare esse campo entre contextos.
- `undefined` some no JSON e `NaN` vira `null`. O servidor deve tratar ausência como "indefinido".
- Dentro de iframe `sandbox` sem `allow-same-origin`, o `load().get()` original também não termina. Limitação anterior, herdada.

## O que NÃO foi verificado (ressalvas)

- Safari, Android e Samsung Internet. Os testes `nativeIntegrity` e `workerContext` esperam listas vazias e valores iguais; podem falhar por diferenças legítimas nesses navegadores. Rodar no BrowserStack (precisa dos segredos do CI).
- WebGPU com adaptador real: o ambiente de teste não tinha GPU, só o caso "sem adaptador" foi exercitado.
- Nenhuma medida de estabilidade ou unicidade. Isso é a Fase 0.

## Pendências

- Decidir se manda o hash das imagens do canvas no lugar das imagens (economiza 23 KB, mas tira do servidor a detecção do ruído de canvas do Brave). Decidir na Fase 3.
- O `load()` ainda tem o ping de monitoramento. Remover ao decidir o nome do fork.
