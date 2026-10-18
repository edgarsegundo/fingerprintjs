# FingerprintJS (gratuito) vs. Fingerprint Pro (pago): arquitetura, como replicar e limites

## Contexto

Este documento é um recurso de referência para investigar como transformar uma implementação baseada em FingerprintJS (open source) em algo parecido com a versão paga (Fingerprint Identification, antes chamada de Fingerprint Pro).

Convenções usadas no texto:

- **Documentado**: vem da documentação ou do README da Fingerprint, ou de fontes citadas.
- **Inferência**: interpretação nossa, não confirmada por fonte. A empresa não publica o algoritmo do servidor.
- Quase todas as fontes sobre a versão paga são da própria empresa, que tem interesse em apresentar o produto bem.

## Links principais

- Biblioteca open source: https://github.com/fingerprintjs/fingerprintjs
- Produto comercial: https://fingerprint.com/

---

## 1. O que a versão paga tem de diferente

Se os dois rodam JavaScript no navegador, o que a versão paga teria de diferente? A maior parte do poder dela está **fora do navegador**.

### 1.1 O servidor enxerga coisas que o JavaScript não enxerga

O JavaScript na página só consegue ler o que o navegador deixa ele ler: tela, fontes, canvas e assim por diante. O servidor que recebe a requisição vê como a conexão foi feita.

- **Documentado**: a Fingerprint afirma que analisa os sinais junto com dados de nível de rede, incluindo sinais totalmente invisíveis para o navegador. A documentação do pacote cita como exemplos o suporte a criptografia TLS e dados de IPv4/IPv6.
- Dois iPhones idênticos têm os mesmos atributos de JavaScript, mas a rede, o caminho da conexão e o jeito como o aparelho negocia o TLS podem diferir. É isso que permite deduplicar visitantes com aparelhos idênticos.

### 1.2 A versão gratuita não tem memória, e a paga tem

A gratuita é uma função pura: pega os atributos, gera um hash e pronto. Por isso exige correspondência exata de todos os atributos e fica instável ao longo do tempo. Se o navegador for atualizado ou uma configuração mudar, o hash muda inteiro.

- **Documentado**: a paga deduplica, processa no servidor e usa fuzzy matching.
- **Inferência**: o servidor guarda o histórico de visitas e, a cada visita nova, pergunta qual visitante conhecido é o mais parecido, em vez de exigir um hash igual. Assim, se um atributo mudou mas o resto bate, ele ainda reconhece a pessoa.

### 1.3 Detecção de adulteração

Quem quer burlar o sistema pode falsificar o que o navegador reporta (extensões anti-detect, por exemplo). A versão gratuita roda no navegador do atacante e não tem como saber que foi enganada.

- **Documentado**: a paga valida que os sinais não foram adulterados nem reaproveitados (replay).
- **Inferência**: o mecanismo provável é cruzar os sinais entre si e com os dados de rede. Se o navegador diz ser um Safari no iPhone, mas a conexão tem cara de outra coisa, há uma inconsistência.

### 1.4 O código é fechado

A biblioteca gratuita tem o código aberto, então o atacante pode ler exatamente o que ela coleta e como calcula o hash, e criar um navegador que a engane. Na paga, a lógica de decisão fica no servidor, onde ninguém lê.

- **Documentado**: o README resume que, como o fingerprint gratuito é gerado e processado no navegador, ele é vulnerável a falsificação e engenharia reversa.

### Resumo da seção

A versão paga coleta um pouco mais de sinais no navegador (canvas, áudio, fontes), mas a maior vantagem vem do servidor: dados de rede, memória do histórico, comparação aproximada e checagem de fraude. Um terceiro que só tem o código do navegador não consegue reproduzir isso.

**Ponto não confirmado**: se o servidor também cruza dados entre os vários clientes da Fingerprint, o que daria uma base de dispositivos ainda maior. A documentação lida não afirma isso. Tratar como hipótese.

---

## 2. Como construir algo parecido com a versão Pro

Proposta: replicar a arquitetura em camadas: um coletor no navegador, sinais capturados no servidor e um motor que compara cada visita com o histórico. Não vai chegar aos 99,5% anunciados (ver seção 3).

### 2.1 Coletor no navegador

Partir da própria FingerprintJS (licença MIT) e adicionar sinais por cima: canvas, WebGL (renderer e vendor da GPU), áudio, fontes, tela, fuso, idiomas, núcleos de CPU e memória.

O coletor **não calcula o ID final**: só envia o vetor de sinais crus ao servidor. Isso tira do atacante a decisão sobre qual ID ele recebe.

