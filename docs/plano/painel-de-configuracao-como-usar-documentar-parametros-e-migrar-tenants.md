# Painel de configuração: como usar, como documentar um parâmetro e como migrar os tenants para o banco

Palavras-chave: painel de configuração, `/dashboard/config`, chave de operador `adm_`, helptip, explicação de parâmetro, `help.ts`, `help_pending.ts`, `import-tenants`, `migrate-tenants.sh`, tenants no banco, `keepReadOnly`, restaurar padrão.

Escrito em 2026-10-26 (Fase 1 do plano do painel). O que **não** existe ainda está na última seção.

## 1. Para que serve

Cada ajuste do servidor (`identity.learnFromTampered`, `tamper.severity`, `risk.levels.high`, `retention.eventsDays`...) era feito
editando o `config.json` na VPS. Duas dores: nada explicava o que cada valor faz, e o `init-config.sh` apagava as edições.

O painel mostra **os 111 parâmetros**, agrupados por tema, cada um com:

- um **helptip** (`?`): resumo, e "Ver explicação completa" com *o que é*, *quando aumentar*, *quando diminuir*, *casos de uso*,
  *cuidado* e *o que usar enquanto só coleta amostras*;
- o valor atual, o **padrão**, a faixa permitida e de onde o valor vem (este tenant, o plano, os padrões do arquivo);
- **Restaurar padrão**, erro ao lado do campo (no navegador e pelo servidor) e **confirmação em dois passos** para parâmetros
  de cuidado (`attention`) e que exigem base legal (`legal`).

Ele fica em `https://id.empregoaqui.com.br:8443/dashboard/config` e entra com a **chave de operador** (`adm_...`), que fica só na
memória da página. O painel de visitas continua em `/dashboard/` com a `sk_` do tenant.

## 2. Migrar os tenants do arquivo para o banco (uma vez)

Hoje `pwa` e `teste` estão no `config.json`. Tenant de arquivo **não** pode ser editado pela API (`managed_by_file`). Na VPS:

```bash
cd ~/Repos/fingerprintjs
git pull && ./rebuild.sh        # o container precisa conhecer o comando import-tenants
./migrate-tenants.sh            # digite: migrar
```

O script: simula a cópia, guarda `config.json.pre-import-<data>`, copia os tenants para o banco **com as mesmas chaves** (a
`pk_` do PWA não muda e a `sk_` antiga continua valendo), gera a chave de operador, tira `tenants` do arquivo, reinicia e
confere. Se o servidor não ficar saudável, **volta o arquivo antigo sozinho**. A chave de operador aparece **uma vez**: guarde no
gerenciador de senhas (ele oferece gravar no `.env` como `FP_ADM_KEY`; a opção 8 do `help.sh` a mostra).

Depois disso o `init-config.sh` **não gera mais tenants** (eles vivem no banco) e **recusa** sobrescrever um `config.json` que
ainda liste tenants, para ninguém perder chave.

Ensaiado com SQLite: mesma `pk_`, a `sk_` antiga devolve 200, o tenant vem do banco, é editável e a retenção de 60 dias foi preservada.
**O script em si não foi rodado contra o MySQL da VPS.**

## 3. Documentar um parâmetro (a documentação evolui junto com a parametrização)

Dois arquivos em `server/src/settings/`:

- `help.ts`: um objeto `parameterHelp` indexado pelo caminho do parâmetro, com `title`, `summary`, `what`, `raise`, `lower`,
  `useCases`, `caution`, `whileCollecting` e `flags` (`legal`, `attention`, `restart`, `preview`).
- `help_pending.ts`: os parâmetros que ainda **não** têm explicação longa. **Só pode encolher.**

Para documentar `x.y`: escreva a entrada em `parameterHelp` e **tire** `'x.y'` de `helpPending`. O teste de cobertura falha se um
parâmetro não estiver em nenhum dos dois, se estiver nos dois, ou se citar um caminho que não existe. **Um parâmetro novo sem
explicação quebra o teste**: é o que obriga a escrever a ajuda junto com o parâmetro. Sem entrada, o painel mostra o resumo da
tabela com o aviso "a explicação completa ainda está sendo escrita".

Hoje: 29 de 111 documentados (os que você mexe agora: aprendizado, adulteração, risco, retenção, privacidade, limites, regras).

Parâmetros só de leitura no painel (`readOnlyParameters`): `webhooks.endpoints`, porque guarda segredos que o servidor nunca
devolve. Ao salvar, o painel manda `keepReadOnly: true` e o servidor **preserva** o que o tenant tem neles; um `"[hidden]"`
enviado de volta é recusado (`hidden_placeholder`).

## 4. Rotas novas (chave de operador)

| Rota | Função |
|---|---|
| `GET /admin/v1/parameters` | Catálogo com tipo, faixa, padrão, ajuda e cobertura |
| `GET /admin/v1/tenants/:id/settings` | O que o tenant define, o que herda, o valor em vigor e de onde vem cada um |
| `PATCH /admin/v1/tenants/:id` | Já existia; ganhou `keepReadOnly` e a recusa de `"[hidden]"` |

## 5. O que ainda não existe (Fases 2 a 5 do plano)

- **Histórico, anotação e desfazer.** Hoje salvar substitui; a auditoria só guarda *quais campos* mudaram.
- **Editor de regras** (`rules.list`): hoje é um campo de JSON.
- **Pré-visualização** do efeito antes de aplicar (só será possível para risco, regras e adulteração; a decisão de identidade é gravada na hora e não dá para reproduzir).
- Perfis prontos, glossário nas colunas do painel de visitas, valor real ao lado do parâmetro, exportar e importar.
- **Não testado:** Safari, leitor de tela, o painel em tela de celular, e o `migrate-tenants.sh` e o `import-tenants` contra o MySQL de produção.

## 6. Segurança

A chave de operador enxerga e altera **todos** os tenants. Fica só em memória (sem `localStorage`), há limite de tentativas por IP
e a CSP não permite script embutido. Mesmo assim ela é exposta na porta 8443: guarde-a como senha de root e, se não for usar o painel por
um tempo, tire `"dashboard": true` do `config.json`.
