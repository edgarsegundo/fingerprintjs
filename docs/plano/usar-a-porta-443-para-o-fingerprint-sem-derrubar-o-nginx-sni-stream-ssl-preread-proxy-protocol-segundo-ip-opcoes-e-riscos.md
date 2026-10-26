# Usar a porta 443 para o fingerprint sem derrubar o nginx: SNI com stream, PROXY protocol, segundo IP, porta de reserva, opções e riscos

Palavras-chave: porta 443, porta 8443 bloqueada, nginx `stream`, `ssl_preread`, SNI, PROXY protocol, segundo IP, IP secundário, `docker-compose` `ports`, porta de reserva (fallback), `viaProxy`, JA4, `id.empregoaqui.com.br`, VPS compartilhada, janela de manutenção, rollback, risco.

Escrito em 2026-10-19. **Estado: só documentação.** Nada deste documento foi implementado ou testado, e nada foi alterado no seu `reverse-proxy-config`. A decisão do dono, no mesmo dia, foi **não arriscar** o servidor que hospeda cerca de 20 sites em produção (D98). Este documento existe para que a opção não se perca e para decidir com número na mão: antes de qualquer uma, rode a medição da Parte H do guia da VPS (`detectar-bloqueio-da-porta-8443-e-do-coletor-aviso-de-falha-loader-receptor-asn-lgpd.md`). Se `script_unreachable` for pequeno, **nada disto vale o risco**.

> **Aviso.** Os trechos de configuração abaixo vêm do que eu sei do nginx e da leitura dos seus arquivos. **Nenhum foi executado.** Antes de usar qualquer um, teste fora da produção e confira cada diretiva na documentação da versão do nginx que você roda.

## 1. Por que o fingerprint está na 8443

O servidor de fingerprint precisa **terminar o TLS ele mesmo** (opção A do `server/README.md`). Só assim ele vê o início da conexão do visitante, de onde saem o JA4, a ordem dos cabeçalhos e a impressão HTTP/2. Atrás do nginx, esses sinais descreveriam o nginx (regra 9 do `CLAUDE.md`), e o servidor marca `viaProxy: true` e os ignora.

E a porta 443 é do seu nginx. Pelo seu `docker-compose.yml`, o container `nginx` publica `80`, `443/tcp`, `443/udp` e `8883`, e os 21 arquivos de `sites/` têm 33 linhas `listen 443 ssl;` / `listen [::]:443 ssl;` e algumas `listen 443 quic;`. Dois servidores não escutam a mesma porta no mesmo endereço. Por isso o fingerprint ficou na 8443.

O custo: redes que só liberam a 443 (algumas empresas, escolas, hotéis, operadoras) não alcançam o servidor. Quantas são, **ninguém sabe ainda**: é o que a Parte H mede.

## 2. As quatro rotas, em uma tabela

| Rota | Mexe no nginx dos outros sites? | Mantém o JA4 e os sinais de rede? | Custo | Risco |
|---|---|---|---|---|
| **A. Ficar na 8443** (hoje) | Não | Sim | Nenhum | Alguns visitantes não alcançam |
| **B. Porta de reserva pelo nginx** (443, com proxy) | **Só acrescenta** um arquivo em `sites/` | **Não**, só para quem usar a reserva | Código novo no carregador (`fallbackEndpoint`) e um servidor sem TLS | **Baixo** |
| **C. Segundo IP público** | **Uma linha** do `docker-compose.yml` (o `ports:` do nginx) | Sim | Um IP extra do provedor | **Médio** (se errar, cai tudo) |
| **D. SNI com `stream` (uma 443 para tudo)** | **Sim, todos os 21 arquivos** | Sim | Código novo (PROXY protocol), horas de teste | **Alto** |

Minha recomendação, se a medição pedir: **B primeiro**, **C** se o provedor vende IP extra, **D** só se nenhuma das duas servir. Explico cada uma.

## 3. Rota B: o nginx como porta de reserva

**A ideia.** O fingerprint continua na 8443 com TLS próprio, para quem alcança. Para quem **não** alcança, o carregador tenta de novo por um endereço que passa pelo nginx, na 443. Aí os sinais de rede daquela visita (JA4, ordem de cabeçalhos, HTTP/2) se perdem, e o servidor os trata como `viaProxy: true`, mas **o resto do fingerprint e o IP funcionam**. Para o seu objetivo (contar contas por aparelho), uma visita sem os sinais de rede é muito melhor do que nenhuma visita.

**O que mexe no nginx.** Um arquivo **novo** em `sites/`, para `id.empregoaqui.com.br`, escutando na 443 como qualquer site novo. Nada nos 21 arquivos existentes. Esse arquivo já é parecido com o que o guia pede para o certificado (Parte D), com um `location /` a mais:

