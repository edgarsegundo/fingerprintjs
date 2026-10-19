# Fechamento: autocrítica, suposições e perguntas

> Atualização: a Fase 10 (tudo que dava para fazer sem dados) está em [fase-10-sem-dados.md](fases/fase-10-sem-dados.md). Os números da verificação abaixo são os de depois dela.

Data: 2026-10-19. Estado: todas as fases têm código e testes; **nenhum número de precisão existe** porque a Fase 0 está sem dados reais.

## Verificação final (2026-10-19)

| Verificação | Resultado |
|---|---|
| `yarn lint` (projeto inteiro) | limpo, zero avisos |
| `yarn build`, `check:dts`, `check:ssr` | passam |
| Testes do servidor | 776 de 776 sem MySQL; 869 de 869 com MySQL 8 (`FP_TEST_MYSQL_URL`) |
| Testes do navegador (Chrome 155 e Firefox 152 locais) | 262 de 262 |
| Imagem do Docker | construída, `healthy` com SQLite e com MySQL (`/readyz` responde), com `mysql2` instalado |
| Teste de mutação | feito em cada parte de defesa ou de invariante (cerca de 300 comportamentos quebrados de propósito ao todo). Variantes que não compilavam foram refeitas de modo que compilassem |
| Mutação na fila por tenant | tirar a fila faz 2 testes falharem |
| Não rodou | CI no GitHub (trabalhos novos, inclusive o serviço MySQL), Safari, Android, iOS, navegadores anti-detecção profissionais, teste de intrusão externo |

## Autocrítica

1. **Nada foi medido em precisão.** Todo o motor (pesos, limiar 0,99, escala) e todo o risco (pesos) são palpites. Um sistema com cara de produto e números de brinquedo é o maior risco de uso indevido. As respostas dizem `calibrated: false` e `heuristic: true` para isso não passar despercebido, mas quem ler só o painel pode não notar.
2. **A pesquisa ficou rasa** (cerca de 30 buscas contra 60 a 100 pedidas; uma página lida inteira). Concorrentes, trabalhos de 2023 a 2026 e a anterioridade das ideias foram tratados de relance. As conclusões do `01` valem como pontos de partida.
3. **O jurídico é rascunho.** Os modelos de LIA, RIPD e política foram escritos por quem implementou. Podem estar errados. A revisão foi adiada para o fim a pedido do dono, e esse fim chegou.
4. **O risco do grafo compartilhado é real.** A trava técnica é boa, mas código travado não é parecer. Se alguém tirar a trava, nada no código impede.
5. **Escala não demonstrada.** Cerca de 30 visitas por segundo com MySQL em Docker num notebook (D82), causa do teto não isolada. A busca de candidatos não foi testada com milhões de aparelhos. A cobertura do teste de carga é pequena.
6. **A evidência de adulteração nunca enfrentou um adversário competente.** Ela pega o que o DevTools e extensões fazem. Quem usa um navegador anti-detecção bom provavelmente passa.
7. **Sobreengenharia possível.** O sistema cresceu muito (admin, planos, cotas, grafo, painel). Sem usuário real, parte disso pode nunca ser usada. A ordem certa agora é coletar dados reais, não acrescentar recursos.
8. **Mutação nem sempre prova.** Alguns "sobreviventes" eram falhas de compilação e foram refeitos, mas um teste de mutação cobre só os comportamentos que eu pensei em quebrar.
9. **Segurança de operação por configuração.** Segredos ficam em arquivo JSON; não há integração com cofre de segredos.
10. **Um processo só.** Fila de webhooks, limites e cache de tenants são do processo.

## Suposições

- O dono é o controlador no uso próprio e cada cliente é controlador no SaaS (o dono, operador).
- O público é só brasileiro (LGPD), por decisão do dono (D83).
- A equipe é pequena (2 a 5 pessoas) e o orçamento não foi informado.
- O servidor roda direto na internet, em hostname e porta próprios, para o JA4 e a ordem de cabeçalhos serem do visitante. Atrás de proxy esses sinais descrevem o proxy.
- O dono fará a coleta real da Fase 0 e a revisão jurídica.

## Perguntas que mudam o plano: respostas do dono (2026-10-19)

1. **Qual erro custa mais?** Ligar duas pessoas diferentes. Consequência: D78 (`onAmbiguous: separate`, barra 0,99).
2. **Quantas visitas por dia?** "Não importa", o banco é o MySQL. Consequência: D79 a D82.
3. **Vender a terceiros?** Não agora; o que foi feito fica como está. Consequência: D84.
4. **Visitantes da UE ou do Reino Unido?** Só Brasil. Consequência: D83.
5. **Recrutar voluntários da Fase 0?** O dono recruta, mas a implementação termina sem esperar. Os dados reais continuam sendo o que falta para qualquer número de precisão.
