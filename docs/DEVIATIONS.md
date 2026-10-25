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

## 4. O `next` não enxerga, num caso raro, uma tarefa exclusiva de outro projeto (ticket 04)

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
