# Desvios do plano

O que saiu diferente de `docs/PLAN.md` durante a implementação. Para cada desvio: **o que mudou**, a
**consequência** para quem usa, e **o que fazer** (a sugestão, ou o que já foi feito). Um desvio "absorvido no plano"
virou texto da revisão 5.2 e deixou de ser desvio; um "resolvido" foi corrigido por um ticket.

Dois termos que aparecem em quase todos:

- **Trava:** o jlock marca um arquivo (ou pasta) como "em uso pela tarefa T01". Enquanto a trava existe, outra tarefa
  não mexe nesse arquivo.
- **`hold`:** o processo pequeno do jlock que segura essa trava. Enquanto ele está vivo, a trava existe; quando ele
  termina, a trava some.

## 1. Pelo CLI, a trava fica num processo separado (ticket 04) — resolvido pelo ticket 21

**O que mudou:** o plano supunha que o `jtasks` ficaria aberto segurando a trava e a devolveria pela entrada padrão
do `hold`. Cada comando do CLI termina na hora, então o `start` deixava o `hold` rodando sozinho em segundo plano, com
código próprio para destacá-lo, e o `done` o encerrava com `jlock release`.

**Consequência:** funciona igual para quem usa; cada tarefa em andamento tem um processo do jlock em segundo plano
até o `done`.

**O que fazer:** o jlock ganhou `hold --detach` nativo (uma chamada, resposta na mão, o próprio jlock segura a
trava) e `--ttl`. Feito no ticket 21: o CLI e o mod usam `--detach --ttl`, o código próprio de destacar foi removido; o
plano (rev. 5.2, seções 4 e 20) diz isso.

## 2. No Windows, uma trava pode ficar presa se a janela cair (ticket 04) — resolvido por J18 (jlock) e 21

**O que mudou:** o plano dizia que, se a janela morre, as travas somem em até 30 s. O `jlock hold` ignorava o fim da
entrada padrão e, no Windows, encerrar um processo não encerra os filhos: o `hold` continuava vivo e renovando.

**Consequência:** se o OpenCode ou o Claude Code fechassem de forma abrupta, a trava ficava até alguém soltar à mão
com `jlock release`; outras tarefas que precisassem do arquivo esperavam.

**O que fazer (feito nos tickets 18 do jlock, 21 e 22):** três casos, três respostas. A janela inteira cair: o jlock ganha `hold --release-on-eof` (ticket 18
do jlock), e o plugin do OpenCode, que fica aberto, usa isso; a trava some no instante em que o cano fecha. O CLI
(que termina a cada comando) e o mod (cuja API fecha a entrada padrão na partida): `--detach --ttl`, e a trava expira
sozinha no prazo (`holdTtl`, 2 h por padrão). Uma tarefa que morre com a janela viva: o mod já devolvia a tarefa à
fila; o plugin do OpenCode passa a fazer o mesmo (ticket 22).

## 3. Uma trava extra na hora de gravar o `tasks.json` (ticket 02) — absorvido no plano (rev. 5.2)

**O que mudou:** o plano pedia "ler, conferir a versão e gravar". Um teste mostrou que dois processos ao mesmo tempo
ainda podiam perder a alteração de um deles. Cada gravação passou a ter uma trava rápida (a pasta `.write.lock`,
criada de forma exclusiva), que dura milissegundos.

**Consequência:** nenhuma gravação se perde. Se um processo morrer no meio, o próximo espera no máximo 10 s e segue.

**O que fazer:** nada; é mais seguro que o original e está na seção 5 do plano.

## 4. O `next` não enxerga, num caso raro, uma tarefa exclusiva de outro projeto (ticket 04) — resolvido pela 0.7.0 (desvio 19)

**O que mudou:** uma tarefa `exclusive` trava a chave `*`, a máquina inteira; essa chave não aparece na consulta que
o `next` faz, que olha só o repositório (`--under`). O `next` lê a lista inteira da máquina só quando a própria
execução tem tarefa `exclusive`.

**Consequência:** nesse caso raro, o `next` mostra uma tarefa como pronta e o `start` responde "não estava pronta",
sem gravar nada. Só uma tentativa desperdiçada.

**O que fazer:** aceitar; o custo é mínimo e o caso é raro.

## 5. O `done` não reclama dos arquivos que outra tarefa está mexendo (ticket 05) — absorvido no plano (rev. 5.2)

