# Pesquisa e fontes

Data da pesquisa: 2026-10-19. Feita por busca na web (cerca de 30 buscas em temas distintos) e leitura de uma página do fornecedor. **Limites honestos:**

- Das fontes abaixo, **só a página de precisão do fornecedor foi aberta e lida por inteiro**. As demais foram vistas em resultados de busca, com resumo do trecho. Cada linha diz o que foi feito: **lida** ou **vista na busca**.
- O plano original pedia de 60 a 100 buscas. Foram cerca de 30. Ficaram sem cobertura própria: SEON e Sardine em detalhe, Incognia, Castle, Arkose, HUMAN, a Legiti, a Konduto atual e os trabalhos acadêmicos de 2023 a 2026 sobre aprendizado de similaridade.
- Nenhuma URL foi inventada: todas apareceram num resultado de busca ou de fetch desta sessão.
- Reputação: **alta** (norma, lei, órgão regulador, artigo revisado por pares, documento primário), **média** (fornecedor sobre o próprio produto, imprensa técnica), **baixa** (blog de concorrente, espelho, fórum).

## Achados que mudam o plano

| # | Achado | Efeito no plano |
|---|---|---|
| A1 | O número de 99,5% do Pro **não está** na página técnica de precisão. A página descreve o método (comparar identificação com e sem sinais determinísticos) e dá só um exemplo hipotético. O número aparece em página de perguntas frequentes e de marketing | Rotular sempre como "alegação do fornecedor". Nunca compará-lo com número nosso sem o mesmo método |
| A2 | O método do fornecedor define falso positivo como "identificado como **outro navegador existente**" e falso negativo como "tratado como novo". O ground truth é determinístico (cookie) | Nosso harness (Fase 0) usa o mesmo vocabulário, mas com ground truth de voluntários, não de cookie. Os dois números não são comparáveis |
| A3 | O fornecedor afirma que erros só ocorrem na identificação probabilística, e que o determinístico vem de cookie e armazenamento | Confirma a hipótese H4 do documento de referência |
| A4 | A documentação não afirma isolamento entre clientes, nem o contrário. Fala em retenção de 30 dias (padrão) e 90 ou mais (Enterprise) | H3 (o Pro cruza dados entre clientes) **continua não confirmada**. A pergunta vai ao fornecedor se for relevante |
| A5 | Resultados selados (criptografados) não impedem replay; a defesa é do backend. Webhooks têm assinatura | Nossa decisão D38 (não implementar selagem) é coerente. Já temos nonce de uso único e webhook assinado |
| A6 | Safari 26 liga a proteção avançada contra fingerprinting em **todas** as sessões, não só no modo privado. Firefox 145 unifica valores (núcleos, tela, toque) e diz cair de cerca de 35% para 20% o total de usuários únicos. Brave 1.93 esconde o modelo de GPU no WebGL/WebGPU (uma fonte secundária) | A estabilidade e a unicidade dos sinais vão cair com o tempo. Reforça o monitor de deriva (Fase 9) e a postura "evidência, não veredito" |
| A7 | A ICO (Reino Unido) publicou a versão final do guia sobre armazenamento e acesso, e lista fingerprinting entre as tecnologias cobertas; os resumos dizem que, salvo exceção, exige consentimento prévio | Para clientes no Reino Unido e na UE, o consentimento é o caminho mais seguro. `privacy.requireConsent` existe por isso |
| A8 | A EDPB (diretriz 2/2023, versão 2.0 de 7 de outubro de 2024) confirma que o art. 5(3) da ePrivacy vai além de cookies | Mesmo efeito de A7 |
| A9 | A ANPD publicou em fevereiro de 2024 o guia de legítimo interesse, com modelo de teste de balanceamento. Se o teste for inconclusivo ou faltar salvaguarda, outra base deve ser considerada | O `lia-modelo.md` segue a estrutura. Precisa de conferência com o texto oficial |
| A10 | O Chrome desistiu de remover cookies de terceiros (abril de 2025) e aposentou várias APIs do Privacy Sandbox (outubro de 2025). A IP Protection foi anunciada para o modo anônimo | Menos pressão de curto prazo no Chrome; o status da IP Protection em 2026 **não foi confirmado** |
| A11 | O FingerprintJS foi MIT até a v3, BSL 1.1 na v4 (julho de 2023), e voltou a MIT na v5 (outubro de 2025) | Confirma o que o histórico git já mostrava. O fork parte da v5.3.0 (MIT) |
| A12 | O BotD é MIT e a equipe diz que o roteiro próximo é só de estabilidade | Não contar com evolução do BotD. Nossa detecção de automação é própria |
| A13 | O JA4 (TLS cliente) é BSD 3-Clause; o restante do JA4+ está sob a FoxIO License 1.1 e exige acordo OEM para vender como produto | Confirma a decisão D8: só o JA4 |
| A14 | Fp-Scanner (USENIX Security 2018) mostrou que nenhuma contramedida da época mentia de forma consistente; inconsistências denunciam e às vezes recuperam o valor original | Base das verificações de consistência (Fase 4). Um estudo de 2024 acha regras de inconsistência no espaço e no tempo que reduzem a taxa de evasão de bots contra DataDome e BotD em 45% a 48% (resultado dos autores) |
| A15 | O FP-Stalker (2018) rastreou navegadores por 54 dias em média com 98.598 impressões de 1.905 navegadores; 26% passaram de 100 dias | É a linha de base acadêmica para "quanto tempo a identidade dura". Nossa Fase 0 deve medir com o mesmo método |

