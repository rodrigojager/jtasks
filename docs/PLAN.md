# goal-tasks — plano

Lista de tarefas determinística, com dependências e paralelismo, acompanhada por uma barra de progresso e um
checklist no Claude Code (mod) e no OpenCode (plugin), compatível com o `/goal` dos dois.

Revisão 4, 23/10/2026: a posse de arquivos passa a ser imposta por um serviço de travas com fila (pré-requisito,
plano próprio: o jlock, em `D:\jlock\docs\PLAN.md`); worktrees só sob demanda; livro-razão de tudo que a
ferramenta cria. Nada foi implementado ainda.

> Este arquivo foi convertido em 24/10/2026 de `docs/reference/plano.html` (revisão 4), sem mudança de conteúdo.
> O HTML fica como referência histórica; a partir daqui, a fonte de verdade é este Markdown.

---

## 1. As decisões

- **A fonte da verdade é um arquivo JSON por execução, no projeto, escrito só por uma ferramenta.** A ferramenta
  `tasks` (mod no Claude Code, plugin no OpenCode, CLI no terminal) valida esquema e transições e grava de forma
  atômica. O modelo escolhe a ação; nunca edita JSON nem Markdown.
- **O JSON nasce validado:** a skill entrega o plano pela ferramenta, e os tickets Markdown são gerados dele. O
  passo final da `to-tickets` chama `tasks plan`; a ferramenta devolve os erros exatos até passar, e só então grava.
- **Paralelismo por posse de arquivos, na mesma pasta, sem worktrees, com travas de verdade.** Cada tarefa declara
  os arquivos (ou globs) que vai tocar. A posse é adquirida no jlock (CLI de travas da máquina, plano próprio): um
  dono por chave, fila em ordem de chegada para quem espera, dois pedidos simultâneos resolvidos por criação atômica
  de arquivo, travas de processo morto recuperadas por heartbeat, e deadlock detectado antes de entrar na fila. Um
  subagente que precisa de um arquivo não declarado pede com `tasks claim`: se estiver em uso, ele entra na fila e a
  tarefa ganha uma dependência dinâmica ("aguardando T02: types.ts"), visível no painel. A guarda nas ferramentas
  de edição recusa qualquer escrita fora da posse. O ralph v1 já fazia a posse estática com `files_allowed`; a fila
  e a espera são o que faltava.
- **Commits por tarefa, feitos pela ferramenta.** O subagente não roda git. No `done`, a ferramenta faz `git add` só
  dos arquivos da posse e um commit `T04: título`. Cada tarefa vira um commit isolado: reverter uma tarefa é
  `git revert` de um commit, e o diff de cada tarefa fica auditável.
- **Worktrees existem, mas só quando a execução pede.** Política `worktrees: "none"` por padrão. `"per-task"` fica
  para o caso de tarefas que precisam tocar os mesmos arquivos ao mesmo tempo ou rodar builds que colidem. Quando
  usadas, são registradas, integradas e removidas pela ferramenta.
- **Tudo que a ferramenta cria fora do código entra num livro-razão, e tem desfazer.** Branches, commits, worktrees,
  junções, pastas, linhas em `.git/info/exclude`, arquivos arquivados: cada efeito é um registro com como desfazê-lo.
  `tasks ledger` lista; `tasks undo` desfaz na ordem inversa, recusando quando há trabalho não salvo. Nada do que
  fizermos vira caça ao tesouro depois.
- **Os projetos de hoje não são tocados.** `tasks gc --scan` é só relatório por padrão: lista pastas, tamanhos,
  idades, quem é o dono e se o branch foi integrado. Agir exige o caminho explícito e `--yes`. Nada roda sozinho nos
  três projetos em andamento.
- **Cada execução tem um id, e a interface mostra só a execução ligada à sessão atual.** N janelas no mesmo projeto
  não se misturam; a ligação fica no estado da sessão, não num ponteiro global.
- **Retomar, pausar e tentar de novo são ações da ferramenta.** "De onde parou" é a fronteira do grafo.
- **Tudo de desenvolvimento fica sob `.scratch/goal-tasks/`**, excluído do git localmente, e some com um comando.
- **Um núcleo compartilhado, em um repositório só; as interfaces só leem; o `/goal` continua sendo o motor.**
  Progresso = `floor(feitas / total × 100)`, com feitas/total, puladas e falhas ao lado.

---

## 2. Arquitetura e pastas

