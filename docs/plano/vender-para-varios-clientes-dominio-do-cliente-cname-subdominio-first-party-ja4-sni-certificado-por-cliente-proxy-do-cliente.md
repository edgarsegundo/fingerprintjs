# Vender para vários clientes: o domínio do cliente, CNAME, subdomínio first-party, JA4, SNI, certificado por cliente e proxy do cliente

Palavras-chave: SaaS, multi-tenant, vários clientes, domínio próprio do cliente, CNAME, subdomínio first-party, mesmo site, terceiros (third-party), bloqueadores de rastreamento, JA4, sinais de rede, TLS, SNI, certificado por cliente, Let's Encrypt, ACME, Cloudflare, proxy do cliente, `trustedProxies`, `viaProxy`, `allowedOrigins`, `collectorPath`, `basePath`, cookies, LGPD, operador de dados, onboarding de cliente.

Escrito em 2026-10-19. Este documento registra **como entregar o endereço do servidor aos clientes quando você vender o serviço**, qual forma recomendo e o que o projeto ainda não faz. **Hoje nada disso é necessário**: para o seu próprio PWA, o guia da VPS (`instalar-na-vps-passo-a-passo-id-empregoaqui-com-br-...md`) basta. A decisão D84 registra que o SaaS fica como está, sem investimento novo, até você decidir vender.

---

## 1. Como o serviço enxerga os visitantes de um cliente

Você **não tem acesso ao site do cliente nem aos visitantes dele**. Quem coleta é **o seu script, rodando dentro do navegador do visitante**, e é o cliente quem coloca esse script na página dele. É o mesmo modelo do Google Analytics, do reCAPTCHA e do Stripe.js.

```
Visitante abre loja.com ──▶ a página carrega o seu script ──▶ o script roda NO NAVEGADOR do visitante
                                                              │
                                  o navegador do visitante ───┘ manda os sinais ──▶ SEU servidor
```

Consequências:

- Você só vê os visitantes **cujas páginas carregam o seu script**.
- Você não recebe o conteúdo do site, formulários, cookies do cliente nem a URL (o payload do coletor não leva URL).
- Você recebe o que o navegador do visitante lê sobre si mesmo, mais os dados da **conexão dele com o seu servidor**.
- O cliente não manda dados de rede para você.

## 2. De onde vêm os dados de rede

O visitante abre **duas** conexões diferentes: uma com o site do cliente (`loja.com`) e outra com o **seu** servidor (o coletor). Os dados de rede (**JA4**, ordem dos cabeçalhos, configurações do HTTP/2 e o **IP real**) são características **da conexão com o seu servidor**. Quem termina uma conexão TLS vê o início dela, os cabeçalhos como foram enviados e o endereço de origem.

Importa, então, **onde a conexão do visitante termina**:

| Como o navegador chega até você | Quem termina o TLS | Dados de rede que você vê |
|---|---|---|
| Seu domínio (`fp.seuproduto.com`) | seu servidor | todos |
| Subdomínio do cliente com CNAME para você (`id.loja.com`) | seu servidor, com o certificado de `id.loja.com` | todos |
| O servidor do cliente repassa para você (`loja.com/fp/`) | o servidor do cliente | só os dele (`viaProxy: true`). O IP real chega por um cabeçalho que o cliente escreve. |
| Uma CDN na frente (por exemplo o proxy da Cloudflare) | a CDN | só os da CDN |

Quando o servidor detecta que há alguém no meio (`viaProxy`), ele **não usa** a ordem de cabeçalhos nem o HTTP/2 para comparar visitas, porque descreveriam o proxy e dariam falso positivo. O JA4 só existe quando o próprio servidor termina o TLS (ou quando um proxy **confiável** calcula o JA4 e o repassa em um cabeçalho, o que o projeto aceita por `ja4Header`, mas o nginx comum não calcula JA4).

## 3. As formas de entregar o endereço ao cliente

### Forma 1: um domínio seu para todos

Exemplo: `fp.seuproduto.com`, com um nome por cliente como alternativa (`cliente1.seuproduto.com`).

| | |
|---|---|
| Vantagens | Simples. Um certificado (ou um por nome, mas sob seu controle). É o que o projeto faz hoje. |
| Desvantagens | Para o site do cliente, o endereço é **de terceiros** (third-party): bloqueadores de rastreamento desconfiam mais. A reputação do domínio é **compartilhada**: um cliente que abusa pode prejudicar todos. |
| Sinais de rede | Todos. |