```nginx
# NÃO TESTADO. Reserva do fingerprint pela 443.
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name id.empregoaqui.com.br;

    ssl_certificate     /etc/letsencrypt/live/id.empregoaqui.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/id.empregoaqui.com.br/privkey.pem;

    location / {
        resolver 127.0.0.11 valid=10s;
        set $fp http://fingerprint-reserva:8080;   # outro container, sem TLS
        proxy_pass $fp;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

**O que falta construir:**

1. Uma segunda instância do servidor de fingerprint **sem TLS** (`listen` na 8080, sem `tls`), no mesmo MySQL (vários servidores sobre um MySQL funcionam, D89), `trustedProxies` apontando para o nginx. O servidor já suporta isso (opção B do `server/README.md`).
2. No carregador, uma opção `fallbackEndpoint`: quando o primeiro endereço falha (`script_unreachable` ou `request_unreachable`), tentar o segundo. **Isso não existe hoje.** É pequeno, com testes, mas é código novo.
3. O script do coletor também tem de ser servido pela reserva (o `collectorFile` da instância nova).

**Riscos.** Para o nginx, é o mesmo gesto de adicionar qualquer site novo (`nginx -t`, recarregar). A reserva tem a mesma origem (`allowedOrigins`) e a mesma chave. A visita passa a poder vir por dois caminhos. Os sinais de rede **entram no motor** como características (`tlsCiphers`, `tlsExtensions`, `tlsVersionAlpn`, `headerOrder`, `http2`, em `server/src/identity/features.ts`); pela reserva elas ficam ausentes, e uma característica ausente não pesa contra o aparelho, mas ele passa a ser reconhecido só pelas demais. Teste com a mesma pessoa pelos dois caminhos antes de confiar nos números.

## 4. Rota C: um segundo IP público

**A ideia.** Seu provedor vende (muitos vendem) um IP extra para a VPS. O nginx continua com o IP atual na 443. O fingerprint escuta **a 443 do IP novo**, direto, com TLS próprio. O DNS de `id.empregoaqui.com.br` aponta para o IP novo.

**O que muda no `docker-compose.yml`.** Hoje o nginx publica `"443:443/tcp"`, que significa "em todos os endereços da máquina". Para o fingerprint usar a 443 do IP novo, o nginx tem de passar a publicar **só no IP antigo**:

```yaml
# NÃO TESTADO. IP1 = o IP atual; IP2 = o IP novo.
  nginx:
    ports:
      - "80:80"
      - "IP1:443:443/tcp"
      - "IP1:443:443/udp"
      - "8883:8883"
  fingerprint:
    ports:
      - "IP2:443:8443"