## Fontes

### Fornecedor (Fingerprint)

| Fonte | URL | Como foi usada | Reputação |
|---|---|---|---|
| Precisão e confiança (método dos dois conjuntos de dados) | https://docs.fingerprint.com/docs/identification-accuracy-and-confidence | **Lida.** A1, A2 | Média (fornecedor) |
| Perguntas frequentes | https://fingerprint.com/resources/frequently-asked-questions-faqs/ | Vista na busca. Onde aparece o 99,5% | Média |
| Entendendo o escore de confiança | https://dev.fingerprint.com/docs/understanding-your-confidence-score-v11 | Vista na busca. Determinístico contra probabilístico, tipos de erro (A3) | Média |
| Smart Signals: introdução e referência | https://docs.fingerprint.com/docs/smart-signals-introduction.md | Vista na busca. Sinais (bot, VPN, adulteração, anônimo), entregues só no servidor | Média |
| Obter inteligência no servidor | https://docs.fingerprint.com/docs/get-server-side-intelligence | Vista na busca. Resultado selado, API de eventos, webhooks (A5) | Média |
| Proteger de adulteração e replay | https://docs.fingerprint.com/docs/protecting-from-client-side-tampering | Vista na busca (A5) | Média |
| Identificar visitantes (retenção, cache) | https://docs.fingerprint.com/docs/identify-visitors | Vista na busca (A4) | Média |
| Detecção de navegadores anti-detecção | https://fingerprint.com/blog/anti-detect-browser-detection/ | Vista na busca. Alegação do fornecedor | Média |
| Safari 17: contornar a proteção de áudio | https://fingerprint.com/blog/bypassing-safari-17-audio-fingerprinting-protection/ | Vista na busca. Ruído de cerca de 0,001 por amostra | Média |
| FingerprintJS v5 em MIT | https://fingerprint.com/blog/fingerprintjs-version-5-0-mit-license/ | Vista na busca (A11) | Média |
| FingerprintJS: mudança de licença em 2023 | https://fingerprint.com/blog/fingerprintjs-license-change/ | Vista na busca (A11) | Média |

### Academia

| Fonte | URL | Achado | Reputação |
|---|---|---|---|
| FP-Stalker (IEEE S&P 2018) | https://hal.archives-ouvertes.fr/hal-01652021 | A15 | Alta |
| Hiding in the Crowd (WWW 2018) | https://hal.archives-ouvertes.fr/hal-01718234 | 2.067.942 impressões de um site francês; só 33,6% únicas, contra mais de 80% em estudos antigos. Impressões não únicas são frágeis | Alta |
| Fp-Scanner (USENIX Security 2018) | https://www.usenix.org/conference/usenixsecurity18/presentation/vastel | A14 | Alta |
| Evasão de bots por inconsistências (arXiv 2406.07647) | https://arxiv.org/abs/2406.07647 | A14 | Média (preprint) |
| Fingerprinting the Fingerprinters | https://arxiv.org/pdf/2008.04480 | Detectar o comportamento de scripts de fingerprinting | Média (preprint) |
| Ligação por limiar para prolongar a vida da impressão (tese, Sabancı) | https://research.sabanciuniv.edu/id/eprint/53631/ | 55,7 dias no melhor caso (alegação dos autores) | Média |
| Fellegi e Sunter, teoria da ligação de registros | https://cs.cornell.edu/~shmat/courses/cs6434/fellegi-sunter.pdf | Base do modelo de matching (Fase 3). O original de 1969 não foi aberto; resumos secundários | Alta (teoria), mas fonte secundária |
| Passive Fingerprinting of HTTP/2 Clients (Black Hat Europe 2017) | https://www.blackhat.com/docs/eu-17/materials/eu-17-Shuster-Passive-Fingerprinting-Of-HTTP2-Clients.pdf | SETTINGS, WINDOW_UPDATE, PRIORITY, ordem dos pseudo-cabeçalhos | Alta |
| Cover Your Tracks / Panopticlick | https://coveryourtracks.eff.org/about | 84% únicos em 2010 (meio milhão de navegadores). Dado de 2010 | Alta, mas antigo |

### Padrões e código aberto