### 2.2 Sinais capturados no servidor

Aqui está a maior parte do ganho, e nenhum JavaScript consegue enxergar isso:

- **Impressão do TLS (JA3/JA4)**: o jeito como o navegador negocia a conexão segura varia por navegador, versão e sistema. Para capturá-la, é preciso terminar o TLS num proxy que a exponha. Existem módulos para nginx e HAProxy, e alguns CDNs, como a Cloudflare em planos com bot management, entregam isso em cabeçalhos. Vale conferir a disponibilidade no plano contratado.
- **Cabeçalhos HTTP**: a ordem e a capitalização dos headers, e o fingerprint do HTTP/2, também diferem entre clientes.
- **Rede**: IP, versão (v4/v6), ASN e provedor, e geolocalização aproximada.
- **Consistência entre camadas**: o User-Agent diz "Safari no iPhone", mas o TLS parece o de outro cliente? Isso é uma bandeira vermelha.

### 2.3 Motor de matching (a "memória")

É o que torna o ID estável. Em vez de gerar um hash único:

1. Guardar o vetor de sinais de cada visita.
2. Separar os sinais estáveis (GPU, canvas, áudio, JA4) dos voláteis (versão do navegador, IP, tamanho de janela).
3. Buscar candidatos por índices nos sinais estáveis.
4. Calcular uma pontuação de similaridade ponderada. Se passar de um limiar, reaproveitar o `visitorId` existente. Se não, criar um novo.
5. Atualizar o registro, para que mudanças graduais (uma atualização do navegador) não quebrem a identidade.

Os pesos e o limiar devem ser calibrados com dados reais, medindo falsos positivos (pessoas diferentes tratadas como iguais) e falsos negativos.

### 2.4 Redundância para sobreviver à limpeza de dados

Além do fingerprint, gravar um ID de primeira parte em cookie, localStorage e IndexedDB. Se um deles sobreviver, religa-se o visitante ao ID antigo. Isso entra na mesma política de privacidade e, conforme o caso, no aviso de cookies.

### 2.5 Detecção de adulteração

- Comparar o que o navegador diz na página principal com o que diz num Web Worker e num iframe, porque extensões anti-detect costumam falsificar só um dos contextos.
- Cruzar User-Agent, plataforma e GPU com o JA4 e os headers.
- Cruzar fuso e idioma com a geolocalização do IP.
- Detectar ruído aleatório no canvas, como o que o Brave injeta de propósito.

### 2.6 Entrega ao backend

O navegador envia os sinais, o servidor devolve só um token ou `requestId`, e o backend consulta o resultado completo por uma chamada interna. O navegador nunca recebe a decisão final.

Este é o mesmo desenho da versão paga: o agente no navegador devolve `visitorId` e `requestId`, e o servidor do cliente consulta o evento completo pela Server API (endpoint `/events/REQUEST_ID`) com chave secreta.

### 2.7 O que não dá para replicar

- **Navegadores que combatem fingerprint**: Safari, Firefox e Brave reduzem ou randomizam sinais, e isso derruba a precisão de qualquer solução.
- **Aparelhos idênticos**: sobram só a rede e o comportamento, e essa parte não se resolve com mais JavaScript.
- **Escala de dados**: uma plataforma que vê bilhões de visitas calibra os pesos melhor do que uma implementação com poucos milhares. Isso não é segredo técnico, é volume.

Expectativa realista: algo entre a FingerprintJS pura e a versão paga. Bom o bastante para registrar e sinalizar suspeitas, não para bloquear sozinho.

### 2.8 LGPD

- Legítimo interesse documentado.
- Menção na política de privacidade.
- Coleta mínima.
- Prazo de retenção definido.
- IDs guardados em hash.

---

## 3. A versão paga vence esses limites?

**Parcialmente, nos três pontos.** A versão paga melhora a situação, mas a própria documentação deles admite que não elimina os problemas.

### 3.1 Navegadores que combatem fingerprint: parcialmente

- **Documentado**: a Fingerprint reconhece as novas proteções de privacidade do Safari 17, do Privacy Sandbox do Google e do anti-fingerprinting do Brave. A resposta deles é a abordagem híbrida: o componente de servidor mantém a precisão alta conforme os navegadores mudam. Eles não prometem imunidade; dizem que continuarão entre os mais precisos, o que é uma afirmação relativa.
- **Documentado**: em cenários como o Intelligent Tracking Prevention do Safari, a Fingerprint recorre à identificação probabilística, que tem chance de erro porque propriedades não determinísticas mudam com o tempo e podem ser iguais em dois navegadores idênticos.
- **Inferência**: quando consegue persistir um identificador, a identificação é quase determinística; quando o navegador bloqueia isso, ela cai para uma estimativa de semelhança.