**O que mudou:** o plano dizia que o `done` recusa se houver arquivo alterado fora da posse da tarefa. As tarefas
paralelas usam a mesma pasta: quando T01 termina, os arquivos que T02 está editando também aparecem como alterados.
O `done` separa as alterações em três grupos: as da tarefa entram no commit; as de outra tarefa em andamento (ou de
outro dono no jlock) ficam no disco, fora do commit; as de ninguém fazem o `done` recusar, sugerindo `jtasks claim`.

**Consequência:** dá para rodar tarefas em paralelo de verdade. Sem isso, nenhum `done` funcionaria enquanto outra
tarefa estivesse aberta.

**O que fazer:** nada; está na seção 4 do plano. Só deixaria de ser necessário com uma pasta por tarefa (item 7 da
seção 18), que ficou de fora.

## 6. As tentativas são contadas no `start` (ticket 07) — absorvido no plano (rev. 5.2)

**O que mudou:** o plano contava uma tentativa a mais quando a tarefa era devolvida (`release`, `resume`, posse
perdida). Agora conta quando ela começa. E `resume --keep-owners` ficou definido como "não devolve nenhuma tarefa à
fila", porque a frase do plano era ambígua.

**Consequência:** o número é o mesmo na prática, e uma tentativa interrompida (janela morta) também conta. O critério
do ticket 07 que pedia, ao pé da letra, `attempts+1` na posse perdida ficou desmarcado.

**O que fazer:** nada; a seção 5 do plano diz "conta no `start`".

## 7. O plugin do OpenCode não consegue criar agentes (ticket 12) — absorvido no plano (rev. 5.2)

**O que mudou:** a API do plugin (2.1.3) é diferente da que o plano supunha. A maior parte só mudou de nome
(`tool.transform` em vez de `tool.register`; `parentID` em vez de `session.family`; `permission.hook("evaluate")`
em vez de "um hook de permissão"). A diferença real: um plugin não pode criar agentes, então não há o efeito
`agent-config` no ledger.

**Consequência:** os agentes dos perfis precisam existir na sua configuração. Qualquer nome serve: o perfil diz qual
agente usar (`opencode.agent`); sem perfis no plano, valem os padrão (`execute`, `execute-deep`, `review`). O
plugin escolhe o agente certo para cada tarefa e aplica o modelo do perfil, mas não os cria.

**O que fazer:** o pacote passa a trazer os três agentes prontos (ticket 20) e o `jtasks doctor --fix` os instala em
`~/.config/opencode/agents/`, com registro no ledger e desfazer (ticket 28). Um perfil que aponta agente inexistente
gera aviso no `plan --commit`.

## 8. A barra de progresso do OpenCode não vem do HUD (ticket 13)

**O que mudou:** o plano usava a barra `Meter` do `opencode-hud`, que é outro projeto. A barra é nossa, a mesma do
painel do Claude Code.

**Consequência:** o plugin não depende de você ter o HUD instalado.

**O que fazer:** o ticket 23 copia o visual do `Meter` (oitavos de célula, cor principal do tema, trilho apagado),
sem importar nada do HUD.

## 9. O mod do Claude Code contorna limites da API (ticket 14)

**O que mudou:** a API do Claude Code (2.1.310) não renomeia nem apaga arquivos, não cria pasta, não deixa escrever
na entrada padrão depois que o processo começou, recusa `$` passado como argumento, e não tem `prompt.section`. Os
contornos: renomear, apagar e criar pasta passam por comandos do sistema (`cmd /d /c move`, `del`, `rmdir`,
`mkdir`; `mv`, `rm`, `mkdir` fora do Windows); o `session.start` monta uma "porta" de funções que chamam `$`; a trava
é devolvida por `jlock release`; o resumo no prompt usa `prompt.compose`, que roda a cada requisição e por isso volta
sozinho depois de uma compactação.

**Consequência:** até o ticket 21, recarregar o mod no meio do trabalho encerrava os `hold`s e as tarefas em
andamento apareciam como "posse perdida" (o `jtasks resume` as devolvia à fila); com `--detach`, a trava sobrevive ao
recarregamento. Os testes do mod rodam numa máquina simulada (`claude/tests/machine.ts`), porque o
`claude plugin test` não tem disco nem processos reais.

