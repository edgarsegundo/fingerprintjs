# MySQL ou SQLite: a decisão e os cuidados em produção numa VPS compartilhada

Palavras-chave: MySQL, SQLite, banco de dados de produção, VPS compartilhada, Docker, `max_connections`, pool de conexões, retenção de eventos, espaço em disco, backup, LGPD, usuário e banco dedicados, migração, vizinho barulhento, escala, vários servidores.

Escrito em 2026-10-19. Este documento responde à pergunta "o MySQL é uma boa decisão ou exagero para produção?" e lista o que você precisa cuidar se for usá-lo na VPS onde já rodam cerca de 20 sites. Relacionados: decisões **D79 a D82**, **D89** e **D94** em `docs/plano/decisoes.md`, a seção "Moving from SQLite to MySQL" e "Several instances on one MySQL database" de `server/README.md`, e `docs/plano/fases/fase-8-escala-e-operacao.md`.

## 1. Resposta curta

É uma boa decisão para o seu caso, e não é exagero, principalmente porque você já tem um MySQL rodando na VPS. Mas para o começo o SQLite também bastaria. Dá para começar em um e mudar depois, sem perder histórico (`migrate-sqlite`).

## 2. Por que o MySQL faz sentido para você

- **Você já opera um.** Ele está no `docker-compose` da VPS, com backup e monitoramento que você já conhece. Subir um banco novo só para isso seria mais trabalho, não menos.
- **Cresce melhor.** O SQLite escreve um arquivo e bloqueia o processo do servidor por instantes a cada escrita. Isso é aceitável para poucos acessos, mas limita se o app crescer. O MySQL aguenta muita escrita ao mesmo tempo e permite **mais de um servidor ligado ao mesmo banco**, que é o que está implementado (vez do tenant no banco, reserva de webhooks, limites de taxa opcionais no banco).
- **Os dados são pesados.** Cada visita guarda o payload inteiro, cerca de **45 KB**. Um milhão de visitas é dezenas de GB. Um banco de verdade lida melhor com isso do que um arquivo.
- **Você já decidiu** ("não importa quantas visitas", decisão D79), e o código já tem tudo pronto para ele.

## 3. O que seria suficiente com SQLite

Para um PWA com cadastros, de dezenas a poucos milhares de visitas por dia, o SQLite daria conta sem problema. Seria mais simples: um arquivo, sem senha, sem rede. O projeto suporta os dois bancos com a mesma API, e o comando de migração copia tudo do SQLite para o MySQL depois.

| | SQLite | MySQL |
|---|---|---|
| Para que serve aqui | desenvolvimento, teste local, começo | produção |
| Instalação | nenhuma (vem com o Node 22) | você já tem na VPS |
| Escritas simultâneas | bloqueia o processo por instantes | aguenta muito mais |
| Vários servidores no mesmo banco | não | sim |
| Backup | copiar o arquivo (com o servidor parado ou com cuidado) | o que você já usa para o MySQL |
| Risco principal | limite de escala | afetar os outros sites que dividem o MySQL |
| Aviso do Node | `ExperimentalWarning` do `node:sqlite` | nenhum |

## 4. Os cuidados de usar o MySQL compartilhado da VPS

O MySQL da VPS é compartilhado com cerca de 20 sites. Esse é o ponto que mais merece atenção.

### 4.1 Banco e usuário só para isso

Nunca use o banco nem o usuário dos outros sites. Crie um par dedicado, com permissão **só** nesse banco. O servidor cria as tabelas na partida e faz alterações de esquema, então precisa de permissões de estrutura além das de dados:

```sql
CREATE DATABASE fingerprint CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'fp'@'%' IDENTIFIED BY 'uma-senha-longa-e-so-sua';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON fingerprint.* TO 'fp'@'%';
```

- O `'%'` depende de onde o servidor se conecta (de outro container, use o nome da rede do Docker; do próprio host, `localhost`). Restrinja ao mínimo possível.
- A lista de permissões acima vem da leitura do código (tabelas criadas na partida, passos de esquema com `ALTER TABLE` e `CREATE INDEX`). **Confirme subindo o servidor com esse usuário** antes de depender dela. Os testes do projeto precisam de mais (criam e apagam bancos), mas produção não.
- O banco usa `utf8mb4_bin` de propósito: as comparações de valor são exatas, sem ignorar maiúsculas nem acentos.

### 4.2 Senha fora do arquivo

A senha vem da variável de ambiente `FP_MYSQL_PASSWORD` (ou do nome em `passwordEnv`). Não coloque no arquivo de configuração. Exemplo do bloco de configuração:

```json
"database": {
  "type": "mysql",
  "host": "mysql",
  "port": 3306,
  "user": "fp",
  "database": "fingerprint",
  "connectionLimit": 6,
  "lockConnections": 4
}
```

### 4.3 Conexões (`max_connections`)

O MySQL da VPS foi configurado com `max_connections = 200`, dividido entre todos os sites.
- Cada servidor deste projeto abre até **`connectionLimit`** conexões de trabalho (padrão 10, máximo 100) e até **`lockConnections`** conexões à parte para as travas entre servidores (padrão 16, máximo 100).
- Com um servidor só, você pode baixar os dois (por exemplo 6 e 4) e ainda assim ter folga. Com N servidores, multiplique.
- Para conferir o uso real: `SHOW STATUS LIKE 'Threads_connected';` e `SHOW VARIABLES LIKE 'max_connections';`.
- Se os outros sites também usam muitas conexões, reduza as daqui antes de ter problema.

