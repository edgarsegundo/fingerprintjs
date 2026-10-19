# Atender os pedidos de um titular

> Procedimento de trabalho. Conferir prazos e formalidades com o encarregado (DPO). O controlador é quem atende o titular; o servidor dá as ferramentas.

**Como achar os dados de uma pessoa.** O servidor guarda o `linkedId` que o site enviou (um código interno da conta, nunca e-mail ou nome). Procure pelo `linkedId` da conta do titular. Se o site não envia `linkedId`, os dados não podem ser ligados a uma pessoa pelo servidor, e o titular precisa fornecer um identificador de visitante.

| Pedido | O que fazer | Ferramenta |
|---|---|---|
| Confirmar se há tratamento | Listar as visitas do `linkedId` | `GET /v1/events?linkedId=...` |
| Acesso aos dados | Exportar tudo que há sobre o `linkedId`, com a resolução de identidade | `GET /v1/subjects/export?linkedId=...` |
| Informação sobre decisão automatizada | Mostrar o risco, os fatores e a explicação da visita, que são legíveis | `GET /v1/events/:id` (`risk.factors`, `identity.explanation`, `decision.reason`) |
| Eliminação | Apagar visitas, entregas de webhook que as citam e aparelhos sem visita | `DELETE /v1/subjects?linkedId=...` ou `DELETE /v1/visitors/:id` |
| Oposição | Apagar (como acima) e impedir nova coleta para a conta, no site | site do controlador |
| Correção | Os dados são técnicos e vêm do navegador; não há o que corrigir. Se uma decisão foi errada, corrija a decisão no sistema do controlador | n/a |

**Cuidados**

- A exportação inclui o registro inteiro da visita, o que contém o endereço IP na forma em que foi guardado. Entregue ao titular por canal seguro.
- Exclusão apaga do banco, mas **não** de cópias de segurança já feitas. Documente o prazo em que as cópias expiram.
- Cada exportação e exclusão fica no registro de acessos (`GET /v1/audit`), que é a prova de que o pedido foi atendido. O registro não guarda o conteúdo.
- Se `api.allowDeletion` estiver desligado, a exclusão pela API é recusada (403). Use isso quando quiser forçar um procedimento com mais controle.
- A exportação corta em `api.maxExportEvents` visitas e avisa com `truncated: true`. Aumente o limite ou pagine por período.