### Forma 2 (a recomendada para vender): subdomínio do cliente com CNAME para você

O cliente cria, no DNS dele, uma linha como esta (em um **subdomínio**, nunca no domínio puro):

```
id.loja.com   CNAME   cliente1.seuproduto.com
```

`cliente1.seuproduto.com` é um nome seu, que aponta para o seu servidor. Seu servidor apresenta um certificado para `id.loja.com`.

| | |
|---|---|
| Vantagens | O endereço é **do mesmo site** do cliente (first-party): bem menos bloqueio. O cliente faz **uma linha de DNS**, nada mais. Você mantém **todos** os sinais de rede. É o modelo que fornecedores desse tipo costumam oferecer. |
| Desvantagens | Exige **um certificado por cliente**, emitido e renovado automaticamente, e o servidor precisa escolher o certificado pelo nome pedido (**SNI**). **O projeto ainda não faz isso.** |
| Sinais de rede | Todos. |

### Forma 3 (alternativa secundária): o servidor do cliente repassa para você

O cliente configura o servidor dele (nginx, CDN, Apache) para repassar um caminho, por exemplo `loja.com/fp/`, ao seu servidor.

| | |
|---|---|
| Vantagens | 100% no domínio do cliente, **sem DNS novo**. Útil para quem não pode ou não quer mexer em DNS. O projeto já tem `basePath` e `collectorPath` para isso (decisão D57). |
| Desvantagens | Você **perde o JA4 e a ordem dos cabeçalhos** do visitante (veja a seção 2). Depende de o cliente configurar certo, em especial passar o IP real (`X-Forwarded-For`, trocando em vez de acrescentar) e de você confiar nesse proxy (`trustedProxies`). |
| Sinais de rede | Só o IP, e só se o proxy for confiável. Sem JA4. |

### Forma 4 (não recomendada): CDN com proxy na frente do seu servidor

Por exemplo, o proxy da Cloudflare na frente do seu servidor, ou o cliente deixar o registro dele com o proxy ligado. A CDN termina o TLS e você passa a ver só a CDN. Evite.

### Comparação

| | Forma 1: seu domínio | **Forma 2: CNAME** | Forma 3: proxy do cliente |
|---|---|---|---|
| Endereço para o site do cliente | terceiros | **mesmo site** | mesmo site |
| JA4 e ordem dos cabeçalhos | sim | **sim** | não |
| Trabalho do cliente | só a tag | tag + 1 linha de DNS | tag + configurar o servidor dele |
| Certificado | um (ou por nome seu) | **um por cliente** | do cliente |
| Pronto no projeto hoje | sim | **não (falta SNI)** | em parte (`basePath`) |

## 4. O que o cliente instala

Muito pouco, e nada no servidor dele:

1. **Obrigatório, no site dele:** uma tag `<script>` (o script vem do **seu** servidor) e uma função que chama o coletor:

```html
<script src="https://id.loja.com/static/pw-3f9a.js" async></script>
<script>
async function registrarVisita(contaId) {
  try {
    const { nonce } = await (await fetch('https://id.loja.com/v1/nonce?k=PK_DO_CLIENTE')).json()
    await FingerprintJS.collectAndSend(
      { endpoint: 'https://id.loja.com/v1/collect?k=PK_DO_CLIENTE' },
      { nonce, linkedId: String(contaId) },
    )
  } catch (e) {}
}
</script>
```

2. **Se ele quiser agir sobre o resultado, no backend dele:** uma chamada HTTP com a chave secreta (`GET /v1/events/<requestId>` com `Authorization: Bearer <chave secreta>`). A resposta traz o aparelho, o risco e a decisão, e o backend dele decide o que fazer. Sem isso, ele só **registra**.
3. **Opcional, no DNS dele:** a linha CNAME da forma 2.
4. **Se o site dele tem CSP:** liberar o seu endereço em `script-src` e `connect-src`.

## 5. O que você faz por cada cliente

| Você | Para quê |
|---|---|
| Cria um **tenant** (`/admin/v1/tenants`) | Gera a **chave pública** (vai na página) e a **chave secreta** (vai no backend; aparece uma vez). |
| Põe o endereço do site dele em **`allowedOrigins`** | Só o site dele pode chamar o coletor pelo navegador. |
| Escolhe o nome do script (`collectorPath`) | Um nome por cliente é mais difícil de entrar em listas de bloqueio. |
| Ajusta retenção, limites e plano | Cada cliente tem os seus parâmetros. |
| Configura o certificado (forma 2) | Veja a seção 6. |
| Opera o servidor, o banco e o certificado | O cliente não opera nada disso. |

