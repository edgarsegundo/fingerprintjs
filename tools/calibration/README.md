# Página de coleta com consentimento (Fase 0)

Página estática para voluntários enviarem visitas rotuladas ao servidor de ingestão. Serve para montar o dataset de
avaliação. O protocolo completo está em [docs/plano/protocolo-coleta-etica.md](../../docs/plano/protocolo-coleta-etica.md).

## Dois jeitos de publicar

**O mais simples:** o próprio servidor de ingestão serve a página (`calibrationDir` na configuração). Um endereço só, sem
CORS. É o que o [guia do organizador](../../docs/plano/guia-do-organizador.md) descreve.

**Hospedar em outro lugar:** publique a pasta em HTTPS e preencha `endpoint` no `config.js`.

## Como usar

```bash
yarn build                                          # gera dist/fp.min.js
cp dist/fp.min.js tools/calibration/fp.min.js
cp tools/calibration/config.example.js tools/calibration/config.js   # edite: endereço, chave pública, prazo, contato
# publique a pasta tools/calibration em HTTPS (qualquer hospedagem estática)
```

No tenant do servidor, coloque o endereço de onde a página fica em `allowedOrigins` (por exemplo `https://teste.seudominio.com`),
senão o navegador bloqueia a chamada.

## Por que a configuração não vem da URL

Se o endereço do servidor viesse de um parâmetro da URL, alguém poderia mandar um link que faz o voluntário enviar os
dados para outro servidor. Por isso o endereço e a chave ficam no `config.js`, que só o organizador edita.

## O que a página faz

Pede o código do participante e o aparelho, exige a caixa de consentimento, e envia uma visita com o rótulo
`codigo.aparelho`. Rejeita entradas que parecem e-mail. Não usa recursos externos, cookies próprios nem análise de uso.

## Limites

O texto de consentimento é um modelo. Ele **precisa** ser revisado com o jurídico ou o encarregado de dados antes de
convidar qualquer pessoa. A página não foi testada em Safari nem em celulares reais.