### 4.4 Espaço em disco e retenção

As visitas crescem rápido, e o disco da VPS é o mesmo dos outros sites. Se ele encher, derruba todos.

- **Estimativa:** cerca de 45 KB por visita. 1.000 visitas por dia por 30 dias são perto de **1,4 GB**. 10.000 por dia são perto de **14 GB**. Some índices e as tabelas de aparelhos: conte com **uns 30% a mais**.
- **Retenção:** `retention.eventsDays` (padrão **30**, de 1 a 3650). Passado o prazo, o evento é apagado, e o aparelho também se nenhum outro evento o usa. A limpeza roda na partida e a cada hora. Comece com um valor menor (por exemplo 7 a 14 dias) enquanto você não sabe o volume.
- Os webhooks guardam entregas por `webhooks.keepDoneHours` e `webhooks.keepFailedDays`, e a auditoria por `audit.retentionDays`.
- **Acompanhe o tamanho:**

```sql
SELECT table_name, ROUND((data_length + index_length) / 1024 / 1024) AS mb
FROM information_schema.tables
WHERE table_schema = 'fingerprint'
ORDER BY mb DESC;
```

- **Ponha um alerta** de disco da VPS (a VPS já tem Prometheus). Um alerta em 80% de uso evita a surpresa.

### 4.5 Backup e LGPD

- **Inclua o banco `fingerprint` no backup** que você já faz do MySQL, ou decida conscientemente que não vale a pena (os dados de visita se refazem com o tempo; as chaves e tenants estão no arquivo de configuração ou no banco, se você usar a API de administração).
- **Apagar não alcança o backup.** O direito de exclusão da LGPD (apagar por `linkedId` ou por visitante) remove do banco ativo, mas **não** das cópias de segurança. Defina por quanto tempo guarda os backups e escreva isso na política de privacidade (`docs/plano/privacidade/`).
- O IP é dado pessoal. Considere `privacy.ipStorage: "truncated"` ou `"hash"` se não precisar do endereço inteiro.

### 4.6 Vizinho barulhento

Se o seu app gerar muita carga, os outros sites sentem. Os sinais de que está na hora de separar: lentidão nos outros sites, `Threads_connected` perto de `max_connections`, ou o disco crescendo mais rápido que o previsto. O passo seguinte é um **MySQL em outro container**, só para este projeto, com seus próprios limites de memória e disco.

### 4.7 Versão e compatibilidade

- Exige **MySQL 8.0.19 ou mais novo** (a sintaxe de inserir-ou-atualizar usada). A VPS usa `mysql:8.0`, o que serve.
- **MariaDB não foi testado.** Não troque sem testar.
- O servidor se conecta por TLS se você ligar `ssl: true` (verifica o certificado). Dentro da rede do Docker na mesma VPS, em geral não é necessário. Se o MySQL ficar em outra máquina, ligue.

## 5. O que não está provado

- Medi cerca de **30 visitas por segundo** no MySQL em Docker no macOS, no meu notebook, com um tenant, e **não isolei a causa** desse teto. Para cadastros isso é muito mais do que você deve precisar, mas é uma medida de notebook, **não da sua VPS**.
- A latência da busca de candidatos foi medida até 1 milhão de aparelhos **inventados**: de 16 a 41 ms por decisão. É só velocidade (veja `busca-de-candidatos-v2-como-evoluir-com-dados-reais.md`).
- Foram testados dois servidores sobre o mesmo MySQL, e mais que isso não.
- Não foram testados: MariaDB, MySQL gerenciado (RDS, Cloud SQL), réplica de leitura e cluster.

## 6. Recomendação

1. **Servidor de teste:** use o SQLite, ou um MySQL de teste. Mais simples.
2. **Ao ir para produção:** use o MySQL, em um banco e um usuário **separados**, com a senha em `FP_MYSQL_PASSWORD`.
3. **No começo:** retenção curta (`retention.eventsDays` de 7 a 14), `connectionLimit` e `lockConnections` baixos, e olhando o espaço em disco toda semana.
4. **Antes de ligar o app de verdade:** coloque o banco no backup, defina por quanto tempo os backups ficam, e crie o alerta de disco.
5. **Se virar problema:** mova para um MySQL em outro container, só para este projeto.

## 7. Checklist antes de ligar em produção

- [ ] Criei o banco `fingerprint` e o usuário `fp` dedicados, com as permissões da seção 4.1.
- [ ] Subi o servidor com esse usuário e ele criou as tabelas sem erro.
- [ ] A senha está em `FP_MYSQL_PASSWORD`, não no arquivo.
- [ ] `connectionLimit` e `lockConnections` foram escolhidos pensando no `max_connections = 200` da VPS.
- [ ] `retention.eventsDays` está em um valor que o disco aguenta.
- [ ] Há um alerta de disco e eu sei rodar a consulta de tamanho das tabelas.
- [ ] O banco entra (ou conscientemente não entra) no backup, e a política de privacidade fala dos backups.
- [ ] Rodei a consulta `Threads_connected` e há folga.
- [ ] Sei o que fazer se a VPS ficar lenta (seção 4.6).