**O que fazer:** feito no ticket 30. O mod rodou num Claude Code 2.1.310 de verdade, dirigido pelo herdr, com haiku:
plano em lotes, `next`, `start` com a trava visível no jlock, `done` com commit, a guarda recusando um `Write` de
subagente fora da posse, `/jtasks`, e `status` até "restam 0" (`docs/evidence/mod-herdr-2026-10-24.md`). Tudo se
comportou como na máquina simulada; a única diferença real foi uma linha do painel que quebrava por causa da largura
dupla do `⛔`, corrigida no mesmo ticket.

## 10. O comando é `/jtasks`, não `/tasks` (ticket 15) — absorvido no plano (rev. 5.2)

**O que mudou:** o Claude Code já tem um `/tasks` próprio (as tarefas em segundo plano) e recusaria o registro. O
nome `/jtasks` foi escolhido pelo usuário.

**Consequência:** só o nome, e só no Claude Code: no OpenCode a seção fica na barra lateral e se dobra com um clique;
a ferramenta do modelo e o CLI continuam se chamando `jtasks`.

**O que fazer:** nada; está na seção 14 do plano.

## 11. O jlock se instala sozinho, sem o `doctor` (ticket 42)

**O que mudou:** o plano (seção 22) deixava a instalação do jlock para `jtasks doctor --fix --yes`. A pedido do
usuário, quem instala o jtasks não precisa de um passo a mais: o primeiro comando que pode precisar do jlock, no CLI,
no mod ou no plugin, instala um jlock que falta pelo instalador oficial; o mod e o plugin fazem isso assim que
carregam. O binário entra no ledger global (`jtasks undo <g-id>` o remove) e é usado na hora, pelo caminho, porque o
processo não enxerga o `PATH` que o instalador mudou.

**Consequência:** é a única coisa que a ferramenta instala sem pedir, e é na máquina, não num projeto. `JLOCK_BIN`
(um jlock escolhido pelo usuário) ou `JTASKS_NO_JLOCK_INSTALL=1` desligam; uma falha (sem rede, por exemplo) só avisa,
com a linha que instala à mão, e o comando segue.

**O que fazer:** nada; o `doctor` continua diagnosticando e instalando agentes e skills.

## 12. A retomada guarda a contagem num arquivo da execução (ticket 44)

**O que mudou:** o plano da retomada guardava a última mensagem (assinatura e tentativas) no estado de cada host:
`$.state` (uma chave `keepalive`) no Claude Code e `ctx.storage` (`keepalive/<raiz>`) no OpenCode. Ela ficou em
`keepalive.json`, na pasta da execução, escrita pelo núcleo (`checkKeepalive`). Três outros detalhes: no Claude Code a
retomada só age em sessão interativa (`isInteractive` do `session.start`; num `-p` ou no SDK, nada); os agentes vivos
vêm de `$.agent.list()` (qualquer subagente da sessão, não só os de tarefa), com o mapa `agents` como reserva; e a
mensagem passa de novo pelo hook `prompt.submit` do próprio mod, que a descarta se a execução andou entre o fim do
turno e a entrega. No OpenCode o gatilho é o `session.idle` da raiz, 300 ms depois, para o fim da execução
(`session.execution.interrupted`/`failed`) chegar antes; a mensagem é um `session.synthetic` com `delivery: "queue"`.

**Consequência:** a contagem é a mesma nos dois hosts, sobrevive a `/reload-plugins` e a reinícios, e o
`jtasks status` do terminal sabe se o host desistiu. Duas sessões ligadas à mesma execução compartilham a contagem,
o que é o certo: o progresso é da execução.

**O que fazer:** nada. `jtasks keepalive on` (ou `unpause`, `resume`) apaga o arquivo; `clean` e `archive` levam a
pasta inteira.

Dois pontos também saíram diferentes do plano, depois da revisão: depois de erro de API ou recusa (no OpenCode, uma
execução que falhou) o plano não fazia nada, e a execução ficava parada em silêncio; agora nada é enviado (poderia
falhar igual), mas a pessoa é avisada na hora, como numa desistência (`keepalive.error`). E `unpause`, `resume` e
`keepalive on` só zeram a contagem quando de fato saem de uma pausa, de um desligamento ou de uma desistência: o
modelo os chama, e um modelo que respondesse à mensagem com `resume` faria a contagem voltar a 1 para sempre.

