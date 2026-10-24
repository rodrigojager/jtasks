# Desvios do plano

O que saiu diferente de `docs/PLAN.md` durante a implementação: o quê, por quê e o que foi feito no lugar.

## 1. O `hold` do CLI vive destacado e é devolvido por `jlock release` (ticket 04)

**O plano:** `start` e `claim` sobem um `jlock hold`; `done`/`skip`/`fail`/`release` escrevem `release` na entrada
padrão de cada `hold`; `jlock release --group --owner` só como reserva, de outra janela.

**Por quê:** o CLI `tasks` é um processo curto: termina logo depois de cada comando, e com ele a entrada padrão do
`hold`. Não há quem escreva `release` depois.

**No lugar:** no CLI o `hold` sobe destacado (sem console, entrada padrão fechada, saída num arquivo da execução,
`holds/<tarefa>-<n>.out`) e é devolvido por `jlock release --group <run> --owner gt:<run>/<tarefa>`; o `hold`
percebe no próximo heartbeat e sai com 14, que aqui é esperado. Os hosts de processo longo (plugin do OpenCode,
testes) mantêm o `hold` ligado e usam a entrada padrão, como o plano diz; o mod do Claude Code tem o seu caso
(desvio 3).

## 2. Um `hold` cujo dono morreu não morre junto no Windows (ticket 04)

**O plano:** "se a janela morre, os `hold`s morrem com ela e as travas somem em ≤ 30 s".

**Por quê:** o `jlock hold` ignora o fim da entrada padrão (EOF): continua vivo e renovando. No Windows, encerrar
um processo não encerra os filhos; um `hold` filho de uma janela que caiu fica órfão e segura a trava para sempre
(verificado com o jlock 0.1.0: `hold` com stdin fechado continua `granted`).

**No lugar:** o host que segura `hold`s encerra a própria árvore ao sair (o Claude Code encerra os filhos de
`$.process.spawn` quando o módulo descarrega; os testes simulam a janela morta encerrando a árvore do processo pelo
PID). Para o jlock fica o pedido, a registrar no plano dele: `jlock hold --release-on-eof` (ou `--parent <pid>`),
que solta a trava quando a entrada padrão fecha; com isso, qualquer dono que morre solta a posse sem depender do
host. Nada foi mudado no jlock.

## 3. Trava curta de escrita da execução (ticket 02)

**O plano:** gravação atômica (`.tmp` + `rename`), releitura antes de escrever e `revision` incremental.

**Por quê:** a releitura antes de escrever deixa uma janela entre a releitura e o `rename`: dois processos que leem
a mesma revisão gravam os dois, e uma mudança se perde (o teste de `revision` concorrente mostrou isso).

**No lugar:** além do que o plano pede, cada leitura-mudança-escrita roda sob uma trava curta da execução, uma pasta
`.write.lock` criada de forma exclusiva (atômica em qualquer sistema de arquivos); uma trava com mais de 10 s é de
um processo morto e é quebrada. A `revision` continua recusando escrita baseada em leitura velha.

## 4. `next` não vê um `*` de fora do repositório (ticket 04)

**O plano:** `next` lê `jlock list --under <repo> --json` uma vez.

**Por quê:** a chave `*` (tarefa `exclusive` de qualquer execução da máquina) não é um caminho e não aparece em
`--under`.

**No lugar:** `next` lê `--under <repo>`, e a lista inteira da máquina quando a execução tem tarefa `exclusive`
em jogo. Um `*` segurado por outra execução sem `exclusive` na nossa só aparece no `start`, que recebe `queued` do
jlock e responde "não estava pronta" sem gravar nada.

## 5. `done` tolera mudanças que estão na posse de outra tarefa em andamento (ticket 05)

**O plano:** no `done`, arquivos modificados fora da posse → recusa.

**Por quê:** as tarefas paralelas trabalham no mesmo checkout; quando T01 termina, os arquivos que T02 (ainda em
andamento) já mudou aparecem no `git status` e estão fora da posse de T01. Recusar travaria todo `done` enquanto
houver outra tarefa em andamento.

**No lugar:** o `done` separa as mudanças em três grupos: da posse da tarefa (vão para o commit), da posse de outra
tarefa em andamento da execução ou de uma chave que outro dono segura no jlock sob o repositório (ficam no disco,
fora do commit), e de ninguém (recusam o `done`, com a lista e a sugestão de `tasks claim`).

## 6. `attempts` conta no `start`; `--keep-owners` não libera nenhuma (ticket 07)

**O plano:** `release` e `resume` fazem `attempts+1`; `resume` mantém a tarefa que ainda tem travas, "salvo
`--keep-owners` ao contrário".

**Por quê:** contar no `start` dá o mesmo número (tentativas começadas) sem depender de quem libera: um `start`
que não chegou ao `release` (janela morta, posse perdida) também conta. A frase sobre `--keep-owners` é ambígua.

**No lugar:** `start` faz `attempts+1`; `release`, `resume` e posse perdida comparam com `maxAttempts` e viram
`failed` quando chega; `retry` zera a contagem (o histórico fica no `log.jsonl`). `resume --keep-owners` não libera
nenhuma tarefa, nem as sem travas.

## 7. OpenCode: a API real do plugin 2.1.3 (ticket 12)

**O plano (seção 15):** ferramenta por `ctx.tool.register`; ligação em `ctx.storage` com `session.family`; perfis
garantidos por `agent.transform` (efeito `agent-config` no ledger); guarda por "um hook de permissão".