## 6. Cuidados específicos da forma 2 (CNAME)

- **CNAME só em subdomínio.** O DNS não permite CNAME no domínio puro (`loja.com`). Peça `id.loja.com`, `v.loja.com` e assim por diante.
- **Nome neutro.** Evite `fp` e `fingerprint`: listas de bloqueio podem reconhecê-los (suposição minha, sem teste).
- **Cloudflare:** o registro tem de ficar **somente DNS** (nuvem cinza). Com o proxy ligado (nuvem laranja), a Cloudflare termina o TLS e você perde os sinais de rede.
- **Registro CAA:** se o domínio do cliente tiver um CAA que não autoriza o Let's Encrypt, a emissão falha. É raro. Pergunte.
- **Validação do certificado:** o Let's Encrypt precisa confirmar que o nome `id.loja.com` aponta para você. Pela via HTTP, o seu servidor precisa estar acessível na **porta 80** para esse nome. A alternativa é o cliente criar um registro `TXT` de validação no DNS, o que dá trabalho a ele e não renova sozinho.
- **Cookies do cliente chegam ao seu servidor.** Um cookie de sessão com escopo `loja.com` é enviado pelo navegador também a `id.loja.com` (o seu servidor) quando carrega o script, por ser do mesmo site. O seu servidor **não guarda cookies** (só uma lista curta de cabeçalhos), mas os **recebe**. Registre isso em contrato (você não os usa nem os guarda) e recomende ao cliente cookies de sessão presos só ao domínio dele (host-only).
- **Se o cliente apagar ou mudar o CNAME**, o certificado deixa de renovar e o coletor para de funcionar. Você precisa de um aviso (monitorar a validade e o DNS de cada nome).
- **Domínio do produto separado do encurtador.** Use um domínio novo, só para o produto, e **não** o do encurtador (`ea.tv.br`). Isso isola a reputação: se um for marcado em listas de spam, o outro não cai junto. Os scripts já instalados nos clientes guardam o endereço do servidor, então **escolha esse domínio antes de ter clientes**.

## 7. Porta 443 versus 8443

Na VPS de hoje, a porta 443 é do nginx, e por isso o servidor usa a **8443**: o endereço fica `https://id.empregoaqui.com.br:8443`. Para um produto, isso é feio e pode ser bloqueado por regras de rede que só liberam a 443. O guia da VPS tem uma parte (H) que **mede** quantos visitantes caem nisso, e as rotas para usar a 443 estão em `usar-a-porta-443-para-o-fingerprint-sem-derrubar-o-nginx-sni-stream-ssl-preread-proxy-protocol-segundo-ip-opcoes-e-riscos.md`.

Em uma **máquina (ou IP) dedicada ao produto**, o servidor pode escutar direto na **443**, e o endereço fica `https://id.loja.com`, sem número de porta. Se você for vender, **considere uma máquina só para isso**. Isso também resolve a porta 80 para a emissão de certificados e isola a carga dos outros sites.

## 8. O que o projeto já tem e o que falta

**Já existe:**
- Tenants (um por cliente), com chaves, `allowedOrigins` e parâmetros próprios.
- API de administração (criar, suspender, trocar chaves, remover), planos e cotas por tenant, uso por dia.
- Nome do script por tenant (`collectorPath`) e prefixo de caminho (`basePath`) para a forma 3.
- MySQL e vários servidores sobre o mesmo banco.
- `trustedProxies` e `ja4Header` para aceitar o IP e o JA4 de um proxy confiável.