## 13. As travas de uma tarefa longa são renovadas pelo jtasks, não pelo jlock (ticket 45)

**O que mudou:** o anexo do plano da retomada oferecia duas saídas: renovar o `hold` enquanto a tarefa está em
andamento, ou o `done` aceitar arquivos da própria tarefa cuja trava venceu. Ficaram as duas. A renovação não é um
heartbeat, porque o `--ttl` do jlock conta desde a concessão e nem um `hold` reentrante do mesmo dono o estende
(conferido no jlock 0.1.1): é devolver e pegar de novo, na hora, sob a trava curta de escrita da execução.

**Consequência:** há um intervalo de milissegundos sem trava a cada renovação (uma vez por `holdTtl`, perto do fim);
quem estava na fila da chave a recebe, como receberia no vencimento, e a tarefa fica como "posse perdida" só nessa
chave (as livres são pegas uma a uma). Com `--detach`, o processo que o jlock deixa segurando a trava antiga não
percebe a devolução (o novo `hold` tem o mesmo dono) e segue vivo até a tarefa devolver a posse: um processo pequeno
a mais por renovação, todos encerrados no `done`/`release` (conferido no jlock 0.1.1). Tarefas iniciadas pelo CLI,
sem host aberto, não são renovadas; o `done` delas retoma as chaves se ninguém as pegou e se nenhuma outra tarefa
da execução as pegou depois (pelo `log.jsonl`).

**O que fazer:** se o intervalo ou os processos a mais pesarem, um `--ttl` renovável no jlock (pelo processo do
jlock, com um ticket lá); o jtasks passaria a usá-lo no lugar de devolver e pegar de novo.

**Atualização (ticket 46, 25/10/2026):** feito. O jlock 0.2.0 tem `jlock renew` (ticket 19 de lá), que adia o
prazo sem soltar a trava nem reescrever `holder.json`, e o jtasks o usa sempre que o jlock instalado é 0.2.0 ou
mais novo. Com ele, somem o intervalo sem trava e os processos a mais. O caminho de devolver e pegar de novo só vale
para um jlock anterior, e o `jtasks doctor` então avisa e sugere `jlock update`. Fica um limite: um `hold`
iniciado por um jlock anterior à 0.2.0 não lê o prazo novo e vence no antigo; a passada seguinte o retoma, como
retomaria uma trava vencida.


## 14. A revisão do plano é a 5.6, e a fila do `yield` é um `claim` pendente (ticket 47)

**O que mudou:** o plano de melhoria (`plano-posse-e-ceder.md`) pedia a "revisão 5.4" no topo do `PLAN.md`, mas a
5.4 e a 5.5 já existiam (tickets 45 e 46); a mudança entrou como **revisão 5.6**, item 19 da seção 18. E o plano
deixava duas formas para a tarefa que cedeu "entrar de novo na fila": um `--wait` em segundo plano ou um `claim`
pendente que o `next` e o `status` mostram. Ficou a segunda: as entradas cedidas vão para `yielded` na
`tasks.json`, e a chave volta sozinha, sem espera, quando fica livre (depois do `done`, `release`, `skip` ou `fail`
de outra tarefa, no `next` e a cada passada de um minuto do mod e do plugin), ou por `jtasks claim <id>`, que espera
na fila do jlock como qualquer `claim`. Um processo do jlock esperando em segundo plano não serve ao CLI, que termina
a cada comando, nem ao mod, que usa `--detach`.

**Consequência:** a tarefa que cedeu não ocupa um lugar na fila do jlock enquanto não pede o arquivo de novo; em
compensação, nenhuma tarefa nova começa sobre a chave cedida (a fronteira a trata como reservada), e quem a está
esperando no jlock (a outra ponta do ciclo) a recebe na hora.

**O que fazer:** nada. Para esperar de verdade pelo arquivo, `jtasks claim <id>` (sem arquivos, ou com eles).

## 15. `fail` e `skip` também guardam as edições, e o `claim` sem arquivos pega o que foi cedido (tickets 47 e 48)

