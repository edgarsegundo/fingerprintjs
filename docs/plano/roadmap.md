# Roteiro

Atualizado em 2026-10-17. Status possíveis: pendente, em andamento, concluída, concluída com ressalvas.

## Meta e honestidade

Chegar a uma plataforma de identificação de visitantes equivalente ao Fingerprint Identification (Pro) onde for realista
e superior em dimensões **mensuráveis**: transparência, explicabilidade, privacidade por design, custo, adaptação a mudanças
de navegador, benchmark aberto. Nada é "melhor que o Pro" sem dizer como se mediu. Quase todas as fontes sobre o Pro vêm
da própria empresa. Os números do produto pago (99,5%, 1 bilhão de dispositivos por mês) são alegação do fornecedor.
O 99,5% cobre só falsos positivos, não falsos negativos.

## Status das fases

| Fase | Conteúdo | Status | Relatório |
|---|---|---|---|
| Pesquisa (Etapas 1 a 3 do pedido) | Fontes, inventário completo, 20 ideias inovadoras | **pendente** (não escrita) | |
| 0 | Fundação: harness de avaliação, dataset ético, linha de base da v5 | código concluído; **dados reais pendentes** (pré-requisito de qualquer número) | [fase-0](fases/fase-0-harness.md) |
| 1 | Coleta ampliada no cliente + coletor de sinais crus | concluída com ressalvas | [fase-1](fases/fase-1-coleta-ampliada.md) |
| 2 | Servidor de ingestão e sinais de rede (JA4, cabeçalhos, HTTP/2, IP) | concluída com ressalvas | [fase-2](fases/fase-2-ingestao.md) |
| 3 | Motor de matching e confidence score | código concluído; **parâmetros provisórios, sem dados reais** | [fase-3](fases/fase-3-matching.md) |
| 4 | Anti-adulteração e anti-replay (resultado selado) | código concluído; **contra navegadores anti-detecção profissionais não testado**; resultado selado não implementado (D38) | [fase-4](fases/fase-4-anti-adulteracao.md) |
| 5 | Smart Signals (bot, VPN, automação, consistência) | pendente | |
| 6 | SDKs, API de eventos, webhooks, painel, proxy de primeira parte | pendente | |
| 7 | Privacidade, LGPD e governança | pendente (o essencial entra antes, ver abaixo) | |
| 8 | Escala, observabilidade, segurança e hardening | pendente | |
| 9 | Diferenciais inovadores | pendente | |
| SaaS | Multi-tenant isolado: faturamento, onboarding, painel por cliente, DPA, SLA | pendente | |
| Grafo | Grafo compartilhado entre clientes (D3) | pendente, com trava jurídica | |

Ordem do uso próprio ao SaaS: 0, 1, 2, 3, 4, 5, 6, 7, SaaS, 8, Grafo, 9. A Fase 0 deveria vir antes da 3, porque o
motor de matching não se calibra sem dados rotulados. A Fase 7 não pode esperar até o fim: retenção, `tenant_id` e
pseudonimização entram já nas fases 2 e 3.

## Critérios de aceite por fase

Os limites numéricos abaixo são metas iniciais sem dados por trás. Devem ser revistos com a linha de base da Fase 0.

| Fase | Critérios mensuráveis |
|---|---|
| 0 | Script reproduzível que, dado um conjunto de visitas rotuladas, produz estabilidade em 1, 7 e 30 dias, unicidade e curva ROC do hash legado, com intervalo de confiança. Dataset coletado com consentimento. Testes do harness no CI. **Feito**: o script, e os testes dele rodam no CI. **Falta**: o dataset real e a linha de base medida com ele. |
| 1 | Hash legado idêntico ao original (teste). Zero mensagem de console por fonte padrão. 229 testes verdes em Chrome e Firefox. **Falta**: verde em Safari e Android (BrowserStack). |
| 2 | Ingestão rejeita payload inválido, nonce reusado, corpo grande e excesso de taxa. JA4 bate com o vetor da especificação e com o hash de cifras do Chrome publicado. IP real só é aceito de proxy confiável. Retenção apaga eventos antigos. **Falta**: implantação num VPS Linux, Firefox e Safari por TLS, teste de carga. |
| 3 | Taxa de falso positivo e de falso negativo medidas na Fase 0 e reportadas por navegador. Confidence score calibrado (erro de calibração reportado). Busca de candidatos em tempo limitado definido na fase. **Feito**: o motor, a explicação, o ajuste e a avaliação online. **Falta**: rodar o ajuste e a avaliação com dados reais, escolher o limiar pelo custo e confirmar a calibração em dados novos. |
| 4 | Payload reaproveitado é rejeitado. Resultado selado só abre no servidor do cliente. Testes com adversário próprio (ativos próprios, em ambiente controlado). **Feito**: reenvio barrado, desafio amarrado ao cliente, 15 verificações, laboratório com 4 casos no Chrome do dono. **Falta**: navegadores anti-detecção profissionais, Safari/Firefox/Android reais, taxa de falsa acusação em escala. O resultado selado foi dispensado (D38). |
| 5 | Cada Smart Signal com taxa de acerto e de falso positivo medida contra o laboratório de adversário. |
| 6 | SDK instalável e documentado, webhook com assinatura, proxy de primeira parte que não é bloqueado pelas listas de filtro testadas. |
| 7 | RIPD, teste de legítimo interesse, política de privacidade, fluxo de direitos do titular e retenção testados. |
| 8 | Metas de latência e de disponibilidade definidas e medidas sob carga. Rotação de chaves testada. |

## Hipóteses sobre o Pro (a validar, não são fatos)

Origem: documento de referência, seções marcadas "Inferência".

- H1: o servidor guarda histórico e busca o visitante mais parecido. A Fase 3 testa se essa arquitetura funciona.
- H2: a adulteração é detectada por consistência entre camadas. Fase 4 e 5.
- H3: o Pro cruza dados entre clientes. Não confirmado em nenhuma fonte lida.
- H4: quase determinístico quando consegue persistir um identificador, probabilístico quando não.
- H5: a escala de dados serve para calibrar os modelos.
- H6: o resultado realista fica entre a biblioteca gratuita e o Pro.

## Limites reais (não prometemos superar)

Safari, Firefox e Brave reduzem ou randomizam sinais. Aparelhos idênticos só se separam por rede e comportamento.
Escala de dados é vantagem de volume do Pro, não de técnica.
