# Riscos, privacidade e conformidade

> **Não é parecer jurídico.** É a análise de quem construiu o sistema, para levar a um advogado ou encarregado (DPO). Artigos de lei citados devem ser conferidos no texto oficial. As fontes e o que foi realmente lido estão em `01-pesquisa-e-fontes.md`. Modelos prontos para preencher: [privacidade/](privacidade/README.md).

## 1. Duas situações, dois papéis

| Situação | Quem é o controlador | O que muda |
|---|---|---|
| **Uso próprio** (o dono protege os sites dele) | O dono | Ele define a finalidade e a base legal; escreve o RIPD e a política |
| **SaaS isolado** (clientes usam a plataforma) | Cada cliente é controlador; o dono da plataforma é **operador** | Precisa de contrato de tratamento (DPA), instruções do controlador, lista de suboperadores e prazo de eliminação ao fim do contrato |
| **Grafo compartilhado** (D3) | Possivelmente **controladores conjuntos** | Não existe no código. Só com parecer, RIPD próprio e adesão contratual de cada cliente |

## 2. Base legal

| Base | Quando serve | Cuidado |
|---|---|---|
| **Legítimo interesse** (LGPD, art. 7º, IX e art. 10) | Prevenção a fraude e segurança, para quem opera no Brasil | Exige teste de balanceamento documentado; a ANPD diz que, se o teste for inconclusivo ou faltarem salvaguardas, outra base deve ser usada (A9). Modelo: `privacidade/lia-modelo.md` |
| **Consentimento** | Quando a regra do terminal exige (UE e Reino Unido) ou quando o teste de balanceamento falha | Livre, informado, específico e revogável. O sistema só **registra a declaração da página** (`consent`); o navegador não prova o consentimento |
| **Execução de contrato** | Dificilmente cobre fingerprinting de visitantes anônimos | Não usar como base principal |

**Escopo geográfico: só o Brasil (D83, decisão do dono em 2026-10-19).** O texto abaixo sobre UE e Reino Unido fica como nota para o caso de o escopo mudar; hoje não é requisito. Se o MySQL ficar fora do Brasil, vale a transferência internacional (LGPD art. 33).

**Regra do terminal (UE e Reino Unido), nota.** A diretriz 2/2023 da EDPB e o guia da ICO tratam o fingerprinting como acesso a informação do dispositivo do usuário, que em regra exige consentimento prévio, salvo exceções estreitas e avaliadas caso a caso (A7, A8). A exceção de "estritamente necessário" para segurança é discutível para fingerprinting de visitantes. **Recomendação de trabalho:** para visitantes da UE ou do Reino Unido, exigir consentimento (`privacy.requireConsent: true`) até haver parecer em contrário.

## 3. Princípios e onde o sistema os atende

| Princípio (LGPD, art. 6º) | Controle | Parâmetro | Lacuna |
|---|---|---|---|
| Finalidade | O sistema só decide sobre fraude; não exporta a terceiros; webhook vai ao próprio controlador | n/a | Contrato precisa proibir outros usos |
| Adequação e necessidade | Minimizar: `exclude` no cliente, `privacy.dropSignals`, `privacy.ipStorage` | `privacy.*` | Padrão `full` favorece detecção; o dono pode trocar |
| Livre acesso | Exportação por `linkedId` | `api.maxExportEvents` | Sem `linkedId` o servidor não liga dado a pessoa |
| Qualidade dos dados | Risco é heurística visível, não calibrada; sem veredito | `risk.*` | Falso positivo é risco real (seção 5) |
| Transparência | Política de privacidade (modelo); explicação por visita | n/a | O site precisa publicá-la |
| Segurança | Chaves por tenant (só hash no servidor), limite de tentativas, webhook assinado, painel sem armazenar a chave | `limits.*`, `audit.*` | Banco não é criptografado pelo servidor |
| Prevenção | Teste de mutação nas defesas; revisão a cada fase | n/a | Sem teste de intrusão externo |
| Não discriminação | Nenhuma característica sensível é usada de propósito | n/a | Pesos não calibrados podem ter efeito desigual; revisar com dados reais |
| Responsabilização | Registro de acessos, versão do texto de consentimento, esta documentação | `audit.*` | RIPD e LIA preenchidos faltam |
| Eliminação | Retenção por tenant, exclusão por API, órfãos apagados | `retention.*`, `api.allowDeletion` | Não alcança cópias de segurança |

## 4. Direitos do titular

Ver `privacidade/direitos-do-titular.md` (acesso, confirmação, eliminação, oposição, explicação de decisão automatizada). Ponto de atenção: **decisão automatizada** (LGPD, art. 20) dá ao titular o direito de pedir revisão. O sistema devolve fatores legíveis (`risk.factors`, `identity.explanation`, `decision.reason`) para viabilizar a revisão, mas **o controlador precisa prever o processo humano**.