```
projeto/
├─ .scratch/goal-tasks/                 ← só desenvolvimento (excluído do git em .git/info/exclude)
│   └─ runs/
│       ├─ cursory-261023-k7f2/          ← uma execução (run-id = slug-data-4 aleatórios)
│       │   ├─ run.json                 ← meta: objetivo, status, política, sessões ligadas
│       │   ├─ tasks.json               ← a lista (fonte da verdade), com a posse de cada tarefa
│       │   ├─ tickets/NN-slug.md       ← gerados a partir do tasks.json (leitura humana)
│       │   ├─ ledger.jsonl             ← cada efeito criado (branch, commit, worktree…) e como desfazer
│       │   └─ log.jsonl                ← cada transição, com hora, ator e evidência
│       └─ auth-261024-p0q9/            ← outra execução, de outra janela
└─ (código do projeto: edições só dentro da posse de cada tarefa)

%USERPROFILE%\.goal-tasks\
├─ ledger.jsonl                         ← índice global: todo efeito de todos os projetos
└─ archive\<repo>\<run>\                 ← execuções arquivadas

D:\worktrees\<repo>\<run>\<task>\        ← só quando a execução pede worktree

Claude Code: mod `goal-tasks` (ferramenta + painel + /tasks)   ─┐  mesmo core.js
OpenCode:    plugin `goal-tasks` (ferramenta + seção na sidebar) ─┤
Terminal:    CLI `tasks` (bun)                                  ─┘
```

Núcleo em TypeScript sem dependências, compilado para um `core.js` versionado: o módulo de hooks do Claude Code roda
sem Node e sem `node_modules`, e a cópia final do OpenCode também.

---

## 3. Do plano às tarefas, sem parser frágil

- A `to-tickets` continua igual nos passos 1 a 4 (contexto, código, fatias verticais, aprovação sua). Ganha uma
  pergunta a mais no passo 4: quais arquivos cada fatia toca. A skill já explora o código, então sabe responder.
- O passo 5 chama `tasks plan` com a lista em JSON (`id`, `title`, `what`, `dependsOn`, `files`, `acceptance[]`,
  `profile`, `boundary`).
