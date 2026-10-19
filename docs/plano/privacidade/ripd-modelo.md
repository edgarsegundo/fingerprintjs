# Relatório de impacto à proteção de dados (RIPD): modelo

> Modelo de trabalho para o art. 38 da LGPD. Conferir com advogado ou DPO. Preencher o que está entre `[colchetes]`.

**Operação:** identificação de visitantes para prevenção a fraude. **Controlador:** [..]. **Operador (se SaaS):** [..]. **Versão/data:** [..].

## 1. Descrição do tratamento

| Item | Descrição |
|---|---|
| Dados | Sinais técnicos do navegador e do aparelho (tela, fontes, GPU, idioma, fuso, recursos do navegador), sinais da conexão (impressão TLS JA4, ordem de cabeçalhos, versão do HTTP), endereço IP, horário, `linkedId` do controlador |
| Origem | Coletados no navegador do visitante por um script da página, e lidos da conexão pelo servidor |
| Finalidade | Prevenção a fraude e segurança |
| Base legal | [legítimo interesse (LIA em anexo) / consentimento] |
| Compartilhamento | Nenhum com terceiros. Webhooks enviam um resumo da visita **ao próprio controlador** |
| Local e operador | [servidor, país, provedor] |
| Retenção | `retention.eventsDays` = [n] dias; auditoria `audit.retentionDays` = [n] |
| Titulares | Visitantes dos sites do controlador |

## 2. Fluxo (resumo)

Navegador → script de coleta → `POST /v1/collect` (com desafio de uso único) → servidor guarda o evento e atribui um identificador de visitante **por tenant** → backend do controlador lê o resultado com a chave secreta → decisão do controlador.

## 3. Riscos e medidas

| Risco | Gravidade | Medida no sistema | Risco residual |
|---|---|---|---|
| Falso positivo nega serviço a pessoa honesta | Alta | Resultado é evidência e risco **heurístico não calibrado**; verificações conservadoras contra falsa acusação; decisão é do controlador | Médio: exige revisão humana do controlador |
| Reidentificação por IP | Média | `privacy.ipStorage` (truncado, hash ou nenhum), retenção curta | Baixo com `hash` ou `truncated` |
| Vazamento do banco | Alta | Chave por tenant; IP em hash opcional; identificador de visitante aleatório (não deriva do aparelho); [criptografia em repouso do disco] | Médio: depende da infraestrutura |
| Acesso indevido pela API | Alta | Chave secreta por tenant (só o hash fica no servidor); limite de tentativas; auditoria de acessos | Baixo |
| Uso para outra finalidade (marketing) | Média | Sem exportação para terceiros; regras só de fraude; contrato | Baixo |
| Rastreamento entre clientes | Alta | Identificador por tenant; grafo compartilhado **não existe** | Baixo hoje |
| Falta de transparência | Média | Política de privacidade (modelo em anexo); explicação por visita (`explanation`) | Baixo |
| Dado retido além do necessário | Média | Retenção por tenant; exclusão por API; órfãos apagados | Baixo |
| Discriminação por característica do aparelho | Média | Sem uso de característica sensível; revisão dos pesos quando houver dados | Médio até haver dados reais |

## 4. Direitos dos titulares

Ver [direitos-do-titular.md](direitos-do-titular.md).

## 5. Parecer e aprovação

Encarregado: [..]. Data: [..]. Próxima revisão: [..]. Pendências jurídicas: [consentimento na UE; transferência internacional; contrato com operador].