```

Mais: configurar o IP novo no sistema da VPS (o provedor diz como), abrir a 443 no firewall dele, e criar o registro `A` de `id` para o IP novo (e **não** criar `AAAA`, a menos que o IPv6 também esteja tratado).

**Riscos.**
- **Se o `IP1` estiver errado ou o IP mudar, o nginx deixa de escutar e cai tudo.** Recriar o container `nginx` com a nova publicação são alguns segundos de indisponibilidade de todos os sites. Faça em janela combinada.
- Coisas que consultam `localhost:443` deixam de responder. No `reverse-proxy-config` que li, o `validar-infra.sh` conecta pelo nome do domínio (continua funcionando), e não achei outra dependência da 443 em `localhost`, mas **procure em tudo que roda na VPS** (monitoramento, healthchecks de fora do repositório).
- O IP extra costuma ter custo mensal. O JA4 e os sinais de rede se mantêm, porque o fingerprint termina o TLS.
- Tem de ser um IP **público de verdade**, não um segundo endereço atrás de NAT.

## 5. Rota D: uma só 443, dividida por SNI (`stream`)

**A ideia.** Seu `nginx.conf` já tem um bloco `stream { include /etc/nginx/stream.d/*.conf; }` (hoje só serve o MQTT na 8883). O nginx pode **olhar o nome do site no início da conexão TLS** (`ssl_preread`, o SNI) sem decifrar, e decidir: se for `id.empregoaqui.com.br`, entrega a conexão **crua** ao servidor de fingerprint; senão, entrega ao nginx de sempre, em uma porta interna. O fingerprint termina o TLS e vê o JA4. A 8443 deixaria de existir.

**O desenho:**

```
visitante ──► 443 (stream, ssl_preread) ──┬─► id.empregoaqui.com.br → fingerprint:8443 (TLS dele)
                                          └─► o resto             → nginx http, porta interna 8444
```

**O problema central: o IP do visitante.** Numa conexão TCP entregue crua, quem recebe vê o endereço do nginx, não o do visitante. A solução padrão é o **PROXY protocol**: o nginx escreve uma linha no começo da conexão dizendo o IP real. Mas:

1. **O servidor de fingerprint não entende PROXY protocol hoje.** Teria de ser implementado: ler a linha antes do TLS, aceitar **só** do endereço do nginx, e entregar o resto ao TLS sem atrapalhar a leitura do início do handshake que gera o JA4. É código delicado, com testes e mutação, e uma falha de aceitar o cabeçalho de qualquer um permitiria forjar o IP.
2. **Os 20 sites também precisam do IP.** Se o nginx http passa a receber as conexões do `stream`, ele também vê só o IP interno. Todo `listen 443 ssl;` teria de virar `listen 8444 ssl proxy_protocol;`, e o bloco `http` ganharia `set_real_ip_from` e `real_ip_header proxy_protocol;`. Sem isso, logs, limites de taxa e o fail2ban de **todos** os sites passam a ver o IP errado.
3. No `stream`, `proxy_protocol on;` vale para o servidor inteiro, não por destino. Então o fingerprint **receberia** a linha mesmo se você não quisesse, o que reforça o item 1.

**O que muda nos arquivos existentes:** os 21 arquivos de `sites/` (33 linhas `listen`), `nginx.conf`, e o `docker-compose.yml`. O QUIC/HTTP3 (`443/udp`) continuaria sendo do bloco `http`, sem `stream`, e o `Alt-Svc` seguiria valendo.

**Perguntas que eu não respondi:**
- A imagem `macbre/nginx-http3` que você usa foi compilada com `ssl_preread`? (`docker exec nginx nginx -V 2>&1 | grep -o with-stream_ssl_preread_module`.) Eu não verifiquei.
- Como o `realip` e o HTTP/3 se comportam juntos nessa imagem.
- Se o mesmo `stream` na 443 e o bloco `http` na 8444 conviverão com o `reuseport` que um dos seus arquivos usa.

**Riscos.** É a única rota em que **um erro derruba todos os sites ao mesmo tempo**: um arquivo esquecido, ou `proxy_protocol` ligado em um lado e não no outro, e o handshake falha para tudo. Dá para reduzir com `nginx -t`, janela combinada, cópia dos arquivos e um teste por site, mas o risco continua sendo o de mexer na porta de todos por causa de um recurso. **Meu conselho é só fazer se B e C não servirem.**

## 6. O que NÃO fazer, em qualquer rota

- Não mexa nos arquivos de `sites/` nem no `docker-compose.yml` do nginx sem uma **janela combinada** e um jeito rápido de voltar (cópia dos arquivos, `git` do repositório do proxy, e o comando exato de reverter escrito antes).
- Não recarregue o nginx sem `docker exec nginx nginx -t` antes. Um erro no teste significa que **nada foi aplicado**.
- Não use `restart` do container `nginx` para "aplicar" mudança de configuração: use `nginx -s reload`. Um `restart` com configuração quebrada deixa todos os sites fora.
- Não use nomes de container como destino de `proxy_pass` sem o truque de variável + `resolver` (como nos exemplos), senão um container parado impede o nginx de **subir**.

## 7. Como decidir

1. Rode a Parte H do guia da VPS por 3 a 4 semanas.
2. Calcule a fração: `script_unreachable` ÷ cadastros do período (veja H7 do guia).
3. Olhe **de que redes** vêm (com o arquivo de ASN, se tiver).
4. Se for pouco, pare aqui.
5. Se for relevante e vier de operadoras grandes, escolha a rota: **B** se quiser evitar qualquer mudança nos outros sites; **C** se o provedor vende IP extra e você aceita uma janela curta; **D** só com o PROXY protocol implementado e testado fora da produção.
6. Qualquer que seja, registre a decisão em `decisoes.md` e atualize o guia da VPS.

## 8. Referências

- Medição: `detectar-bloqueio-da-porta-8443-e-do-coletor-aviso-de-falha-loader-receptor-asn-lgpd.md`.
- Instalação: `instalar-na-vps-passo-a-passo-id-empregoaqui-com-br-docker-tls-mysql-certificado-letsencrypt-coletor-no-pwa-fase-de-observacao.md`.
- Vender a vários clientes (CNAME, SNI por cliente): `vender-para-varios-clientes-dominio-do-cliente-cname-subdominio-first-party-ja4-sni-certificado-por-cliente-proxy-do-cliente.md`.
- Opções de implantação A e B do servidor: `server/README.md`, "How to deploy".
- Decisões: D14 (nginx do dono), D96 a D99.