| Fonte | URL | Achado | Reputação |
|---|---|---|---|
| JA4+ (resumo e licenças) | https://pypi.org/project/ja4plus/ | A13. Não foi o texto primário da FoxIO; **conferir o repositório da FoxIO antes de depender** | Média |
| JA4 explicado | https://www.peakhour.io/learning/fingerprinting/what-is-ja4-fingerprinting/ | Formato a_b_c; listas ordenadas antes do hash | Média |
| BotD | https://jsdelivr.com/package/npm/@fingerprintjs/botd | A12 | Média |
| CreepJS | https://github.com/lesc6/creepjs | É um fork, não o original; descreve detecção de "mentiras" por protótipo e incoerência entre APIs | Baixa (fork) |
| Listas de IP: AWS, Google Cloud, Tor | https://ip-ranges.amazonaws.com/ip-ranges.json, https://www.gstatic.com/ipranges/cloud.json, https://check.torproject.org/torbulkexitlist | **Baixadas e lidas pelo servidor em 2026-10-19** (Fase 5) | Alta |
| DB-IP Lite (país) | https://download.db-ip.com/free/dbip-country-lite-2026-10.csv.gz | **Baixado e lido** em 2026-10-19 (Fase 5). Licença do arquivo: conferir antes de redistribuir | Alta |

### Navegadores

| Fonte | URL | Achado | Reputação |
|---|---|---|---|
| Safari: proteção avançada | https://webkit.org/?p=15697 e https://9to5mac.com/?p=1011798 | A6. Ruído em canvas, WebGL e áudio, valores fixos de tela | Média a alta |
| Brave: randomização | https://brave.com/privacy-updates/3-fingerprint-randomization/ | "Farbling": ruído imperceptível por sessão e site | Alta (o próprio navegador) |
| Brave 1.93: GPU escondida | https://pasqualepillitteri.it/en/news/12529/brave-blocks-gpu-fingerprinting-webgl-webgpu | A6. **Fonte única e secundária** | Baixa |
| Firefox: proteção contra fingerprinting | https://support.mozilla.org/en-US/kb/resist-fingerprinting | A6 | Alta |
| Firefox 145 | https://ppc.land/firefox-cuts-fingerprinting-trackability-in-half-with-new-protections/ | 35% para 20% (segundo a Mozilla, via imprensa) | Média |
| Chrome: fim da remoção de cookies, IP Protection | https://thehackernews.com/2025/04/google-drops-cookie-prompt-in-chrome.html | A10 | Média |

### Regulação

| Fonte | URL | Achado | Reputação |
|---|---|---|---|
| EDPB, diretriz 2/2023 | https://edpb.europa.eu/system/files/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf | A8. **O PDF não foi aberto**; resumo de resultado de busca | Alta (o documento), mas lido só no resumo |
| ICO, guia de armazenamento e acesso | https://www.scl.org/ico-publishes-final-storage-and-access-technologies-guidance/ | A7. Resumo de terceiros; **conferir a página da ICO** | Média |
| ANPD, guia de legítimo interesse | https://www.mattosfilho.com.br/unico/anpd-legitimo-interesse-lgpd/ | A9. Resumo de escritório; **o guia oficial não foi aberto** | Média |

### Concorrentes e mercado (alegações dos próprios)

| Fonte | URL | Achado | Reputação |
|---|---|---|---|
| SEON, documentação de inteligência de dispositivo | https://docs.seon.io/getting-started/device-fingerprinting | Usa dados próprios, sem consórcio, e oferece regras explicáveis (alegação) | Média |
| SEON contra ThreatMetrix | https://seon.io/resources/comparisons/compare-seon-vs-threatmetrix/ | O diferencial do ThreatMetrix seria a rede de identidade compartilhada. **Marketing de concorrente** | Baixa |
| ClearSale e Cielo: fluxo do fingerprint | https://docs.cielo.com.br/risco/v1.0-en/docs/fingerprint-with-clearsale | Script no checkout, campo de fingerprint na análise, resposta aceitar, rejeitar ou revisar | Média |

## Hipóteses do documento de referência (H1 a H6)

| Hipótese | Estado depois da pesquisa |
|---|---|
| H1: o servidor guarda histórico e busca vizinho | Compatível com o fluxo documentado (determinístico mais probabilístico). **Não confirmada** como mecanismo interno |
| H2: adulteração por consistência entre camadas | Compatível com o Fp-Scanner e com a descrição do fornecedor (comparar com modelo estatístico) |
| H3: o Pro cruza dados entre clientes | **Não confirmada nem refutada** (A4) |
| H4: quase determinístico com armazenamento, probabilístico sem | **Sustentada** pela documentação (A3) |
| H5: a escala de dados calibra o modelo | Plausível; sem fonte. Nosso caminho é a calibração com dados rotulados (Fase 0) |
| H6: a expectativa realista fica entre a biblioteca gratuita e o Pro | Sem medida. O harness da Fase 0 existe para responder isso com dado real |
