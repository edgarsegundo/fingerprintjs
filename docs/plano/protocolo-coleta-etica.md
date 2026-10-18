# Protocolo de coleta de dados rotulados

Como montar o dataset que a Fase 0 precisa, de forma ética e útil. **Este documento não é parecer jurídico.** Revise-o,
junto com o texto da página de coleta, com o seu jurídico ou o encarregado de dados antes de convidar qualquer pessoa.

## Objetivo

Medir, com dados reais, três coisas que hoje ninguém mede neste projeto: quanto tempo o identificador da biblioteca original
dura (estabilidade), quantos aparelhos diferentes ele confunde (colisão) e quanto o futuro matcher melhora isso.
Para medir é preciso saber a verdade: quais visitas são do mesmo aparelho. Por isso os voluntários dão um código.

## Quem participa

Voluntários adultos que usam os próprios aparelhos: a sua equipe, amigos, conhecidos. Ninguém é obrigado, e ninguém é
rastreado fora do teste. **Não use visitantes de sites de produção como fonte de rótulos**: eles não sabem do teste, e
sem rótulo não há o que medir de qualquer jeito.

## O que se coleta, e o que não

| Coleta | Não coleta |
|---|---|
| Os 42 sinais da biblioteca e os sinais extras do coletor (tela, idioma, fuso, fontes, GPU, codecs...) | Nome, e-mail, telefone, documento |
| Dados de rede da conexão: IP, JA4, cabeçalhos, HTTP/2 | Histórico de navegação, outros sites, senhas, arquivos |
| O código do participante e o aparelho (`p07.iphone-safari`) | Localização, câmera, microfone, conteúdo de páginas |

O IP é trocado por um hash irreversível ao exportar o dataset. No banco do servidor ele existe até o prazo de retenção.

## Base legal (sugestão a confirmar)

Consentimento (LGPD art. 7º, I, e art. 8º): é a base mais simples de demonstrar numa coleta voluntária e pequena, e a página
exige a caixa marcada. A alternativa seria legítimo interesse, que pede uma avaliação própria (LIA) e é mais frágil quando
o titular não é cliente. Para o uso em produção, o plano usa legítimo interesse (Fase 7); isto aqui é outra coisa.

## Como rotular

- O rótulo é `codigo-do-participante.aparelho`. O organizador entrega o código (`p01`, `p02`...) e guarda, **separado**, a
  tabela "código → pessoa", ou nem guarda. Quem analisa não precisa saber quem é quem.
- **Um rótulo por aparelho e por navegador.** Dois navegadores no mesmo notebook são dois rótulos. Se um rótulo juntar dois
  aparelhos, o FNMR sai inflado.
- O modo anônimo do mesmo navegador é outro experimento: use rótulo próprio (`p01.notebook-chrome-privado`) para medir o
  quanto ele se parece com o modo normal.

## Quantos aparelhos são precisos

Os intervalos do harness reamostram aparelhos. O que limita o que se pode afirmar é o número de **aparelhos**, não de visitas
nem de pares. Valores calculados com o próprio código do harness:

| Aparelhos | Se não houver nenhum erro, a taxa de falso match é de no máximo | Largura do intervalo de um FNMR em torno de 10% |
|---|---|---|
| 30 | 11,35% | mais ou menos 11,7 pontos |
| 80 | 4,58% | |
| 100 | | mais ou menos 6,0 pontos |
| 150 | 2,50% | mais ou menos 4,7 pontos |
| 300 | 1,26% | mais ou menos 3,2 pontos |
| 1000 | 0,38% | |
| 3000 | 0,13% | |

Leitura honesta: com algumas centenas de voluntários dá para medir a **estabilidade** (FNMR) com precisão razoável, e dá para
ver **colisões** concretas (aparelhos que receberam o mesmo identificador). **Não dá** para provar uma taxa de falso match
de 0,1% ou menor com um dataset de voluntários. Isso exige milhares de aparelhos, que só um serviço em produção reúne.
Por isso nenhuma afirmação do tipo "tantos por cento de precisão" deve sair deste dataset sozinho.

## Cobertura que faz o dataset valer a pena

- **Navegadores**: Chrome, Safari, Firefox, Edge, e os de celular (Safari no iPhone, Chrome no Android). Safari e Firefox são
  onde os sinais são mais fracos, então precisam de aparelhos de verdade, não só de Chrome.
- **Aparelhos idênticos**: pelo menos 2 ou 3 pares do mesmo modelo e versão (por exemplo dois iPhones iguais). É onde a
  biblioteca original mais confunde, e onde o servidor com sinais de rede deve ajudar.
- **Tempo**: cada aparelho visita no dia 0, 1, 7 e 30. Sem isso, não há curva de estabilidade em 7 e 30 dias.
  Atualizações de navegador no meio do período são bem-vindas: são o caso que quebra o hash.
- **Redes diferentes**: casa, trabalho, 4G. Mede o quanto o IP atrapalha ou ajuda.

## Retenção, segurança e direitos

- Prazo: dizer o prazo na página (`retention` do `config.js`). Sugestão: apagar tudo 90 dias depois de encerrado o teste.
- Retirada: o participante informa o código e o organizador roda
  `node server/dist/cli.js delete-linked --tenant <id> --linked-id <codigo.aparelho>` para cada aparelho dele.
  Confira depois com `export-events` que não sobrou nada.
- O dataset exportado fica só em disco criptografado, com acesso restrito, e sem os endereços IP em claro (o padrão do
  `export-events`). Não use `--keep-ip` sem necessidade.
- A tabela "código → pessoa", se existir, nunca vai junto com o dataset.

## Riscos do próprio método

- **Viés**: amigos e colegas usam aparelhos parecidos (mais Mac e iPhone do que a população). O resultado vale para esse grupo.
- **Rótulo errado**: duas pessoas digitando o mesmo código, ou um aparelho trocado. Revise rótulos com poucas visitas ou
  com navegadores diferentes.
- **Headless não vale**: Chrome sem interface se comporta diferente de um Chrome de pessoa. Os testes automatizados do
  projeto validam o encanamento, não a precisão.
- **Um período curto** não diz nada sobre estabilidade em 30 dias. O relatório avisa quando o período é menor que 7 dias.

## Como rodar

```bash
node server/dist/cli.js export-events --config config.json --tenant <id> --out dataset.jsonl
node server/dist/cli.js eval dataset.jsonl --out relatorio.md --json relatorio.json
```

O relatório traz os avisos de amostra pequena no topo, antes dos números. Leia os avisos primeiro.