**O que mudou:** o plano listava, para guardar as edições ao liberar, o `release`, o `--agent-ended`, o `resume` e o
`maxAttempts`. A posse perdida (`hold` que sai com 14), o `fail` e o `skip` deixavam no disco o mesmo tipo de edição
sem dono, com o mesmo efeito nas outras tarefas; os sete caminhos usam agora a mesma função (`keepTask`). E o
`jtasks claim <id>` sem arquivos, antes um erro de uso, pega de volta o que a tarefa cedeu.

**Consequência:** depois de um `fail` ou de um `skip`, a árvore fica limpa: a edição pela metade não está mais no
disco, e sim num patch da execução, reaplicado se a tarefa for reaberta (`retry`) e começar de novo. Quem quiser a
edição de volta sem reabrir a tarefa: `jtasks undo <e-id>` do efeito `restore` (lista em `jtasks ledger`).

**O que fazer:** nada; para começar uma tarefa reaberta do zero, `jtasks start <id> --fresh`.

## 16. A falha transitória lida do `StopFailure`, e o que conta como transitória (tickets 51 e 52)

**O que mudou:** o pedido era detectar o fim do subagente com erro pelo que o mod já tinha (`turn.complete`). Esse
evento traz só `reason: "error"`, sem texto, então o mod passa a ouvir também o evento clássico `StopFailure`
(`error`, `error_details`, `last_assistant_message`, `agent_id`). A documentação não diz se ele dispara dentro de
subagentes nem se vem antes ou depois do fim do laço: o mod espera até 1,5 s por ele no fim de um subagente, e um
`StopFailure` que chega depois (até 15 s) ainda pausa a execução, mesmo que a tarefa já tenha voltado à fila. A
resposta e a última mensagem do laço só contam quando são o erro como o Claude Code o mostra (`API Error: …`, as
linhas de limite de uso), para que um subagente que fala de "rate limit" no código que escreve não pause nada.

**Decisões que eram do usuário, tomadas pelo lado seguro:** `billing_error` do Claude Code, `insufficient_quota`,
créditos insuficientes (402) e cota excedida contam como transitórios (pausam: crédito ou plano resolvem sem perder a
tarefa); `account_on_hold`, autenticação, recusa e contexto não. Uma falha sem nenhuma informação (nem
`StopFailure`, nem texto) segue como antes (a tarefa volta à fila). Sem horário de reset, a retomada automática vem
em 5 minutos, dobrando até uma hora, e para depois de três seguidas sem progresso. No OpenCode, retomar "a mesma
sessão" usa o `task_id` da ferramenta de subagente; a recusa de um segundo subagente deixa passar uma chamada que
traga `task_id`, `taskID`, `sessionID` ou `session_id`. A versão foi para 0.2.0 (novidades desde 0.1.0, abaixo de
1.0: sobe o número do meio).

**O que fazer:** nada. Para retomar antes do reset, `jtasks unpause`; para ficar parado até decidir, `jtasks pause`
(a tarefa continua mantida, sem retomada automática).

## 17. O fim de um subagente olha os processos da tarefa, e o host avisa o orquestrador (ticket 53)