### 3.2 Aparelhos idênticos: parcialmente

- **Documentado**: dois iPhones 15 com Safari terão o mesmo fingerprint na biblioteca gratuita, o que dificulta distingui-los.
- **Documentado (alegação da empresa)**: a paga consegue deduplicar de forma confiável visitantes com dispositivos idênticos, usando os sinais de servidor.
- Mas, no modo probabilístico, o erro entre aparelhos iguais continua possível.

### 3.3 Escala de dados: vantagem da Fingerprint

- **Documentado (alegação da empresa, via CB Insights)**: identifica mais de 1 bilhão de dispositivos únicos por mês.
- **Inferência**: esse volume é usado para calibrar os modelos. Nenhum documento lido confirma isso.

### 3.4 O 99,5% de precisão

A documentação da empresa explica o que o número significa, e é menos do que parece:

- A precisão se aplica principalmente à identificação probabilística.
- Para uma requisição, representa **só a probabilidade de falso positivo** (confundir duas pessoas).
- Não deve ser usada para estimar a precisão geral do produto.
- Isso significa que o número **não cobre falsos negativos**: os casos em que a mesma pessoa recebe um ID novo.

Por isso a empresa oferece um **confidence score** por requisição, que permite tomar decisões em tempo real. Na prática, usa-se a pontuação para decidir quando confiar no ID.

### 3.5 Contraponto independente

Uma análise da Proton relata que, nos testes deles, extensões anti-fingerprint para Firefox e Chrome se mostraram em grande parte ineficazes, e o Safari no macOS e no iOS teve fingerprints únicos. Esse teste mede unicidade, não a precisão de reidentificação de um produto comercial, então não prova nada sobre a Fingerprint em particular.

---

## 4. Notas práticas

- Se a versão paga for usada para bloquear contas, ler o confidence score e não só o ID. Quando estiver baixo, tratar como sinal de risco e pedir verificação extra, em vez de bloquear direto.
- Nem o FingerprintJS gratuito nem uma versão caseira devem bloquear sozinhos; servem para registrar e medir.
- Licença: a documentação da empresa ainda chama a FingerprintJS de "source-available", enquanto o README atual indica MIT. Provavelmente reflete mudança entre versões; conferir a licença da versão usada.
- Bloqueadores de anúncio podem barrar o script do agente. A versão paga trata isso com integrações por proxy (servir o script pelo próprio domínio).

---

## 5. Fontes consultadas

- Repositório e README da FingerprintJS: https://github.com/fingerprintjs/fingerprintjs
- Comparação FingerprintJS vs. Fingerprint Identification: https://dev.fingerprint.com/docs/pro-vs-open-source
- O que é a Fingerprint: https://dev.fingerprint.com/docs/what-is-fingerprint
- Identificação, precisão e confidence score: https://dev.fingerprint.com/docs/understanding-our-995-accuracy
- Quick start (agente no cliente + Server API): https://dev.fingerprint.com/docs/quick-start-guide
- Identificar visitantes: https://dev.fingerprint.com/docs/identify-visitors
- Pacote npm com a tabela comparativa: https://npmjs.com/package/@highlight-run/fingerprintjs
- CB Insights, perfil da Fingerprint: https://www.cbinsights.com/company/fingerprintjs
- Proton, artigo sobre fingerprinting de navegador: https://proton.me/blog/browser-device-fingerprinting

---

## 6. Perguntas em aberto para a investigação

1. Qual é o conjunto mínimo de sinais de servidor (TLS/JA4, headers, HTTP/2, rede) que dá o maior ganho sobre a biblioteca gratuita?
2. Como projetar o motor de matching (pesos, limiar, índices) e como medir falsos positivos e falsos negativos com poucos dados?
3. Quais técnicas de detecção de adulteração funcionam contra navegadores anti-detect, e quais já estão ultrapassadas?
4. Qual a infraestrutura necessária para capturar JA3/JA4 (proxy, CDN, módulos de nginx/HAProxy) e quanto isso custa?
5. Qual o desempenho esperado em Safari, Firefox e Brave, e como fica o confidence score nesses casos?
6. Como cumprir a LGPD (base legal, retenção, hash dos IDs) sem perder a utilidade do sinal?