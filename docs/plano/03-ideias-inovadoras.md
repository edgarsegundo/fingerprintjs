# Ideias inovadoras

São ideias para tornar a plataforma melhor em dimensões **mensuráveis**: transparência, explicabilidade, privacidade, custo, adaptação à deriva dos navegadores e verificabilidade. Nenhuma foi testada. Cada uma diz como seria medida. Nada aqui afirma que supera o Pro: o Pro é um produto fechado e só se compara o que se mede do mesmo modo (ver `01-pesquisa-e-fontes.md`, A1 e A2).

**Sobre ineditismo.** A checagem de "isso já existe" foi **superficial** (poucas buscas, sem varrer o estado da arte). Onde a coluna diz "consolidada" a técnica é conhecida; "emergente" quer dizer que há trabalho publicado, mas não como prática comum; "especulativa" não tem trabalho que eu tenha encontrado. Antes de investir numa ideia, faça uma busca de anterioridade dedicada.

Legenda: ganho, custo e risco em alto, médio ou baixo (julgamento do autor).

| # | Ideia | Hipótese | Mecanismo | Ganho | Custo | Risco | Classe | Estado |
|---|---|---|---|---|---|---|---|---|
| I1 | Explicação contrafactual por decisão | Saber o que mudaria a decisão aumenta a confiança e acelera a revisão humana | Para cada característica, a probabilidade sem ela (`probabilityWithoutIt`) | médio | baixo | baixo | emergente (explicabilidade em ligação de registros) | **Feito** |
| I2 | Monitor de deriva por sinal e por versão de navegador | Cada atualização de navegador degrada alguns sinais; medi-lo cedo evita erro silencioso | Rodar a coleta em versões beta (o CI do repositório já testa betas), medir mudança de cada sinal entre versões e reponderar `featureM` | alto | médio | baixo | emergente | Pendente |
| I3 | Identidade como distribuição, não como ponto | A incerteza da ligação deve ser parte da resposta | Devolver as 3 melhores ligações com probabilidades, em vez de uma decisão | médio | médio | médio | emergente | Parcial (`ambiguous`, `possibleLink`) |
| I4 | Peso por característica aprendido por versão de navegador | A estabilidade de `canvas` no Chrome 155 difere do Safari 26 | `m` por (característica, família de navegador) | alto | médio | médio | consolidada (estratificação) | Pendente; precisa de dados |
| I5 | k-anonimato do vetor de sinais | Medir quantos aparelhos compartilham o vetor mostra o quanto a identificação depende do acaso | Contar, por tenant, quantos aparelhos têm cada valor e relatar a fração com k abaixo de 5 | médio | baixo | baixo | consolidada (medida) | Pendente |
| I6 | Coleta adaptativa ao risco | Pedir mais sinais só de visitas suspeitas reduz a coleta em geral | O servidor devolve ao script um perfil de coleta (mínimo ou ampliado) conforme o risco da visita anterior ou do IP | médio | médio | médio | emergente | Pendente |
| I7 | Benchmark aberto e reprodutível | A confiança no número vem de quem pode refazê-lo | Dataset de voluntários consentidos, protocolo público, harness que reproduz o relatório | alto | médio | médio (privacidade) | emergente | Código pronto, **sem dados** |
| I8 | Laboratório de adversário com ativos próprios | Testar a detecção contra o que o atacante usa, sem distribuir evasão | Navegadores do dono com adulteração padrão do DevTools | alto | médio | baixo | consolidada | Parcial (D40) |
| I9 | Consistência entre worker, iframe e página | Ferramentas de falsificação costumam mexer só na página | Comparar os mesmos valores nos três contextos | médio | baixo | baixo | consolidada | Worker feito |
| I10 | Plugins de sinal com manifesto de entropia e privacidade | Quem adiciona um sinal deve declarar o que ele revela | Cada fonte declara entropia estimada, estabilidade e impacto de privacidade, validado em teste | médio | médio | baixo | especulativa | Pendente |
| I11 | Modelo de dados portável | O cliente sai com os dados e a explicação | Exportação por `linkedId` já existe; padronizar o formato | médio | baixo | baixo | consolidada | Parcial |
| I12 | Detecção de deriva por distribuição (testes de dois amostras) | Uma mudança de distribuição de um sinal, sem mudança de versão, indica falsificação em massa ou atualização silenciosa | Comparar a distribuição semanal de cada característica com a anterior (divergência) | médio | médio | baixo | emergente | Pendente |
| I13 | Pontos de decisão com custo assimétrico explícito | O limiar ótimo depende do custo de ligar duas pessoas contra deixar passar duas contas | O dono informa o custo; o sistema escolhe o limiar na curva da calibração | alto | baixo | baixo | consolidada (decisão bayesiana) | Parcial (limiar é parâmetro; falta a curva com dados) |
| I14 | Aprendizado seguro: nunca ensinar com visita de risco alto | Um perfil forjado pode "ensinar" o motor a reconhecer o aparelho errado | Política `learnFromTampered` | médio | baixo | baixo | emergente | **Feito** (D44) |
| I15 | Hash de IP por tenant com chave rotacionável | Pseudonimização que impede correlação entre clientes | HMAC com chave por tenant | médio | baixo | baixo | consolidada | **Feito** (D58) |
| I16 | Grafo compartilhado só com sinais agregados | Ganho entre clientes sem expor dado de um ao outro | Contar em quantos clientes o aparelho apareceu e quantos o marcaram, nunca eventos | alto | alto | **alto** (jurídico) | consolidada em consórcios (ThreatMetrix, segundo o fornecedor) | Mecanismo pendente, desligado por padrão |
| I17 | Reprodutibilidade do veredito por versão | Poder refazer a decisão de uma visita antiga com as regras daquela data | Versionar `rules.list` e o modelo, e calcular risco na leitura com a versão do evento | médio | médio | baixo | especulativa | Parcial (risco é calculado na leitura, sem versionamento) |
| I18 | Teste de mutação como requisito de defesa | Uma defesa sem teste que falha quando ela é removida não está provada | Já aplicado a cada fase | médio | médio | baixo | consolidada | **Feito** |
| I19 | Sinais de anti-cheat (integridade de funções, tempo de execução) | Ferramentas de automação alteram o tempo e os protótipos | `nativeIntegrity`, medidas de duração por fonte | médio | médio | médio | emergente | Parcial |
| I20 | Teoria da informação para escolher sinais | O sinal com mais informação mútua com a identidade por custo de privacidade vale mais | Calcular a entropia condicional de cada sinal nos dados reais e podar os de ganho baixo | alto | médio | baixo | consolidada (seleção de atributos) | Pendente; precisa de dados |
| I21 | Calibração contínua com rótulo fraco | Contas que o cliente confirma como o mesmo usuário rotulam o motor sem custo | `linkedId` estável por conta vira rótulo para reajustar `m` por tenant | alto | médio | médio (viés) | emergente | Pendente |
| I22 | Resposta de risco com intervalo | Dizer "entre 20 e 40" é mais honesto que "30" | Propagar a incerteza dos pesos para o escore | médio | médio | baixo | especulativa | Pendente |

