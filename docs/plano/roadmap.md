# Roteiro

Atualizado em 2026-10-19. Status possíveis: pendente, em andamento, concluída, concluída com ressalvas.

## Meta e honestidade

Chegar a uma plataforma de identificação de visitantes equivalente ao Fingerprint Identification (Pro) onde for realista
e superior em dimensões **mensuráveis**: transparência, explicabilidade, privacidade por design, custo, adaptação a mudanças
de navegador, benchmark aberto. Nada é "melhor que o Pro" sem dizer como se mediu. Quase todas as fontes sobre o Pro vêm
da própria empresa. Os números do produto pago (99,5%, 1 bilhão de dispositivos por mês) são alegação do fornecedor.
A página técnica de precisão do fornecedor não diz a que taxa o 99,5% se refere nem sobre qual conjunto de dados (ver `01-pesquisa-e-fontes.md`, A1).

## Fechamento

Veja [06-fechamento-e-autocritica.md](06-fechamento-e-autocritica.md): verificação final, autocrítica, suposições e as perguntas que mudam o plano.

## Status das fases

| Fase | Conteúdo | Status | Relatório |
|---|---|---|---|
| Pesquisa (Etapas 1 a 3 do pedido) | Fontes, inventário completo, 22 ideias e 5 experimentos, riscos e conformidade | escrita; **pesquisa mais rasa que o pedido** (cerca de 30 buscas, uma página lida por inteiro) | [01](01-pesquisa-e-fontes.md), [02](02-inventario-de-capacidades.md), [03](03-ideias-inovadoras.md), [05](05-riscos-privacidade-e-compliance.md) |
| 0 | Fundação: harness de avaliação, dataset ético, linha de base da v5 | código concluído; **dados reais pendentes** (pré-requisito de qualquer número) | [fase-0](fases/fase-0-harness.md) |
| 1 | Coleta ampliada no cliente + coletor de sinais crus | concluída com ressalvas | [fase-1](fases/fase-1-coleta-ampliada.md) |
| 2 | Servidor de ingestão e sinais de rede (JA4, cabeçalhos, HTTP/2, IP) | concluída com ressalvas | [fase-2](fases/fase-2-ingestao.md) |
| 3 | Motor de matching e confidence score | código concluído; **parâmetros provisórios, sem dados reais** | [fase-3](fases/fase-3-matching.md) |
| 4 | Anti-adulteração e anti-replay (resultado selado) | código concluído; **contra navegadores anti-detecção profissionais não testado**; resultado selado não implementado (D38) | [fase-4](fases/fase-4-anti-adulteracao.md) |
| Config | Tudo configurável: tabela de parâmetros, camadas por tenant, recarga por `SIGHUP`, referência gerada (D41 a D45) | concluída; tamper e identidade já consomem os parâmetros | [configuracao](../configuracao.md) |
| 5 | Smart Signals (listas de IP, país, velocidade, risco composto, regras, comportamento opt-in) | código concluído; **pesos são palpites** | [fase-5](fases/fase-5-smart-signals.md) |
| 6 | SDK de Node, API de consulta, webhooks, painel, integração de primeira parte | código concluído | [fase-6](fases/fase-6-api-e-integracao.md) |
| 7 | Privacidade, LGPD e governança | código concluído; **textos jurídicos são modelos sem revisão** (adiada para o fim) | [fase-7](fases/fase-7-privacidade.md) |
| 8 | Escala, observabilidade, segurança e hardening; MySQL como banco de produção (D79 a D82) | código concluído; **medidas de carga de um notebook** | [fase-8](fases/fase-8-escala-e-operacao.md) |
| 9 | Diferenciais inovadores (deriva, coleta guiada, k-anonimato) | código concluído; **sem dados reais** | [fase-9](fases/fase-9-diferenciais-e-grafo.md) |
| SaaS | Multi-tenant isolado: tenants dinâmicos, planos, uso, cotas | código concluído; **sem faturamento, painel de cliente, DPA ou SLA** | [saas](fases/fase-saas-multitenant.md) |
| 10 | O que dava para fazer sem dados: juntar e separar aparelhos, robôs por DNS, código guardado, ambiente, vários servidores, busca em escala, listas de IP com colunas, migração para MySQL | código concluído; **sem número de precisão**; código guardado precisa de parecer | [fase-10](fases/fase-10-sem-dados.md) |
| Grafo | Grafo compartilhado entre clientes (D3) | mecanismo pronto, **desligado e travado**; sem parecer não liga | [grafo](privacidade/grafo-compartilhado.md) |

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