**O que mudou:** o pedido era que `jtasks exec` registrasse o PID do processo de cada tarefa, "inclusive quando o
chamador o põe em segundo plano". No Claude Code o subagente roda a suíte longa pelo Bash com `run_in_background`, e
o Claude Code não dá o PID desse processo ao mod (nem `$.process.run` dá o PID do que roda). Então, no mod, o sinal
vem do próprio Claude Code: o status do agente em `$.agent.list()` (`waiting`: "em trabalho de fundo que ele
possui") e os comandos que o mod viu o subagente mandar para o segundo plano nesse turno; o mod passa isso ao núcleo
como `release --agent-ended --waiting "<o que viu>"`, e a espera acaba quando o mesmo agente volta (`turn.start`).
Os PIDs reais ficam para `jtasks exec --task <id>` (no CLI e no plugin, o host do Node sabe o PID do filho) e para
`jtasks wait <id> --pid <pid>`. O `exec` pela ferramenta do mod roda em primeiro plano (a chamada segura o turno do
subagente), então não precisa de PID. Um PID que o sistema não sabe dizer se vive conta como morto (a tarefa volta à
fila como antes, nunca fica presa); um PID reusado por outro executável também (o nome do executável é guardado no
registro). O `exec` ganhou `--timeout` (10 min continua o padrão), porque uma suíte e2e longa passava disso.

**Consequência:** um subagente que termina sem concluir e que tinha mandado algo para o segundo plano nesse turno
segura a tarefa até o agente voltar ou, se o Claude Code disser que ele não espera mais (status `completed`, `idle`
ou ausente), até `awaitGrace` (5 min) depois disso; só então a tarefa volta à fila. O fim de subagente deixa de gastar
`maxAttempts` (tem `agentEnded`/`maxAgentEnded`, 3 por padrão); o `release` explícito, a posse perdida e o `resume`
continuam gastando e falhando no `maxAttempts`, agora com aviso ao orquestrador. A pausa por falha transitória (rev.
5.7) não manda mensagem ao laço principal no momento da pausa (ela bateria no mesmo limite); a pessoa é avisada como
antes, e o orquestrador recebe a mensagem da volta. As mensagens de aviso usam o mesmo caminho da retomada (um
`prompt.submit` do plugin, que entra quando a sessão fica ociosa e nunca por cima de um rascunho); não vão para uma
execução com `-p` nem para o SDK. O mod lê o `log.jsonl` a partir do fim quando liga a execução ou recarrega: o que
aconteceu durante uma recarga do mod não vira aviso (o `jtasks status` mostra).

**No OpenCode:** não há "segundo plano" que o plugin veja nem reabertura automática da sessão filha quando o processo
termina. Por isso: a sessão filha que fica ociosa com um processo registrado (`exec --task`, `wait --pid`) deixa a
tarefa aguardando, com a ligação da sessão mantida; quando o processo termina, o plugin manda à sessão raiz "retome a
mesma sessão (`task_id`)", e o início de execução da sessão filha encerra a espera. A anexação da linha de status vai
no resultado da chamada de subagente (`tool.execute.after`), e o aviso à pessoa é um evento `alert` da RPC que a TUI
mostra como toast. Sem `session.synthetic` no host, o aviso fica só no log, no `console.warn` e na TUI.

**O que fazer:** subagentes: rodar o que for longo com `jtasks exec --task <id> -- <comando>`; para encerrar o turno
esperando um processo lançado de outro jeito, `jtasks wait <id> --pid <pid>` antes. Orquestrador: deixar em paz a
tarefa "aguardando processo" e seguir com as outras. Pessoa: numa pausa por `needsPerson`, ver a tarefa, depois
`jtasks retry <id>` e `jtasks unpause`. Para ajustar: `maxAgentEnded` e `awaitGrace` no plano.

## 18. Estado por eventos: a chave da árvore com tarefa exclusiva, o mod com `--detach`, e as decisões incertas (ticket 60) — o item 1 foi resolvido pela 0.7.0 (desvio 19)

**O que mudou:** o ticket 60 tirou a trava de escrita (`withLock`, `.write.lock`): o estado é a dobra de
`events.jsonl` com commit otimista, e os efeitos na árvore rodam sob a chave do jlock `name:jtasks:<run>:git`, segura
pelo próprio processo com `jlock hold --release-on-eof`. Três pontos saíram diferentes do texto do ticket:

1. **Tarefa `exclusive`:** ela segura `*`, e `*` cobre toda chave, as `name:` também. O jlock só concede uma chave em
   conflito ao mesmo dono, então enquanto uma tarefa exclusiva da execução está em andamento a chave da árvore é
   segura sob o dono dela (`gt:<run>/<tarefa>`): o `start` da exclusiva já a pede assim, e quem a encontra recusada por
   esse `*` tenta de novo com esse dono. Duas transições ao mesmo tempo nesse período não se excluem pela chave (o
   jlock concede as duas ao mesmo dono); o estado continua certo pela dobra, e os efeitos são idempotentes (o commit
   do `done` com o trailer não é refeito, um `release` refeito acha os patches no ledger).
2. **O mod segura a chave com `--detach --ttl 10m`, não com `--release-on-eof`:** o `$.process.spawn` do Claude Code
   fecha a entrada padrão do filho na hora, o que soltaria a trava no mesmo instante. A chave é devolvida no `finally`
   com `jlock release`; se o Claude Code morrer segurando-a, as transições de árvore dessa execução esperam até 10 min
   (o ttl). O CLI e o plugin (host do Node) usam `--release-on-eof`. O rascunho do plano (`plan --add/--fix/--commit`)
   usa a mesma ideia com a chave `name:jtasks:<rascunho>:draft`.
3. **O que não estava no ticket e foi decidido pelo lado seguro:**
   - O `start` toma a chave da árvore (ele traz patches de volta); assim dois `start` da mesma tarefa nunca pegam as
     travas juntos, e o segundo vê a tarefa em andamento antes de pedir qualquer trava. As travas da tarefa são pegas
     uma vez só, mesmo quando a decisão é refeita.
   - Uma decisão que se apoia em outra tarefa sem mudá-la declara isso (`guard`): o `adopt` (a tarefa que adota) e a
     volta dos patches antes do `done` (as outras tarefas em andamento, cuja posse decide o que volta). O `done` não
     guarda as outras tarefas: a posse delas vem também das travas do jlock, que o `claim` pega antes do evento.
   - O relógio (`sweepAwaiting`) decide sobre a geração da tarefa que leu: marcar o fim do processo, encerrar uma
     espera `inline` e expirar uma espera só valem se a tarefa não mudou desde a leitura (além de conferir `since` e
     `endedAt`). Uma mudança qualquer no meio (um `exec` que acabou) adia a decisão para a próxima passada, nunca
     solta travas nem volta arquivos ao HEAD com base numa foto velha.
   - `renew` roda sob a chave da árvore só quando há o que renovar ou retomar, para não correr junto com um `done` ou
     `release` da mesma tarefa.
   - Um leitor reescreve os snapshots só depois de dobrar 64 eventos ou mais (quem grava um evento sempre reescreve):
     no mod, cada regravação custa processos (`cmd move`), e o painel lê a toda hora.

**Consequência:** nenhuma para quem usa, fora o arquivo novo `events.jsonl` e `format: 2` no `run.json`. Um jtasks
0.3.x não deve escrever numa execução que a 0.4.0 já escreveu.

**O que fazer:** subir CLI, mod e plugin juntos para a 0.4.0. Se o Claude Code cair no meio de uma transição, as
outras transições de árvore da mesma execução esperam o ttl de 10 min (ou `jlock release name:jtasks:<run>:git
--owner <dono>`, que `jlock list` mostra).

## 19. Desenho C: donos em família, `exclusive` com escopo, recursos (0.7.0, jlock 0.3)

**O que mudou:** o jtasks passou a exigir o jlock 0.3.0 (`MIN_JLOCK`; o `doctor` falha abaixo disso) e usa três
coisas dele:

1. **Donos em família.** A tarefa segura suas travas como `gt:<run>/<tarefa>`; o que roda em nome dela segura como
   filho: `gt:<run>/<tarefa>/exec-<id>` (o `jtasks exec`) e `gt:<run>/<tarefa>/tree-<id>` (a chave da árvore em volta
   de uma transição: `start`, `done`, `release`, `claim` com patches, `yield`, `adopt`, perda de posse, renovação).
   O jlock nunca deixa uma trava da tarefa bloquear um filho dela, e dois filhos (dois `exec` da mesma tarefa) se
   excluem como estranhos, então o `serialize` continua valendo entre eles. Sem tarefa (o `resume`, o `undo`, o
   rascunho), o dono é `gt:<run>/~tree-<id>` (ou `~draft-<id>`). Saiu o contorno do ticket 60 em `src/serial.ts`
   (tentar de novo com o dono da tarefa exclusiva quando o `*` dela recusava a chave da árvore) e o caso especial
   de `*` no `start`: nenhum dos dois é mais necessário.
2. **`exclusive` com escopo.** `"project"` (ou `true`) trava a raiz do repositório em modo exclusivo, não `*`: a
   tarefa roda sozinha no repositório e não bloqueia nem espera travas de outros projetos. `"machine"` trava também
   `resource:machine` exclusivo. Nada no jtasks segura `*`.
3. **Recursos e modos.** `uses` no plano (`"desktop"`, `"clipboard"`, `"port:8080"`, `{ "resource", "mode" }`)
   vira chaves `resource:` do jlock, validadas no `validate`/`plan` contra o catálogo (`jlock resources --json`; sem
   jlock, o catálogo embutido igual ao do jlock 0.3) com sugestão do nome mais próximo. Toda tarefa segura
   `resource:machine` compartilhado, então uma tarefa `"machine"` espera as que estão rodando (de qualquer execução e
   projeto) e impede novas, só entre participantes do jtasks.

**Por quê:** numa execução real, uma tarefa `exclusive` segurava `*`, que bloqueava (e era bloqueado por) travas de
projetos sem relação na máquina inteira; e o `jtasks exec` usava um dono novo `gt:<run>/exec-…`, que sob a tarefa
exclusiva da própria execução esperava uma chave que a tarefa segurava: deadlock, abortado depois de 600 s duas
vezes. O contorno do ticket 60 resolvia só a chave da árvore.

**Decidido pelo lado seguro, fora do pedido:**
- `"machine"` implica `"project"`: a tarefa trava a raiz do repositório e `resource:machine`, porque a posse dela
  continua sendo "tudo" (`.`) para a guarda e para o `done`.
- O modo de cada `uses` é resolvido na validação (o que o plano diz, senão o padrão do catálogo) e gravado na
  tarefa como `{ resource, mode }`: a fronteira decide sem perguntar ao jlock.
- A fronteira (`next`, `status`, painel, keepalive) lê `jlock list` da máquina inteira (antes, só sob o repositório
  quando não havia `*`), porque recursos são da máquina. A razão de um bloqueio por recurso traz o dono, o modo e a
  descrição do jlock no idioma da ferramenta.
- O que a tarefa segura conta só pelas travas do próprio dono (`holders` do jlock 0.3, não só o primeiro): uma chave
  compartilhada como `resource:machine` tem travas de outras tarefas. A renovação (`renew`) olha e renova só as
  travas do dono da tarefa; as aninhadas dos filhos acabam com a trava em que estão.
- Duas tarefas independentes que usam o mesmo recurso exclusivo são um aviso (vão rodar uma de cada vez), não um
  erro; e o `validate` avisa, por palavras-chave fixas (inglês e português), a tarefa que fala em mouse/teclado,
  área de transferência, porta fixa ou medições sem declarar `uses` (para medições, `"exclusive": "machine"`).
- Os testes que chamam o jlock direto usam `JLOCK_BIN` (antes, sempre o `jlock` do PATH): misturar o 0.2 instalado
  com o 0.3 no mesmo `JLOCK_HOME` não funciona.

**Consequência:** toda tarefa agora segura pelo menos uma chave (`resource:machine`), inclusive a sem arquivos, e o
`start` diz "2 chave(s)" para uma tarefa de um arquivo. Execuções e travas da 0.6 não são lidas (o jlock 0.3 não lê
travas do 0.2, e `exclusive: true` gravado num `tasks.json` antigo vale como `"project"`); sem compatibilidade com
versões anteriores, por decisão do usuário.

**O que fazer:** sem nenhuma execução ativa, instalar o jlock 0.3 e o jtasks 0.7.0 juntos (CLI, mod e plugin).

## 20. Native foreground custody and host deadlines (0.8, jlock 0.4)

The Node/Bun host previously killed only its immediate child and waited for `close`; descendants could retain
its pipes indefinitely. Claude uses `$.process.run` instead, whose timeout rejects and whose output is capped
and drained. That difference reduces this failure mode; it does not prove descendant custody in the engine.

Direct `exec` calls enter `jlock exec`; serialized calls use one family-owned `jlock run --total-timeout`,
so a single custodian and deadline cover both queue and payload. Nesting supervisors would create distinct
Unix groups and let a payload escape an outer hard timeout. jlock 0.4.2 is required. A host backstop leaves 15 seconds for native cleanup. Claude's
600-second API maximum therefore permits a 585-second command deadline; explicit larger values are refused
before launching. Node/Bun drains all output while retaining bounded tails; Claude truncation flags are visible.
Claude Bash serialization also uses JLOCK_BIN and a distinct family child owner per call instead of a reused
owner outside the task family. Persistent background services remain outside foreground execution.

Timeout 124 preserves task status, attempts, task locks and edits. It never automatically releases ownership,
retries, commits or marks completion. Inspect evidence before retrying; preserve locks on cleanup-pending.
No changes to event generations, tree serialization, same-agent waits, transient pause, patch recovery,
renew-in-place, resource modes or registry format. Install alongside old active versions; never replace their
binaries, plugin sources or running modules. Unix detachment and hard supervisor death, Docker daemon jobs and
remote jobs retain explicit lifecycle limits. This is bounded failure containment, not universal fault immunity.