## Cinco experimentos

Cada experimento só vale com dados reais. O sintético valida o código, nunca o resultado (regra 12 do `CLAUDE.md`).

### E1: quanto dura a identidade (base: I7, I4)

- **Pergunta:** por quantos dias o mesmo navegador mantém o mesmo identificador, e qual a taxa de ligação errada?
- **Dados:** a coleta da Fase 0 (voluntários consentidos, vários aparelhos por pessoa, visitas ao longo de semanas). Mínimo útil: centenas de aparelhos.
- **Método:** `eval-identity` em ordem de tempo contra o hash original e contra o `componentOverlap`; intervalos por aparelho (bootstrap por cluster).
- **Linha de base:** hash exato da v5 e o FP-Stalker (54 dias, 98.598 impressões de 1.905 navegadores; ver A15).
- **Sucesso:** o motor mantém a identidade por mais tempo que o hash exato, com falsa ligação abaixo de um limite escolhido pelo dono, e o intervalo reportado exclui a linha de base.
- **Falha:** o intervalo cobre a linha de base (então não há ganho demonstrado).

### E2: o limiar certo (base: I13)

- **Pergunta:** onde pôr `identity.matchProbability` para o custo que o dono atribui a cada erro?
- **Método:** curva de falsa ligação contra falsa separação nos dados da Fase 0, com o custo relativo dado pelo dono.
- **Sucesso:** o limiar escolhido tem os dois erros reportados com intervalo por aparelho.
- **Dependência:** o dono responder qual erro custa mais (já perguntado).

### E3: deriva por versão (base: I2, I12)

- **Pergunta:** quais sinais perdem estabilidade em cada versão nova de Chrome, Firefox e Safari?
- **Dados:** o workflow que roda os testes em versões beta, estendido para medir a mudança de cada sinal no mesmo aparelho entre versões.
- **Sucesso:** uma tabela de estabilidade por sinal e versão com a data da medida; reponderação automática aplicada e medida em E1.
- **Risco:** o mesmo aparelho em duas versões exige controle de ambiente.

### E4: ablação de sinais (base: I20, I5)

- **Pergunta:** quanto cada sinal contribui, e quanto custa em privacidade?
- **Método:** retirar um sinal por vez (ou um grupo, com `privacy.dropSignals`) e medir a mudança em E1.
- **Sucesso:** uma lista de sinais que podem sair sem perda mensurável, para reduzir a coleta.

### E5: detecção de adulteração contra navegadores do dono (base: I8, I9)

- **Pergunta:** quais adulterações padrão do DevTools e de extensões de privacidade as 15 verificações pegam, e quais acusam em falso?
- **Método:** conjunto de casos de adulteração e de casos legítimos (extensões, modos estritos), cada um com a verificação esperada, em Chrome, Firefox e Safari reais.
- **Sucesso:** taxa de detecção por caso e taxa de falsa acusação nos casos legítimos, ambas com o número de casos.
- **Limite:** não testa navegadores anti-detecção profissionais, a menos que o dono os providencie.
