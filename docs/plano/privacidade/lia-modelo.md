# Teste de legítimo interesse (LIA): modelo

> Modelo de trabalho. Conferir com advogado ou DPO. Preencher o que está entre `[colchetes]`.

**Controlador:** [razão social]. **Encarregado:** [nome e contato]. **Data:** [data]. **Versão:** [n].

## 1. Finalidade (o interesse é legítimo e concreto?)

Prevenir fraude e abuso em [descrever o serviço]: reconhecer o mesmo aparelho em várias contas, detectar automação e navegadores adulterados, e limitar o abuso de promoções e cadastros. O interesse é do controlador e dos usuários honestos, que arcam com o custo da fraude.

Isto **não** inclui publicidade, perfilamento comercial nem rastreamento entre sites. Essa limitação é técnica (o identificador é por tenant e não atravessa clientes) e contratual.

## 2. Necessidade (há meio menos invasivo?)

| Alternativa | Por que não basta |
|---|---|
| Cookie de sessão ou conta | Quem comete fraude cria contas novas e apaga cookies |
| Verificação por telefone ou documento | Mais invasiva para o titular e com atrito para o usuário honesto |
| Só IP | Muda com a rede, é compartilhado (CGNAT, escritório) e gera falsos positivos |

Medidas de minimização já disponíveis: `privacy.ipStorage`, `privacy.dropSignals`, `retention.eventsDays`, o identificador por tenant, e a política de não deixar uma visita com adulteração grave ensinar o motor.

## 3. Balanceamento (o que o titular espera e o que pode sofrer?)

| Pergunta | Resposta para preencher |
|---|---|
| Que dados são tratados? | Características técnicas do navegador e do aparelho, endereço IP (na forma escolhida), horário, um identificador de conta do próprio controlador (`linkedId`) |
| O titular espera isso? | [avaliar: a política de privacidade informa? o serviço é financeiro, de marketplace?] |
| Há dado sensível ou de criança? | Não é coletado de propósito. [confirmar para o serviço] |
| Qual o dano possível? | Um falso positivo pode negar um serviço a um usuário honesto |
| Como se reduz o dano? | O sistema devolve **evidência e risco heurístico**, nunca um veredito. A decisão sobre o usuário é do controlador, que deve prever revisão humana para decisões que afetem o titular |
| Retenção | `retention.eventsDays` = [n] dias |

## 4. Salvaguardas

Direito de oposição e de acesso atendidos por [canal]; exclusão pela API; registro de acesso (`audit`); dados em [local]; chaves por tenant; webhooks assinados.

## 5. Conclusão

[ ] O interesse prevalece, com as salvaguardas acima. [ ] Não prevalece: usar consentimento ou desligar o recurso.

Revisão em: [data, no máximo 12 meses].