**O que a API tem:** `ctx.tool.transform(editor => editor.add(...))` registra ferramentas (não há
`tool.register`); `session.family` só existe na TUI (`context.data.session.family`), no servidor há
`session.get` com `parentID`; o editor de `agent.transform` tem `list/get/update/remove/default`, sem `add`: um
plugin não cria agentes; e o hook de permissão é `ctx.permission.hook("evaluate")`, com `action` (`edit` para
edit/write/patch, `shell` para comandos) e `resources`.

**No lugar:** a ferramenta é registrada por `tool.transform`; a ligação é guardada por sessão raiz
(`binding/<raiz>`), achada subindo os `parentID`; a sessão filha que fez `start`/`claim` fica ligada à tarefa
(`task/<sessão>`) para a guarda. Os perfis apontam agentes que já existem no `opencode.json`: a chamada
`subagent` de uma tarefa (`--task <id>` no prompt) recebe o agente do perfil (`tool.hook("execute.before")`),
perfil desconhecido recusa a chamada, e um perfil com `opencode.model` dá esse modelo ao agente por
`agent.transform`, só durante a sessão. Como nada é gravado na configuração, não há efeito `agent-config` no
ledger. A guarda decide no `permission.hook("evaluate")` pela regra do núcleo (`src/guard.ts`).

## 8. OpenCode: a barra da seção não vem do HUD (ticket 13)

**O plano (seção 15):** a seção "Tasks" na sidebar usa a barra `Meter` do HUD.

**Por quê:** o HUD é outro projeto (`opencode-hud`), fora deste repositório; importar dele faria o plugin depender
de uma instalação que não é nossa.

**No lugar:** a barra e as linhas vêm do modelo de exibição do núcleo (`src/view.ts`, `bar()` em oitavos de
célula), o mesmo que o painel do Claude Code desenha. O resto saiu como o plano supõe: `context.ui.slot({ append:
"sidebar.content" })`, dados pelo RPC `goal-tasks.state` (`ctx.rpc.register` no servidor, `context.client.rpc` na
TUI), releitura em `session.tool.success`, no evento `changed` do RPC e a cada 2 s enquanto há tarefa em andamento;
o estado dobrado fica em `context.storage.store`.

## 9. Claude Code: o host do mod (ticket 14)

**O plano (seção 14):** a ferramenta usa arquivos por `$.fs`, git e jlock por `$.process.run`, e o `jlock hold`
por `$.process.spawn`; o núcleo grava de forma atômica e fala com o `hold` pela entrada padrão; o resumo fica no
prompt por `prompt.section` + `$.ui.invalidate("prompt.section")`.

**O resumo no prompt:** o Claude Code 2.1.310 não tem `prompt.section`; o evento que compõe o system prompt é
`prompt.compose`, que roda a cada requisição. O mod acrescenta nele a seção `goal-tasks:protocol` (escopo
`session`) enquanto há execução ligada, e por rodar a cada requisição ela volta sozinha depois de uma compactação,
sem `$.ui.invalidate` nem `session.compact`.

**O que a API tem:** `$.fs` lê, grava, lista e faz `stat`, mas não renomeia, não apaga e não cria pasta;
`$.process.spawn` recebe a entrada padrão inteira na partida (`input`) e a fecha, sem escrita depois; e o
validador recusa `$` passado como argumento (`$` é sempre escrito `$.noun.call(...)` no lugar da chamada).

**No lugar:** o `session.start` monta uma "porta" de funções que chamam `$.fs`, `$.process`, `$.clock` e `$.state`
diretamente, guardada no módulo; o host do núcleo (`claude/hooks/mod-host.ts`) é feito dessa porta. Renomear,
apagar e criar pasta (inclusive a pasta exclusiva da trava de escrita) vão por `$.process.run`: `cmd /d /c move
/y`, `rmdir /s /q`, `del /f /q` e `mkdir` no Windows; `mv -f`, `rm` e `mkdir` fora dele. O `hold` sobe por
`$.process.spawn` e o laço que lê a saída o mantém vivo; para devolver, o núcleo chama `jlock release --group
--owner` e encerra o laço (o que encerra o filho). Um recarregamento do módulo encerra os `hold`s da sessão: as
tarefas em andamento aparecem como "posse perdida" no `status` e o `resume` as devolve à fila. Como `claude
plugin test` roda sem sistema de arquivos e sem processos, os testes do mod usam uma máquina falsa
(`claude/tests/machine.ts`: arquivos em memória e as respostas de git, jlock e cmd); o fluxo real com git e jlock
é coberto pelos testes do núcleo e do plugin do OpenCode.

## 10. Claude Code: o comando é `/jtasks`, não `/tasks` (ticket 15)

**O plano (seção 14):** `$.command.register({ name: "tasks" })`; `/tasks` abre e fecha o painel.

**Por quê:** o Claude Code já tem um `/tasks` próprio (as tarefas em segundo plano); `claude plugin validate`
avisa que `$.command.register` recusa esse nome e o hook que o chama seria pulado.

**No lugar:** `/jtasks` (nome escolhido pelo usuário) abre e fecha o painel "Tasks"; o resto como no plano (botão "▾/▸" no cabeçalho, estado
recolhido em `$.store` e espelhado em `$.state`, `$.clock.every(2000)` relendo por mtime de `tasks.json`/`run.json`
e pela lista do jlock enquanto o painel está aberto). Os átomos de `$.state` ficam em `register.tsx`, porque o
validador só aceita a referência escrita no próprio arquivo que a usa.
