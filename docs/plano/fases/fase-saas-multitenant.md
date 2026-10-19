# SaaS: tenants dinâmicos, planos, uso e cotas

Status: **código concluído; não há faturamento.** Branch `v5.3.0-fork` (sem commit).

A plataforma nasceu multi-tenant (o `tenant_id` está em todo dado, chave e índice), mas os tenants viviam só no arquivo de configuração. Esta etapa dá a quem vende o serviço o que precisa para operar sem reiniciar: criar, mudar, suspender e remover tenants, trocar chaves, ver o uso e limitar por cota. Tudo continua parametrizado (D41).

## O que foi feito

| Parte | O que faz | Onde |
|---|---|---|
| Tenants no banco | Criados e mudados pela API, junto aos do arquivo; o arquivo vence em conflito | `server/src/tenants/*` |
| API de administração | `/admin/v1/tenants` (listar, criar, ver, mudar, remover), chaves (adicionar, revogar), uso | `server/src/admin.ts` |
| Planos | `plans` no arquivo, numa camada entre `defaults` e o tenant | `server/src/settings/settings.ts` |
| Uso | Contadores por tenant, dia e métrica, e `GET /v1/usage` para o próprio tenant | `server/src/usage/meter.ts` |
| Cotas | `quota.collectsPerMonth` e `quota.apiReadsPerMonth`; 429 com `Retry-After` | `server/src/app.ts` |
| Suspensão | `status: suspended` impede coletar e deixa ler | `server/src/app.ts` |

## Como usar (resumo)

```bash
node server/dist/cli.js admin-key        # gera a chave de administração e o hash para o arquivo
```

```json
{ "adminKeySha256": ["..."], "tenants": [],
  "plans": { "free": { "quota": { "collectsPerMonth": 10000 } }, "pro": { "limits": { "collectPerMinutePerIp": 300 } } } }
```

```bash
curl -X POST $HOST/admin/v1/tenants -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"id":"loja","plan":"free","allowedOrigins":["https://loja.example"]}'
# devolve a chave pública e a secreta (esta, uma vez só)
```

## Como foi verificado

| Verificação | Resultado |
|---|---|
| Testes do servidor | 678 de 678 no fechamento (ver `06-fechamento-e-autocritica.md`) |
| Teste de mutação | Mais de 30 comportamentos quebrados de propósito (autenticação do admin, limite de chaves, última chave, confirmação de remoção, segredos escondidos, validação das configurações, remoção de dados, suspensão, cota, `Retry-After`, contagem, camada do plano, soma por dia) |
| Ponta a ponta | Tenant criado pela API coleta na hora; a chave dele não lê os dados de outro; reinício mantém tenants e dados; remoção apaga só o dele; cota zera no mês seguinte (relógio controlado) |

## O que NÃO foi verificado (ressalvas)

- **Não há faturamento.** Há contagem de uso e cota; preço, fatura, nota fiscal e pagamento são do dono.
- **Um processo só.** Duas instâncias do servidor sobre o mesmo banco disputariam a fila de webhooks e teriam cache de tenants diferentes.
- **Cota é conferida no momento do pedido.** Pedidos simultâneos no limite podem passar um pouco dele.
- **Painel de cliente** com usuários e login não existe. O painel é de quem tem a chave secreta.
- **Contrato (DPA), SLA e onboarding jurídico** são documentos, não código.
- **Papéis no administrador.** Toda chave de administração faz tudo.

## O que o dono precisa decidir

1. O preço e a forma de cobrança.
2. O que cada plano inclui.
3. Quem guarda a chave de administração e como ela é trocada.