## 5. Matriz de riscos

Gravidade e probabilidade são julgamentos do autor. "Residual" considera os controles já implementados.

| # | Risco | Gravidade | Probabilidade | Controles no sistema | Residual | O que falta |
|---|---|---|---|---|---|---|
| R1 | Falso positivo nega serviço a uma pessoa honesta | Alta | Média | Evidência e não veredito; verificações conservadoras; limiar é parâmetro; `learnFromTampered` | **Médio** | Medir a taxa com dados reais (Fase 0); processo de revisão humana do controlador |
| R2 | Reidentificação ou rastreamento indevido por IP e impressão | Alta | Média | `ipStorage`, retenção curta, ID aleatório por tenant, sem grafo compartilhado | Baixo a médio | Parecer sobre o uso do IP inteiro |
| R3 | Vazamento do banco de eventos | Alta | Baixa | IP em hash opcional; sem chaves secretas (só hash); ID de visitante aleatório | Médio | Criptografia em repouso do disco; cópias de segurança protegidas |
| R4 | Chave secreta de tenant vazada | Alta | Média | Revogação e troca sem janela (admin); limite de tentativas; auditoria com a chave usada | Baixo | Alertas de uso anômalo |
| R5 | Chave de administração vazada | **Muito alta** | Baixa | Hash no arquivo; limite de tentativas; não lê dados de tenant | Médio | Papéis mais finos; rotação documentada; MFA fora do escopo |
| R6 | SSRF por URL de webhook | Alta | Média no SaaS | Resolução e verificação de todos os endereços, sem redirecionamento, redes privadas bloqueadas | Baixo | Teste com um DNS real hostil |
| R7 | XSS no painel por dado de uma visita hostil | Alta | Média | `textContent` apenas, CSP sem inline, testado num Chrome real | Baixo | Só Chrome foi testado |
| R8 | Replay de um payload capturado | Média | Média | Nonce de uso único assinado; contexto do cliente como evidência | Baixo | Resultado selado não existe (não é risco aqui, D38) |
| R9 | Abuso de recursos (inundação, corpo grande, conexões lentas) | Média | Alta | Limites por IP e tenant, corpo máximo, tempos de espera | Médio | Limite em memória por processo; sem proteção de rede à frente |
| R10 | Uso para outra finalidade (marketing) | Média | Baixa | Sem exportação a terceiros; regras só de fraude | Baixo | Contrato |
| R11 | Dado retido além do necessário | Média | Média | Retenção por tenant; exclusão; órfãos | Baixo | Cópias de segurança |
| R12 | Falta de transparência com o visitante | Média | Média | Modelos de política e consentimento | Médio | O site precisa publicar e manter o texto |
| R13 | Mudança de navegador degrada a identificação sem aviso | Média | Alta | Evidência explicada; limiar parametrizado | Médio | Monitor de deriva (I2) |
| R14 | Licença: uso de JA4+ não livre | Média | Baixa | Só JA4 (BSD-3); regra 4 do `CLAUDE.md` | Baixo | Conferir o repositório da FoxIO antes de qualquer mudança |
| R15 | Grafo compartilhado ligado sem parecer | **Muito alta** | Baixa | Não existe no código; trava no `CLAUDE.md` | Baixo | Manter assim até o parecer |
| R16 | Transferência internacional (servidor ou cópia fora do Brasil) | Média | Média | Nenhum | **Aberto** | Definir onde o dado vive e a base legal |
| R17 | Uso do sistema para perseguir uma pessoa | Média | Baixa | `linkedId` é código interno, e-mail é recusado; sem busca por pessoa | Baixo | Política de uso aceitável no contrato |

## 6. Ética da coleta de dados reais (Fase 0)

A coleta de voluntários segue `protocolo-coleta-etica.md`: consentimento específico, retirada a qualquer momento (`delete-linked`), IP em hash na exportação, nenhum dado de terceiros. O texto de consentimento da página `tools/calibration` **é um modelo e precisa de revisão jurídica antes de ser usado com voluntários reais**.

## 7. Pendências para o fechamento

1. Revisão por advogado ou encarregado: texto de consentimento, LIA, RIPD e política (adiada, como o dono pediu).
2. Decidir a base legal por situação (seção 1) e por jurisdição do visitante.
3. Definir onde o dado e as cópias vivem (R16) e por quanto tempo vivem as cópias.
4. Contrato de tratamento (DPA) e política de uso aceitável, se houver SaaS.
5. Teste de intrusão externo antes de expor o servidor a terceiros.
