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

**O que mudou:** o plano supunha que o `tasks` ficaria aberto segurando a trava e a devolveria pela entrada padrão
do `hold`. Cada comando do CLI termina na hora, então o `start` deixava o `hold` rodando sozinho em segundo plano, com
código próprio para destacá-lo, e o `done` o encerrava com `jlock release`.

**Consequência:** funciona igual para quem usa; cada tarefa em andamento tem um processo do jlock em segundo plano
até o `done`.

**O que fazer:** o jlock ganhou `hold --detach` nativo (uma chamada, resposta na mão, o próprio jlock segura a
trava) e `--ttl`. O ticket 21 troca o código próprio por `--detach --ttl` no CLI e no mod; o plano (rev. 5.2, seções
4 e 20) já diz isso.

## 2. No Windows, uma trava pode ficar presa se a janela cair (ticket 04) — resolvido por J18 (jlock) e 21

**O que mudou:** o plano dizia que, se a janela morre, as travas somem em até 30 s. O `jlock hold` ignorava o fim da
entrada padrão e, no Windows, encerrar um processo não encerra os filhos: o `hold` continuava vivo e renovando.

**Consequência:** se o OpenCode ou o Claude Code fechassem de forma abrupta, a trava ficava até alguém soltar à mão
com `jlock release`; outras tarefas que precisassem do arquivo esperavam.

**O que fazer:** três casos, três respostas. A janela inteira cair: o jlock ganha `hold --release-on-eof` (ticket 18
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
outro dono no jlock) ficam no disco, fora do commit; as de ninguém fazem o `done` recusar, sugerindo `tasks claim`.

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
agente usar (`opencode.agent`); sem perfis no plano, valem os padrão (`implement`, `implement-deep`, `review`). O
plugin escolhe o agente certo para cada tarefa e aplica o modelo do perfil, mas não os cria.

**O que fazer:** o pacote passa a trazer os três agentes prontos (ticket 20) e o `tasks doctor --fix` os instala em
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
andamento apareciam como "posse perdida" (o `tasks resume` as devolvia à fila); com `--detach`, a trava sobrevive ao
recarregamento. Os testes do mod rodam numa máquina simulada (`claude/tests/machine.ts`), porque o
`claude plugin test` não tem disco nem processos reais.

**O que fazer:** o fluxo real com git e jlock é coberto pelo núcleo e pelo plugin do OpenCode; o mod num Claude Code
de verdade é o ticket 30 (dirigido pelo herdr, com haiku).

## 10. O comando é `/jtasks`, não `/tasks` (ticket 15) — absorvido no plano (rev. 5.2)

**O que mudou:** o Claude Code já tem um `/tasks` próprio (as tarefas em segundo plano) e recusaria o registro. O
nome `/jtasks` foi escolhido pelo usuário.

**Consequência:** só o nome, e só no Claude Code: no OpenCode a seção fica na barra lateral e se dobra com um clique;
a ferramenta do modelo e o CLI continuam se chamando `tasks`.

**O que fazer:** nada; está na seção 14 do plano.