**Falta (trabalho de verdade):**
1. **SNI:** escolher o certificado pelo nome que o visitante pediu. Hoje o servidor carrega um certificado só (está dito em `server/README.md`). Em Node, isso se faz com uma função de seleção de contexto TLS por nome.
2. **Emissão e renovação automáticas** de um certificado por cliente (ACME), com aviso quando falhar. Há duas rotas: o próprio servidor responder à validação na porta 80, ou usar na frente um programa que emite sozinho. Esta segunda rota **muda quem termina o TLS**: o JA4 só continua existindo se esse programa o calcular e o repassar, e eu **não verifiquei** se algum faz isso hoje.
3. **Monitorar cada nome:** validade do certificado e se o CNAME ainda aponta para você.
4. **Faturamento, painel do cliente com login, contrato de tratamento de dados (DPA) e acordo de nível de serviço.** A decisão D84 registra que nada disso existe.
5. **Política de abuso:** o que você faz se um cliente usar a plataforma para algo ilegal, e como isso afeta a reputação do seu domínio.
6. **O jurídico do SaaS:** no serviço para terceiros você é **operador** dos dados em nome de cada cliente (cada cliente é o controlador). O texto, o RIPD e o contrato mudam em relação ao uso próprio. O grafo compartilhado entre clientes **continua desligado e travado** (D74) até haver parecer.

## 9. Recomendação, em fases

| Fase | O que usar | O que é preciso |
|---|---|---|
| **Hoje (uso próprio)** | `id.empregoaqui.com.br` na porta 8443 (subdomínio do domínio do próprio PWA) | nada além do guia da VPS |
| **Antes de ter o primeiro cliente** | Registre um **domínio só do produto**, neutro e separado do encurtador | decidir o nome (ele fica escrito nos scripts dos clientes) |
| **Primeiros clientes** | Forma 1, com um subdomínio por cliente no domínio do produto (`cliente1.produto.com`) | só o que já existe |
| **Quando o bloqueio virar problema** (medido) | Forma 2 (CNAME) para quem pedir | SNI, certificado automático e monitoramento (seção 8) |
| **Clientes que não podem mexer em DNS** | Forma 3 (proxy do cliente), avisando que perde o JA4 | configuração do lado do cliente e `trustedProxies` |
| **Escala** | Uma máquina dedicada, o servidor na porta 443 | decisão de infraestrutura |

**Como saber se o bloqueio é um problema:** em cada cliente, compare quantas visitas chegam ao seu servidor com quantas o site dele recebe (o cliente sabe o número dele). Se faltar muita coisa, principalmente no Brave, no Safari e no Firefox, o coletor está sendo bloqueado, e a forma 2 passa a valer o trabalho. **Eu não medi isso**, é uma suposição razoável baseada em como bloqueadores costumam agir.

## 10. Checklist para integrar um cliente novo (forma 2)

**Você:**
- [ ] Criei o tenant do cliente e guardei a chave secreta dele (aparece uma vez).
- [ ] Coloquei o endereço do site dele em `allowedOrigins`.
- [ ] Escolhi um `collectorPath` próprio para ele.
- [ ] O servidor atende o nome `id.loja.com` com um certificado válido (SNI).

**Cliente:**
- [ ] Criou o CNAME `id.loja.com` apontando para o nome que você indicou, **sem** o proxy da Cloudflare.
- [ ] Verificou que não há registro CAA que impeça o Let's Encrypt.
- [ ] Colocou a tag e a função no site, chamando só depois da ação que importa (cadastro, login, compra), sempre dentro de `try/catch`.
- [ ] Liberou o seu endereço na CSP, se tiver uma.
- [ ] Atualizou a política de privacidade dele, avisando da coleta contra fraude.
- [ ] Usa cookies de sessão presos só ao domínio dele, se possível.

**Verificação (qualquer pessoa):**

```bash
dig +short id.loja.com                      # deve mostrar o nome seu e o IP do seu servidor
echo | openssl s_client -connect id.loja.com:443 -servername id.loja.com 2>/dev/null | openssl x509 -noout -subject -dates
curl -s https://id.loja.com/readyz           # deve responder {"ready":true}
```

Depois, uma visita de teste e, no servidor, `last-events`: deve aparecer `ja4=` preenchido e `viaProxy=false`.

## Referências no projeto

- Opções de implantação (direto ou atrás de proxy): `server/README.md`, seção "How to deploy".
- Decisões: D57 (integração first-party), D63 a D68 (tenants, planos, cotas), D74 (grafo travado), D84 (SaaS como está).
- Instalar para o seu próprio PWA: `instalar-na-vps-passo-a-passo-id-empregoaqui-com-br-docker-tls-mysql-certificado-letsencrypt-coletor-no-pwa-fase-de-observacao.md`.
- Banco: `mysql-ou-sqlite-decisao-e-cuidados-em-producao-vps-compartilhada-retencao-conexoes-disco-backup.md`.
- Privacidade e LGPD: `docs/plano/privacidade/`.
