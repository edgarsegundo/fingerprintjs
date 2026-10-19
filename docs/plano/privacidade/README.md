# Privacidade e LGPD: modelos e procedimentos

> **Estes são modelos de trabalho, não parecer jurídico.** Foram escritos por quem implementou o sistema, para o dono levar a um advogado ou encarregado (DPO). Os artigos da LGPD citados devem ser conferidos no texto da lei antes do uso. A revisão jurídica foi deixada para o fim do plano, por escolha do dono.

| Arquivo | Para quê |
|---|---|
| [lia-modelo.md](lia-modelo.md) | Teste de legítimo interesse (LIA) para a prevenção a fraude |
| [ripd-modelo.md](ripd-modelo.md) | Relatório de impacto à proteção de dados, com os riscos do sistema |
| [politica-de-privacidade-modelo.md](politica-de-privacidade-modelo.md) | Texto para a política de privacidade de quem usa o sistema |
| [direitos-do-titular.md](direitos-do-titular.md) | Como atender cada pedido de um titular com as ferramentas do servidor |

## O que cada configuração faz pelos princípios

| Princípio (LGPD, art. 6º) | Parâmetro ou recurso | Padrão |
|---|---|---|
| Necessidade (usar o mínimo) | `privacy.dropSignals`, `privacy.ipStorage`, `exclude` no coletor | Tudo coletado, IP inteiro |
| Finalidade e adequação | `rules.*` só decide sobre fraude; o servidor não envia dado a terceiros | n/a |
| Livre acesso e qualidade | `GET /v1/subjects/export` | Ligado |
| Segurança e prevenção | Chaves por tenant, `audit.*`, webhooks assinados, painel sem armazenamento da chave | Ligado |
| Não discriminação | O risco é heurística visível e não calibrada; a decisão é do cliente, não do servidor | n/a |
| Responsabilização | `audit.*`, `consent` registrado, esta documentação | Auditoria ligada |
| Eliminação | `retention.eventsDays`, `DELETE /v1/subjects`, `DELETE /v1/visitors/:id` | 30 dias |

Os valores padrão favorecem a detecção de fraude. **Para um cliente que quer postura mais conservadora (o escopo do projeto é só o Brasil, D83)**, comece por `privacy.ipStorage: "truncated"` ou `"hash"`, `retention.eventsDays` curto e `privacy.requireConsent: true`.

## O que o sistema não resolve sozinho

- **A base legal é do controlador** (o dono do site, e o dono da plataforma quando ele mesmo usa). O sistema registra a declaração da página, mas o navegador não consegue prová-la.
- **Código guardado no navegador** (`identity.storedId`, D87): um identificador persistente gravado no aparelho do titular (cookie, local storage e IndexedDB). É dado novo para o texto de privacidade, o RIPD e o LIA: o que é, onde fica, por quanto tempo (até 400 dias), que o titular pode apagar os dados do site, que a página só o grava com `consent.basis` de `consent` ou `legitimate_interest` e que o servidor guarda só um resumo dele. Desligado por padrão. O parecer jurídico deve dizer se `legitimate_interest` basta para um identificador gravado no aparelho (no Brasil o consentimento é a opção mais segura) e se o texto da página precisa de um aviso antes.
- **Verificação de robôs por DNS** (`bots.verify`): quando o User-Agent afirma ser um robô de busca, o endereço do visitante é enviado ao servidor de DNS que a máquina usa. Mencione na política se for ligado.
- **Fingerprinting no navegador na UE** (fora do escopo atual, que é só o Brasil; nota para o caso de mudar) pode exigir consentimento pela regra do armazenamento e acesso a informações do terminal (ePrivacy, art. 5(3)), mesmo que a LGPD admita legítimo interesse. Isso precisa de parecer.
- **Grafo compartilhado entre clientes (D3)** não existe no código e só deve existir com parecer favorável, RIPD próprio e opt-in contratual de cada cliente.
- **Transferência internacional**: se o servidor ou o backup ficar fora do Brasil, é preciso base própria.