- `tasks plan` valida e devolve erros exatos: id repetido, dependência inexistente, ciclo, perfil desconhecido,
  posse em comum entre tarefas sem dependência entre si ("T04 e T05 tocam `src/humanizer/move.ts` e podem rodar
  juntas: adicione uma dependência ou separe o arquivo"). O modelo corrige e chama de novo. Nada é gravado até
  passar.
- Ao passar, grava `tasks.json` e gera `tickets/NN-slug.md` (com uma seção Files). O ticket é visão; o JSON é a
  verdade.

Tickets antigos: `tasks import <dir> --check` relata o que leu e o que faltou (os de hoje não têm posse: a
importação marca essas tarefas como `exclusive`, isto é, nunca em paralelo, até alguém declarar os arquivos). Onde a
skill fica: hoje em `~\.agents\skills`; para o Claude Code, dentro do próprio plugin (`skills/`).

---

## 4. Paralelismo por posse de arquivos

### Regras

- `files` é uma lista de caminhos ou globs relativos ao repositório. `exclusive: true` significa "toca coisa demais
  ou desconhecida": roda sozinha.
- **Fronteira:** tarefa pronta = pendente, dependências satisfeitas, e posse livre no jlock (nenhuma chave em uso ou
  em interseção com uma em uso, por qualquer execução, ferramenta ou script na máquina; as chaves são caminhos
  absolutos, e uma pasta travada cobre o que está dentro dela). Interseção é calculada por glob; na dúvida, conta
  como interseção. `start` adquire todas as chaves da posse de uma vez, em ordem canônica (sem espera: se alguma
  estiver em uso, a tarefa não estava pronta). Uma tarefa `exclusive` adquire a chave `*`, que conflita com tudo.
- **Validação do plano:** duas tarefas sem relação de dependência e com posse em comum são um erro. Isso força o
  planejador a decidir a ordem na hora do plano, não na hora da execução.
- **Pedido em tempo de execução:** `tasks claim T04 src/x.ts` adquire a trava no jlock. Livre → entra na posse na
  hora. Em uso → a tarefa entra na fila dessa chave e fica `waiting` (estado derivado), com
  `waitingFor: { key, holder: "T05", position }`; a chamada espera até ser atendida ou até `--timeout`, e então o
  subagente decide: continuar esperando, fazer o que não depende daquele arquivo, ou `tasks fail`. Se o pedido
  criaria um deadlock (T05 já espera por algo de T04), o jlock recusa com a cadeia, e a resposta diz quem deve
  ceder. Todo `claim` vai para o log; no fim, a ferramenta sugere atualizar o plano com o que foi reclamado.
- **Guarda:** no Claude Code, `tool.call` em `Edit`/`Write`/`NotebookEdit` do subagente é recusado fora da posse,
  com a mensagem "fora da posse de T04; use `tasks claim`". `Bash` de subagente é recusado quando o comando é
  mutador de git (`commit`, `checkout`, `reset`, `stash`, `add`) ou de arquivos (`rm`, `mv`, `>`, `sed -i`) fora
  da posse. Leitura, build e teste são livres. No OpenCode, um hook de permissão aplica as mesmas regras.
- **Builds e testes que colidem** (mesma pasta de saída, mesma porta): a tarefa declara `exclusive: true` ou a
  execução define um `serialize: ["bun test", "dotnet build"]`, e a ferramenta enfileira esses comandos entre
  tarefas em andamento. Alternativa: uma tarefa final de integração, bloqueada por todas, roda a suíte uma vez.

### Por que a trava do Windows não basta

A trava que o Windows dá ao abrir um arquivo (modo de compartilhamento) vale enquanto o handle está aberto, é
obrigatória para todos (travaria o seu editor também), morre com o processo e não tem fila nem identidade de tarefa.
As ferramentas de edição dos agentes abrem, escrevem e fecham em milissegundos; a posse de que precisamos dura a
tarefa inteira (minutos), atravessa dezenas de aberturas e processos que nascem e morrem, e precisa de fila, lista e
sobrevivência a crash. São problemas diferentes. O jlock é o preço do paralelismo na mesma pasta sem worktrees; com
um agente por vez, nada disso seria necessário.

### Por que travar por arquivo, não por função

Travar por função (duas tarefas editando funções diferentes do mesmo arquivo) parece dar mais paralelismo, mas não
se sustenta:

- O arquivo continua sendo gravado inteiro. As ferramentas de edição leem o arquivo todo, alteram e gravam o arquivo
  todo. Dois processos fazendo isso no mesmo arquivo perdem a alteração de um deles (atualização perdida), mesmo que
  em funções diferentes. Para evitar, seria preciso uma trava por arquivo em volta de cada gravação, de qualquer
  jeito.
- Quase toda tarefa toca o que não é função: imports, tipos, constantes, exports, campos de classe. Duas tarefas
  adicionando um import cada colidem fora da "função".
- Assinatura, renomeação, extração e chamadas no mesmo arquivo atravessam funções: a posse teria de ser renegociada
  o tempo todo, com mais `claim`, mais decisões do modelo e mais falhas.
- Depende de um parser por linguagem, e de analisar código no meio de uma edição, muitas vezes com erro de sintaxe:
  a guarda não consegue decidir de forma determinística. Arquivos sem funções (JSON, Markdown, CSS) ficam de fora.
- Commit por tarefa e testes quebram: o arquivo na árvore de trabalho mistura as duas edições pela metade; o commit
  teria de ser por trecho (frágil), e os testes de uma tarefa rodam com o código inacabado da outra.

Quando um arquivo é um "hub" (um `routes.ts` gigante, um `types.ts` central) e a posse por arquivo serializa demais,
o remédio determinístico é o que a própria `to-tickets` já manda: pré-refatorar, dividindo o hub em módulos numa
tarefa prévia, para que a posse por arquivo volte a ser fina. Fora isso, as tarefas que tocam o hub rodam em
sequência e as outras em paralelo. A trava por função fica registrada como ideia para o futuro, só se um projeto real
mostrar contenção que a pré-refatoração não resolva.

### Commit por tarefa

No `done`, a ferramenta confere o `git status`: arquivos modificados fora da posse → recusa, lista e pede `claim` ou
`release`. Dentro da posse → `git add <arquivos>` e `git commit -m "T04: título"` no branch da execução
(`gt/<run>`, criado a partir do branch atual no `plan`). O hash entra no ledger. Se você preferir trabalhar no
branch atual, `run.json` aceita `branch: "current"`; os commits continuam um por tarefa.

---

## 5. Os arquivos de uma execução

### run.json

```json
{
  "version": 1,
  "id": "cursory-261023-k7f2",
  "feature": "cursory-nativo",
  "objective": "Integrar o gerador de movimento Cursory ao humanizer",
  "status": "active",                        // active | paused | done
  "created": "2026-10-23T22:40:00Z",
  "repo": { "root": "D:/Temp/spybrowser", "baseBranch": "main", "branch": "gt/cursory-261023-k7f2" },
  "worktrees": { "policy": "none" },         // ou { "policy": "per-task", "root": "D:/worktrees/spybrowser", "deps": "pnpm-store" }
  "serialize": ["bun test"],
  "maxAttempts": 2,
  "sessions": [ { "tool": "claude", "id": "a8ec2aca…", "boundAt": "…" } ]
}
```

### tasks.json

```json
{
  "version": 1, "run": "cursory-261023-k7f2", "revision": 41,
  "profiles": {
    "impl":   { "claude": { "model": "sonnet", "effort": "medium", "role": "backend-developer" }, "opencode": { "agent": "impl" } },
    "deep":   { "claude": { "model": "opus",   "effort": "high" },                                "opencode": { "agent": "impl-deep" } },
    "review": { "claude": { "model": "sonnet", "effort": "high",   "role": "code-reviewer" },     "opencode": { "agent": "review" } }
  },
  "tasks": [
    { "id": "T01", "title": "Tornar o movimento substituível", "status": "done",
      "dependsOn": [], "profile": "impl",
      "files": ["src/humanizer/trajectory.ts", "src/humanizer/move.ts", "tests/humanizer/**"],
      "acceptance": [ { "text": "Automação local percorre movimento, hover e clique", "done": true } ],
      "attempts": 1, "owner": null, "startedAt": "…", "finishedAt": "…",
      "commit": "9f1c2ab", "evidence": "bun test: 93 passed; regressão local idêntica antes/depois" },
    { "id": "T02", "title": "Gerador de gravações nativo", "status": "in_progress",
      "dependsOn": ["T01"], "profile": "impl", "files": ["src/recorder/**"],
      "claimed": ["src/humanizer/types.ts"],
      "attempts": 2, "owner": "claude:a8ec2aca/agent:7f3a", "startedAt": "…" },
    { "id": "T03", "title": "Paridade completa", "status": "skipped", "dependsOn": ["T01"], "profile": "deep",
      "files": ["src/humanizer/parity/**"], "reason": "coberto por T01 após a refatoração" },
    { "id": "T04", "title": "Mouse move", "status": "failed", "dependsOn": ["T02"], "profile": "impl",
      "files": ["src/humanizer/move.ts"], "attempts": 2, "error": "src/humanizer/types.ts em uso por T02" },
    { "id": "T05", "title": "Atraso e escala", "status": "pending", "dependsOn": ["T02"], "profile": "deep",
      "files": ["src/humanizer/timing.ts"] },
    { "id": "T12", "title": "Integração: suíte completa", "status": "pending",
      "dependsOn": ["T05", "T06", "T07"], "profile": "review", "exclusive": true }
  ]
}
```

### Estados

| Gravado | Significa | Transições |
|---|---|---|
| `pending` | ainda não começou | → `in_progress` (só se pronta e a execução não estiver pausada), → `skipped` |
| `in_progress` | tem `owner`, `startedAt` e a posse travada | → `done` (exige `evidence`; faz o commit), → `skipped`, → `failed` (exige `error`), → `pending` por `release` |
| `done` | concluída e commitada | final; `retry` reabre (o commit anterior fica no histórico) |
| `skipped` | pulada com motivo; libera as dependentes | `retry` → `pending` |
| `failed` | erro ou `maxAttempts`; bloqueia as dependentes | `retry` → `pending`; `skip` → `skipped` |

Derivados, nunca gravados: `ready` (pendente, dependências satisfeitas, posse livre), `blocked` (dependência aberta
ou falha, ou posse em uso) e `waiting` (em andamento, na fila de uma chave de outra tarefa). O painel mostra o
motivo: ⛔ T04, 🔒 T02 ou ⏳ T02: types.ts.

### Regras do núcleo

- ids únicos e estáveis; dependências existentes; sem ciclos; posse sem conflito entre independentes.
- `start` falha se não pronta, com dono, posse em uso, ou execução pausada.
- `done` sem evidência é recusado; com arquivos modificados fora da posse também.
- Gravação atômica (`.tmp` + `rename`), releitura antes de escrever, `revision` incremental.

---

## 6. A ferramenta `tasks`

Mesmo nome e contrato nas três formas. Resposta em texto compacto e em JSON. Todas aceitam `run` opcional; sem ele,
a execução ligada à sessão.

| Grupo | Ação | O que faz |
|---|---|---|
| plano | `plan` | cria a execução a partir do JSON validado (inclusive conflito de posse); gera os tickets; cria o branch; liga à sessão; exclui `.scratch/` do git localmente (efeito no ledger) |
| | `import <dir> [--check\|--yes]` | tickets Markdown antigos → nova execução (tarefas sem posse viram `exclusive`) |
| | `validate <json\|dir>` | valida sem gravar |
| execução | `runs` | lista as execuções do projeto com status e progresso |
| | `resume <run> [--keep-owners]` | liga a sessão, tira de `paused`, libera tarefas de agentes que já não existem, mostra status e fronteira |
| | `pause` / `unpause` | pausa: `start` recusado; o protocolo manda parar |
| | `status` | `feitas 7/12 (58%) · 1 pulada · 1 falha · 2 em andamento · restam 3` + fronteira + travas ativas |
| tarefa | `next [limit]` | as prontas, com perfil, critérios, posse e caminho do ticket |
| | `start id` | → em andamento; trava a posse |
| | `claim id <arquivo…>` | acrescenta à posse se livre; senão "em uso por Txx" |
| | `done id --evidence` | confere o status do git → commit só da posse → feita → libera a posse |
| | `skip id --reason` / `fail id --error` | pular ou registrar falha; libera a posse |
| | `retry id` / `retry --all-failed` | pulada ou falha → pendente |
| | `release id` | em andamento → pendente (`attempts+1`; no `maxAttempts` vira `failed`); edições não commitadas ficam no disco e são listadas |
| ledger | `ledger [--all-projects]` | tudo que a ferramenta criou: tipo, caminho, execução, tarefa, hora, estado (ativo/desfeito) |
| | `undo <id> \| --run <run> \| --task id` | desfaz na ordem inversa (revert de commit, remoção de branch/worktree/junção/pasta, linha do exclude); recusa se houver trabalho não salvo |
| | `effects --check` | compara o ledger com o disco e o git: o que sumiu por fora, o que ficou |
| worktrees | `worktrees` | registro da execução × `git worktree list` × disco (só se a política usar) |
| | `gc --scan <raiz> [--yes]` | relatório: pastas, tamanho, idade, repositório dono, branch integrado?; só remove com caminho explícito e `--yes` |
| limpeza | `clean [run\|--all] [--yes]` | remove a pasta da execução; antes, lista os efeitos ainda ativos no ledger e pede confirmação |
| | `archive run` | move para `%USERPROFILE%\.goal-tasks\archive\<repo>\<run>`; `resume --from-archive` traz de volta |

---

## 7. Livro-razão e desfazer

Toda ação da ferramenta que deixa algo no disco ou no git fora do próprio código da tarefa escreve um registro em
`ledger.jsonl` da execução e no índice global `%USERPROFILE%\.goal-tasks\ledger.jsonl`:

```json
{ "id": "e-0007", "at": "2026-10-23T23:02:10Z", "run": "cursory-261023-k7f2", "task": "T01",
  "type": "commit", "repo": "D:/Temp/spybrowser", "ref": "9f1c2ab", "branch": "gt/cursory-261023-k7f2",
  "undo": { "kind": "git-revert", "ref": "9f1c2ab" }, "state": "active" }
{ "id": "e-0002", "type": "branch",   "ref": "gt/cursory-261023-k7f2", "from": "main", "undo": { "kind": "git-branch-delete" } }
{ "id": "e-0001", "type": "exclude",  "path": ".git/info/exclude", "line": ".scratch/", "undo": { "kind": "remove-line" } }
{ "id": "e-0011", "type": "worktree", "path": "D:/worktrees/spybrowser/…/T05", "undo": { "kind": "worktree-remove" } }
{ "id": "e-0012", "type": "junction", "path": "D:/worktrees/…/T05/node_modules", "undo": { "kind": "rmdir-junction" } }
```

- Tipos: `exclude`, `branch`, `commit`, `worktree`, `junction`, `dir`, `archive`, `agent-config` (agentes criados no
  `opencode.json`).
- `tasks ledger` responde "o que está sendo feito" em qualquer momento, por execução ou por projeto, inclusive de
  outras janelas, porque o índice global é um arquivo só.
- `tasks undo` desfaz na ordem inversa e marca `state: "undone"`. Recusa quando o alvo tem mudanças não salvas
  (worktree suja, branch com commits não integrados) e diz o que fazer. Um `git revert` cria um commit novo, que
  também entra no ledger.
- `tasks effects --check` acha o que foi removido por fora (pasta apagada à mão) e marca `state: "gone"`, e o que
  ficou de uma execução já limpa.
- Projetos atuais: o que não passou pela ferramenta não está no ledger, e não vai estar. Para eles, o que existe é o
  relatório do `gc --scan`, para quando os três terminarem.

---

## 8. N janelas, N execuções

- Id: `<slug>-<aammdd>-<4 aleatórios>`, no nome da pasta, do branch, do `owner` de cada tarefa e dos efeitos do
  ledger.
- Ligação sessão → execução: Claude Code em `$.state` (estado da sessão; sobrevive a reload e compactação); OpenCode
  em `ctx.storage` por sessão raiz, filhas herdam pela `session.family`. Nenhum ponteiro global no disco.
- Subagentes herdam a ligação e recebem `--run <id> --task T04`; chamada com `run` diferente do ligado é recusada.
- Interface: só a execução ligada; sem ligação, a lista de `tasks runs`.
- Duas janelas na mesma execução dividindo a fronteira: funciona, por dono único, posse e `revision`.
- Duas execuções no mesmo projeto ao mesmo tempo: as travas do jlock são da máquina inteira (registro em
  `%LOCALAPPDATA%\jlock`), não da execução. Duas execuções, ou um Claude Code e um OpenCode em janelas diferentes,
  disputam os mesmos arquivos pela mesma fila; quem chegou depois espera. O painel mostra
  "aguardando auth-261024-p0q9/T03".

---

## 9. Retomar, pausar, tentar de novo

- **Retomar:** `tasks resume <run>` em qualquer janela. A posição é a fronteira; `next` devolve as primeiras não
  executadas. Tarefas em andamento de agentes mortos são liberadas (as edições não commitadas ficam no disco e são
  listadas para a próxima tentativa aproveitar ou descartar).
- **Pausar:** `tasks pause`: `start` recusado; o resumo no prompt diz "pausada: não inicie tarefas"; os subagentes
  em andamento terminam.
- **Tentar de novo:** `tasks retry T04`; histórico no `log.jsonl`; `attempts` conta.
- **Falha automática:** `release` no fim de agente morto; no `maxAttempts` vira `failed`, dependentes ficam
  `blocked`, o resto segue. O goal termina com "restam N (M falhas)".

---

## 10. Worktrees, só sob demanda

Com posse por arquivo, a maioria das execuções não precisa de worktree. Ela entra quando duas tarefas precisam do
mesmo arquivo ao mesmo tempo (raro, e quase sempre sinal de fatia mal cortada) ou quando builds/testes colidem de um
jeito que `serialize` não resolve. Nesse caso, `worktrees.policy = "per-task"`, e vale tudo o que segue, sempre pelo
ledger:

- Raiz central fora do repositório (`D:\worktrees\<repo>\<run>\<task>`), caminhos curtos.
- Branch por tarefa a partir do branch da execução; no `done`, `merge --no-ff` numa worktree de integração da
  execução, nunca no seu checkout. Conflito → `failed`; `tasks merge` depois de resolver.
- Dependências sem cópia (NTFS não tem copy-on-write): pnpm store com hard links; ou junção de `node_modules` para o
  checkout principal com lockfile igual; ou instalação própria só se o lockfile mudou. Estratégia registrada.
- Remoção após o merge; arquivo aberto no Windows → `remove-pending` e nova tentativa no `gc`. Nunca mata processos.
- Guarda de escopo: subagente só edita dentro da sua worktree.

O que já existe (Claude Code `EnterWorktree`/`Agent isolation`, OpenCode API worktree, herdr worktree) cria mas não
integra nem limpa; é daí que vêm as órfãs. Não vamos usar essas rotas para subagentes; quando a nossa política criar
worktree, é a ferramenta que cria, registra e remove.

---

## 11. Limpar e arquivar

- Tudo em `.scratch/goal-tasks/`, excluído do git em `.git/info/exclude` (local). Tickets antigos ficam onde estão.
- `tasks clean <run>`: mostra os efeitos ainda ativos no ledger (branch, worktrees) e pergunta se desfaz junto;
  apaga a pasta da execução. `--all` remove `.scratch/goal-tasks/`. Os commits ficam (são código).
- `tasks archive <run>`: move para fora do projeto; `resume --from-archive` traz de volta.
- Plano novo num projeto com N planos antigos: outra execução, ligada à sessão; os antigos só aparecem em
  `tasks runs`.

---

## 12. O fluxo com o `/goal`

```
Planejar     to-tickets (passos 1–4, agora com "quais arquivos") → tasks plan
Claude Code  /goal todas as tarefas da execução cursory-261023-k7f2 estão done ou skipped
             (a ferramenta tasks responde "restam 0")
OpenCode     create_goal com o mesmo objetivo; update_goal com a saída de tasks status
Retomar      em qualquer janela: tasks resume cursory-261023-k7f2 → /goal de novo
```

Protocolo de execução (texto fixo, injetado no sistema enquanto houver execução ligada):

```
1. Chame tasks next.
2. Para cada tarefa devolvida, abra um subagente com o perfil indicado, todos na mesma
   mensagem (paralelo). O prompt leva só: --run <id> --task <id>, título, critérios, posse
   (os arquivos que pode tocar), caminho do ticket, e "chame tasks start no começo; se precisar
   de outro arquivo, tasks claim; não rode git; no fim, tasks done com evidência ou tasks fail".
3. Quando terminarem, chame tasks status. "restam 0" → goal cumprido com essa saída como
   evidência. "pausada" → pare. Senão volte ao passo 1.
4. Nunca edite tasks.json, tickets ou o git à mão; só pela ferramenta.
```

Contexto contínuo (sem subagentes): passo 2 vira "faça a tarefa você mesmo, dentro da posse". Compactação: Claude
Code via `prompt.section` + `session.compact`; OpenCode via hooks `context` e `compaction`. A lista nunca se perde.

---

## 13. Perfis de agente

### Claude Code

`Agent` com `model`, `effort` e `--role <id>` no prompt. O mod reforça em `agent.spawn`: lê `--task`, resolve o
perfil, devolve `{ model }`; perfil desconhecido → `{ deny }`. Provedor sempre Anthropic. O `effort` só por
instrução explícita: o perfil no `tasks.json` é essa instrução.

### OpenCode

Agentes do `opencode.json` com `model: { providerID, modelID, variant }`. O orquestrador chama `subagent` com
`agent: "impl"`. O plugin garante os agentes via `agent.transform` (efeito `agent-config` no ledger).

---

## 14. Claude Code: o mod

```
.claude-plugin/plugin.json   { name: "goal-tasks", version, description, types: "./types/index.d.ts" }
hooks/hooks.json             { "modules": ["./register.tsx"] }
hooks/register.tsx           o módulo (importa ../core/core.js)
types/index.d.ts             PluginState: { "goal-tasks": { run?: string, collapsed: boolean } }
skills/to-tickets/SKILL.md   a skill, viajando com a ferramenta que ela chama
```

| Peça | API do mod | Função |
|---|---|---|
| ferramenta | `$.tool.register` em `session.start` | a `tasks`; arquivos via `$.fs`; git via `$.process.run` |
| ligação | `$.state` (`run`) | execução da sessão; subagentes compartilham |
| painel | `$.ui.open({ id: "tasks" })` + `ui.render` em `{ component: "Pane" }` | checklist + barra; abre sozinho com execução ligada e largura suficiente |
| toggle | `$.command.register({ name: "tasks" })` + `command.run`; botão "▾/▸" via `ui.press` | `/tasks` abre/fecha; o botão recolhe para uma linha; `collapsed` em `$.store` |
| atualização | `$.clock.every(2000)` + `$.fs.stat/read`; `atom/update` | acompanha escritas de outro processo |
| contexto | `prompt.section` + `$.ui.invalidate("prompt.section")`; `session.compact` | resumo sempre no prompt; sobrevive à compactação |
| perfil | `on("agent.spawn")` | modelo do subagente pelo perfil |
| guarda de posse | `on("tool.call", { tool: "Edit" \| "Write" \| "NotebookEdit" \| "Bash" })` com `e.agentId` | recusa edição fora da posse; recusa git mutador e escrita por shell fora da posse; recusa edição direta de `tasks.json` |
| agente morto | `on("turn.complete")` com `e.agentId` | `release` da tarefa que ficou em andamento |

```
▾ Tasks · cursory-261023-k7f2
████████▌░░░░░░░  58% · 7/12 · 1 pulada · 1 falha
☑ T01 Movimento substituível      9f1c2ab
☑ T02 Gerador nativo              3be77d0
⊘ T03 Paridade completa
✗ T04 Mouse move                  types.ts em uso por T02
◐ T05 Atraso e escala             deep·opus
☐ T06 Fill/clear                  ⛔ T04
☐ T07 Insert text                 🔒 T05
…
```

Recolhido: `▸ Tasks 7/12 · 58%`. Pausado: `Tasks · pausada`. Sem ligação: a lista de `tasks runs`.

---

## 15. OpenCode: o plugin

| Peça | API | Função |
|---|---|---|
| ferramenta | `ctx.tool.register` (como o roles) | a `tasks`, lado servidor |
| ligação | `ctx.storage` por sessão raiz; `session.family` | execução da sessão |
| contexto | `ctx.session.hook("context")` e `("compaction")` | resumo em cada requisição |
| seção | `context.ui.slot({ append: "sidebar.content" })` | "▼ Tasks · run", barra `Meter` do HUD, checklist; clique dobra |
| dados | RPC `tasks.state` + releitura após `session.tool.success` | a TUI nunca toca o arquivo |
| perfis | `agent.transform` | agentes impl/deep/review |
| guarda de posse | hook de permissão | mesmas regras do mod |
| goal | sem espelhar em `update_goal_plan` | objetivo + evidência; o paralelismo é nosso |

---

## 16. Onde fica o determinismo

**Determinístico (código):** esquema e validação do plano (inclusive conflito de posse), geração dos tickets,
transições, fronteira com posse, ciclos, dono único, `revision`, gravação atômica, progresso, ligação sessão →
execução, pausa, retomada, falha por `maxAttempts`, guarda de posse e de git, commit por tarefa, ledger e desfazer,
worktrees quando pedidas, `gc` como relatório, limpeza e arquivamento, desenho das interfaces, reinjeção após
compactação, modelo do subagente pelo perfil, liberação de tarefa de agente morto.

**Interpretativo (modelo):** quebrar o plano em tarefas e dizer quais arquivos cada uma toca (`to-tickets`),
executar cada tarefa, pedir um arquivo a mais (`claim`), decidir que está feita e escrever a evidência, pular com
motivo.

---

## 17. Testes

- **Núcleo (`bun test`):** esquema e mensagens do `plan`, inclusive conflito de posse; geração dos tickets e
  `import` de volta; importação dos 24 tickets reais (viram `exclusive`); fronteira com posse, puladas e falhas;
  `claim` negado e concedido; interseção de globs; ciclos; dois `start` na mesma tarefa; `revision` concorrente;
  `resume`; `maxAttempts`; progresso; ledger e `undo` em ordem inversa.
- **Git** (repositório temporário em `D:\claude-cache`): branch da execução, commit só da posse, `done` recusado
  com arquivo fora da posse, `undo` de commit (revert) e de branch; e, para a política opcional, worktree, merge
  limpo, conflito, remoção, `remove-pending`, `gc --scan` achando uma órfã fabricada e não tocando nela sem `--yes`.
- **OpenCode:** sandbox com modelo falso roteirizado chamando `tasks next/start/claim/done` e emitindo duas chamadas
  `subagent` na mesma resposta; a TUI real mostra a seção mudando; a guarda recusa uma edição fora da posse.
- **Claude Code:** `claude plugin validate`, `tsc -p`, `claude plugin test` com desenho do painel, `/tasks`, e a
  guarda recusando `Edit` fora da posse e `Bash git commit`.
- Sem gastar tokens de modelo real.

---

## 18. Ordem de entrega

1. **jlock** (plano e repositório próprios): o CLI de travas com fila, heartbeat, deadlock, lista e force unlock,
   com seus testes de corrida. Pré-requisito de tudo que segue; o goal-tasks o chama como processo.
2. **Núcleo + CLI + ledger.** Formato com posse (adquirida no jlock), `plan`/`validate`/`import`, tickets,
   transições, fronteira com posse, `claim`, `runs`/`resume`/`pause`/`retry`, commit por tarefa,
   `ledger`/`undo`/`effects`, `clean`/`archive`, testes. Já dá para rodar um goal pelo terminal, com tudo rastreado.
3. **OpenCode.** Ferramenta, ligação, contexto, seção, perfis, guarda de posse. Reaproveita o HUD.
4. **Claude Code.** Mod com ferramenta, ligação, painel, `/tasks`, reinjeção, perfil no spawn, guarda de posse e de
   git, liberação de agente morto.
5. **Skill.** A pergunta "quais arquivos" no passo 4 e a chamada de `tasks plan` no passo 5 da `to-tickets`; esquema
   anexado; cópia dentro do plugin para o Claude Code.
6. **`gc --scan` como relatório.** Para olhar as órfãs atuais sem tocar nelas; a remoção, quando os três projetos
   terminarem.
7. **Worktrees sob demanda** (política `per-task`), só se uma execução real precisar.
8. **Depois.** Codex e pi pelo CLI; ralph v1 como executor externo, se quiser rodar sem janela aberta.

---

## 19. Riscos e pontos a confirmar

| Ponto | Como resolver |
|---|---|
| Posse declarada no plano fica incompleta (o modelo descobre arquivos durante a tarefa) | `claim` em tempo de execução, logado; no fim, a ferramenta sugere atualizar o plano. Fatias verticais da `to-tickets` já tendem a ter posse bem definida. |
| Guarda de Bash por padrão de comando é imperfeita | Cobre git mutador e os escritores comuns; o `done` confere o `git status` inteiro e recusa qualquer alteração fora da posse, então o que escapar da guarda é pego antes do commit. |
| Testes/builds em paralelo na mesma pasta | `serialize` na execução ou tarefa `exclusive` de integração. |
| Subagentes do Claude Code enxergam a ferramenta do mod? O `tool.call` traz `e.agentId`? | Primeiro teste; os tipos indicam que sim. Alternativas no plano. |
| Espera na fila que nunca termina (dono travado, longo ou morto) | Heartbeat do dono: morto → trava quebrada e registrada; vivo e longo → `--timeout` no `claim` e a tarefa decide; o painel mostra há quanto tempo espera e quem segura. |
| Órfãs e efeitos das execuções de hoje | Fora do alcance do ledger por construção; só relatório via `gc --scan`, remoção quando você quiser e com `--yes`. |
| O avaliador do `/goal` só vê a conversa | A saída de `tasks status` é texto na conversa. Alternativa sem avaliador: Stop hook clássico lendo o arquivo. |
| Largura do painel do Claude Code | Abre sozinho só a partir de ~110–144 colunas; abaixo, `/tasks` à mão. |

Fontes consultadas em 23/10/2026: tipos dos mods do Claude Code (build 2.1.309) e as ferramentas
`EnterWorktree`/`ExitWorktree`/`Agent`; API de plugin do OpenCode 2.1.3; plugin de goal do OpenCode 0.1.68; Codex
CLI (goal, `update_plan`); pi-goal e rpiv-todo; ralph (`files_allowed`) e ralph-v2; skill `to-tickets` e os 24
tickets do spybrowser; herdr worktree; artigos sobre worktrees para agentes paralelos.
