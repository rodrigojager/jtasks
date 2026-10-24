# jtasks — plano

Lista de tarefas determinística, com dependências e paralelismo, acompanhada por uma barra de progresso e um
checklist no Claude Code (mod) e no OpenCode (plugin), compatível com o `/goal` dos dois.

Revisão 4, 23/10/2026: a posse de arquivos passa a ser imposta por um serviço de travas com fila (pré-requisito,
plano próprio: o jlock, em `D:\jlock\docs\PLAN.md`); worktrees só sob demanda; livro-razão de tudo que a
ferramenta cria. Nada foi implementado ainda.

Revisão 5, 24/10/2026: o jlock existe (0.1.0, testado no Windows) e alguns detalhes saíram diferentes do que a
revisão 4 imaginou. Os ajustes estão marcados com **[rev. 5]**: posse por arquivos e pastas (não por padrões);
posse mantida viva por um `jlock hold` por tarefa; convenção de identidade nas travas; `claim` mapeado nos códigos do
jlock; `serialize` pelo `jlock run`; guarda de edição pela `tasks.json`; Windows primeiro. A seção 20 lista os
comandos exatos. Nenhuma mudança no jlock.

Revisão 5.1, 24/10/2026: o plano pode ser montado em lotes, num rascunho, para não depender de o modelo escrever o
JSON inteiro numa resposta só (limite de tokens de saída) nem reenviar tudo para corrigir uma tarefa. Marcado com
**[rev. 5.1]** nas seções 2, 3, 6 e 17.

Revisão 5.2, 24/10/2026: os itens 2 a 6 da seção 18 estão entregues (tickets 01 a 18) e a revisão absorve o que
saiu diferente e foi aceito (`docs/DEVIATIONS.md`: trava curta de escrita, `done` em três grupos, `attempts` contado
no `start`, perfis apontando agentes existentes, `/jtasks`), renomeia os perfis e agentes para nomes completos no
padrão do OpenCode (`execute`, `execute-deep`, `review`), e acrescenta: posse por `jlock hold --detach --ttl`
(CLI e mod) e `--release-on-eof` (plugin), fim de subagente no OpenCode, barra no estilo do `opencode-hud`, idiomas
(seção 21), `jtasks doctor` (seção 22), skills por agente e READMEs em onze idiomas (seção 23). Marcado com
**[rev. 5.2]**; a seção 18 ganha os itens 9 a 15 (tickets 19 a 30).

> Este arquivo foi convertido em 24/10/2026 de `docs/reference/plano.html` (revisão 4), sem mudança de conteúdo.
> O HTML fica como referência histórica; a partir daqui, a fonte de verdade é este Markdown.

---

## 1. As decisões

- **A fonte da verdade é um arquivo JSON por execução, no projeto, escrito só por uma ferramenta.** A ferramenta
  `jtasks` (mod no Claude Code, plugin no OpenCode, CLI no terminal) valida esquema e transições e grava de forma
  atômica. O modelo escolhe a ação; nunca edita JSON nem Markdown.
- **O JSON nasce validado:** a skill entrega o plano pela ferramenta, e os tickets Markdown são gerados dele. O
  passo final da `to-jtasks` chama `jtasks plan`; a ferramenta devolve os erros exatos até passar, e só então grava.
- **Paralelismo por posse de arquivos, na mesma pasta, sem worktrees, com travas de verdade.** Cada tarefa declara
  os arquivos e pastas que vai tocar (**[rev. 5]** uma pasta cobre tudo dentro dela; padrões como `src/*.ts` não
  existem no jlock e são recusados no plano). A posse é adquirida no jlock (CLI de travas da máquina, plano próprio): um
  dono por chave, fila em ordem de chegada para quem espera, dois pedidos simultâneos resolvidos por criação atômica
  de arquivo, travas de processo morto recuperadas por heartbeat, e deadlock detectado antes de entrar na fila. Um
  subagente que precisa de um arquivo não declarado pede com `jtasks claim`: se estiver em uso, ele entra na fila e a
  tarefa ganha uma dependência dinâmica ("aguardando T02: types.ts"), visível no painel. A guarda nas ferramentas
  de edição recusa qualquer escrita fora da posse. O ralph v1 já fazia a posse estática com `files_allowed`; a fila
  e a espera são o que faltava. **[rev. 5]** Uma trava do jlock expira se ninguém a renova por 30 s (é assim que ele
  recupera travas de processos mortos): por isso cada tarefa em andamento tem um `jlock hold` vivo, que renova a
  posse e a devolve quando a tarefa termina. **[rev. 5.2]** Quem segura o `hold` depende da forma da ferramenta:
  o CLI e o mod usam `jlock hold --detach --ttl <prazo>` (o próprio jlock deixa um segundo processo segurando a
  trava; se ninguém a devolver, ela expira no prazo); o plugin do OpenCode, que fica aberto, usa
  `jlock hold --release-on-eof --ttl <prazo>` com a entrada padrão aberta, e a trava some no instante em que a
  janela cai.
- **Commits por tarefa, feitos pela ferramenta.** O subagente não roda git. No `done`, a ferramenta faz `git add` só
  dos arquivos da posse e um commit `T04: título`. Cada tarefa vira um commit isolado: reverter uma tarefa é
  `git revert` de um commit, e o diff de cada tarefa fica auditável.
- **Worktrees existem, mas só quando a execução pede.** Política `worktrees: "none"` por padrão. `"per-task"` fica
  para o caso de tarefas que precisam tocar os mesmos arquivos ao mesmo tempo ou rodar builds que colidem. Quando
  usadas, são registradas, integradas e removidas pela ferramenta.
- **Tudo que a ferramenta cria fora do código entra num livro-razão, e tem desfazer.** Branches, commits, worktrees,
  junções, pastas, linhas em `.git/info/exclude`, arquivos arquivados: cada efeito é um registro com como desfazê-lo.
  `jtasks ledger` lista; `jtasks undo` desfaz na ordem inversa, recusando quando há trabalho não salvo. Nada do que
  fizermos vira caça ao tesouro depois.
- **Os projetos de hoje não são tocados.** `jtasks gc --scan` é só relatório por padrão: lista pastas, tamanhos,
  idades, quem é o dono e se o branch foi integrado. Agir exige o caminho explícito e `--yes`. Nada roda sozinho nos
  três projetos em andamento.
- **Cada execução tem um id, e a interface mostra só a execução ligada à sessão atual.** N janelas no mesmo projeto
  não se misturam; a ligação fica no estado da sessão, não num ponteiro global.
- **Retomar, pausar e tentar de novo são ações da ferramenta.** "De onde parou" é a fronteira do grafo.
- **Tudo de desenvolvimento fica sob `.scratch/jtasks/`**, excluído do git localmente, e some com um comando.
- **Um núcleo compartilhado, em um repositório só; as interfaces só leem; o `/goal` continua sendo o motor.**
  Progresso = `floor(feitas / total × 100)`, com feitas/total, puladas e falhas ao lado.

---

## 2. Arquitetura e pastas

```
projeto/
├─ .scratch/jtasks/                 ← só desenvolvimento (excluído do git em .git/info/exclude)
│   └─ runs/
│       ├─ cursory-261023-k7f2/          ← uma execução (run-id = slug-data-4 aleatórios)
│       │   ├─ draft.json               ← [rev. 5.1] só enquanto o plano é montado em lotes; some no --commit
│       │   ├─ run.json                 ← meta: objetivo, status, política, sessões ligadas
│       │   ├─ tasks.json               ← a lista (fonte da verdade), com a posse de cada tarefa
│       │   ├─ tickets/NN-slug.md       ← gerados a partir do tasks.json (leitura humana)
│       │   ├─ ledger.jsonl             ← cada efeito criado (branch, commit, worktree…) e como desfazer
│       │   └─ log.jsonl                ← cada transição, com hora, ator e evidência
│       └─ auth-261024-p0q9/            ← outra execução, de outra janela
└─ (código do projeto: edições só dentro da posse de cada tarefa)

%USERPROFILE%\.jtasks\
├─ ledger.jsonl                         ← índice global: todo efeito de todos os projetos
└─ archive\<repo>\<run>\                 ← execuções arquivadas

%LOCALAPPDATA%\jlock\                    ← [rev. 5] o quadro de travas, do jlock, da máquina inteira; o jtasks
                                            só o usa pelo CLI (jlock acquire/hold/release/list), nunca lê a pasta

D:\worktrees\<repo>\<run>\<task>\        ← só quando a execução pede worktree

Claude Code: mod `jtasks` (ferramenta + painel + /jtasks)  ─┐  mesmo core.js
OpenCode:    plugin `jtasks` (ferramenta + seção na sidebar) ─┤
Terminal:    CLI `jtasks` (bun)                                  ─┘
```

Núcleo em TypeScript sem dependências, compilado para um `core.js` versionado: o módulo de hooks do Claude Code roda
sem Node e sem `node_modules`, e a cópia final do OpenCode também.

**[rev. 5.2]** O repositório do jtasks, por pasta:

```
src/                 o núcleo (host.ts é o contrato com o mundo; node-host.ts, o host do Node)
locales/<tag>.json   os catálogos de texto (seção 21), embutidos no core.js pelo build
cli/jtasks.ts         o CLI
claude/              o mod (core/ é a cópia do núcleo; skills/ a cópia das skills do Claude Code)
opencode/            o plugin (core/ a cópia do núcleo; agents/ os três agentes prontos, seção 13)
skills/<agente>/<skill>/   to-jtasks e jtasks para claude-code, opencode e codex (seção 23)
docs/                PLAN.md, DEVIATIONS.md, USAGE.md, evidence/
README.md, README.<tag>.md   onze idiomas (seção 23)
```

---

## 3. Do plano às tarefas, sem parser frágil

- A `to-jtasks` (antes `to-tickets`, derivada da skill homônima de Matt Pocock) segue os passos 1 a 4 (contexto, código, fatias verticais, aprovação sua). Ganha uma
  pergunta a mais no passo 4: quais arquivos cada fatia toca. A skill já explora o código, então sabe responder.
- O passo 5 chama `jtasks plan` com a lista em JSON (`id`, `title`, `what`, `dependsOn`, `files`, `acceptance[]`,
  `profile`, `boundary`).
- `jtasks plan` valida e devolve erros exatos: id repetido, dependência inexistente, ciclo, perfil desconhecido,
  posse em comum entre tarefas sem dependência entre si ("T04 e T05 tocam `src/humanizer/move.ts` e podem rodar
  juntas: adicione uma dependência ou separe o arquivo"), **[rev. 5]** padrão em `files` ("`src/*.ts`: o jlock trava
  arquivos e pastas, não padrões; liste os arquivos ou use a pasta `src`"; a forma `pasta/**` é aceita e vira a
  pasta). O modelo corrige e chama de novo. Nada é gravado até passar.
- Ao passar, grava `tasks.json` e gera `tickets/NN-slug.md` (com uma seção Files). O ticket é visão; o JSON é a
  verdade.
- **Em lotes [rev. 5.1].** Um plano grande não precisa caber numa resposta do modelo:
  `jtasks plan --draft` abre um rascunho (`draft.json`, ainda não é execução, não aparece no painel);
  `jtasks plan --add <json>` acrescenta um lote e valida só o que dá para validar dentro dele (esquema, ids, perfis,
  padrões em `files`), devolvendo os erros daquele lote; `jtasks plan --fix <id> <json>` substitui uma tarefa sem
  reenviar as outras; `jtasks plan --show` devolve o resumo do rascunho (ids, títulos, dependências, posse) para o
  modelo conferir sem reler tudo; `jtasks plan --commit` roda a validação completa sobre o conjunto (dependências
  entre lotes, ciclos, conflitos de posse) e, se passar, grava o `tasks.json`, gera os tickets e apaga o rascunho.
  A validação final é uma só e continua determinística. O `jtasks plan <json>` de uma chamada só continua valendo
  (equivale a `--draft`, `--add`, `--commit`). A skill usa lotes de até ~20 tarefas.
- **Um único `tasks.json` por execução [rev. 5.1]**, e é ele que as interfaces mostram: o painel lê `tasks.json`
  (lista, estados, progresso, commits), `run.json` (nome, pausa) e `jlock list --json` (motivos de espera), sem
  nunca escrever; confere a cada 2 s se mudaram e redesenha. Como só a ferramenta grava, e de forma atômica, o painel
  nunca vê um arquivo pela metade.

Tickets antigos: `jtasks import <dir> --check` relata o que leu e o que faltou (os de hoje não têm posse: a
importação marca essas tarefas como `exclusive`, isto é, nunca em paralelo, até alguém declarar os arquivos). Onde a
skill fica: hoje em `~\.agents\skills`; para o Claude Code, dentro do próprio plugin (`skills/`).

---

## 4. Paralelismo por posse de arquivos

### Regras

- `files` é uma lista de arquivos e pastas relativos ao repositório (**[rev. 5]** uma pasta cobre tudo dentro dela,
  pela regra de hierarquia do jlock; `pasta/**` é aceito como açúcar para a pasta; qualquer outro padrão é recusado
  no `plan`). `exclusive: true` significa "toca coisa demais ou desconhecida": roda sozinha.
- **Fronteira:** tarefa pronta = pendente, dependências satisfeitas, e posse livre no jlock (nenhuma chave em uso ou
  em interseção com uma em uso, por qualquer execução, ferramenta ou script na máquina; as chaves são caminhos
  absolutos, e uma pasta travada cobre o que está dentro dela). **[rev. 5]** Interseção é a regra de hierarquia do
  jlock, e só ela: duas chaves conflitam se são iguais ou se uma é pasta acima da outra; `*` conflita com tudo;
  `name:` só com igual. `next` lê `jlock list --json` uma vez e aplica essa regra localmente (o mesmo código da
  validação do plano). `start` adquire todas as chaves da posse de uma vez, em ordem canônica, sem espera
  (`--no-wait`): resposta `queued` (código 10) quer dizer que a tarefa não estava pronta. Uma tarefa `exclusive`
  adquire a chave `*`, que conflita com tudo.
- **Posse viva [rev. 5]:** `start` e `claim` são o mesmo gesto: subir um `jlock hold` e ler a primeira linha. O
  `hold` adquire as chaves (com as mesmas opções do `acquire`), imprime o resultado em JSON e fica vivo renovando o
  heartbeat; o jtasks guarda as chaves de cada `hold` na tarefa (`holds: [{ keys, startedAt }]`).
  **[rev. 5.2]** A forma do `hold` depende do host: o CLI e o mod sobem `jlock hold … --detach --ttl <prazo>`, que
  responde e volta na hora enquanto um segundo jlock segura a trava; o plugin do OpenCode sobe
  `jlock hold … --release-on-eof --ttl <prazo>` em primeiro plano, com a entrada padrão aberta. Em qualquer host,
  `done`, `skip`, `fail` e `release` devolvem a posse com `jlock release --group <run> --owner <dono>` (o `hold`
  termina com 0). O prazo (`holdTtl` no plano, padrão `2h`) é a rede de segurança: se ninguém devolver (agente ou
  janela mortos), a trava expira sozinha. Se um `hold` termina com código 14 (`lost`: alguém usou `unlock --force`,
  o prazo venceu, ou a trava expirou com a máquina dormindo), a ferramenta trata como `release` involuntário: a
  tarefa volta a `pending` (a tentativa já foi contada no `start`), o log registra `lost`, o painel mostra "posse
  perdida: T04". No plugin, a janela cair fecha a entrada padrão e o `hold` solta a trava na hora; no CLI e no mod,
  ela dura até o prazo. É isso que permite `resume` em outra janela sem `unlock --force`.
- **Identidade no jlock [rev. 5]:** dono = `gt:<run>/<task>` (ex.: `gt:cursory-261023-k7f2/T05`), grupo = `<run>`,
  intenção = título da tarefa, meta `task=T05 run=<run> tool=claude|opencode|cli session=<id>`. Com isso,
  `jlock list --group <run> --json` são as travas ativas da execução (para `status`), e
  `jlock list --under <repo> --json` é tudo que está travado no repositório, inclusive por outras janelas, outras
  execuções e outros programas (para o painel). O painel traduz `holder.owner`: mesma execução → `T05`; outra →
  `auth-261024-p0q9/T03`; sem o prefixo `gt:` → "outro programa: <owner>".
- **Validação do plano:** duas tarefas sem relação de dependência e com posse em comum são um erro. Isso força o
  planejador a decidir a ordem na hora do plano, não na hora da execução.
- **Pedido em tempo de execução:** `jtasks claim T04 src/x.ts` adquire a trava no jlock (**[rev. 5]** sobe
  `jlock hold <abs> --owner gt:<run>/T04 --group <run> --intent "<título>" --timeout <t> --json`, com `t` = 60 s
  por padrão ou o `--timeout` do `claim`). Livre → `granted` (código 0): o arquivo entra em `claimed` e o `hold`
  fica. Em uso → a tarefa entra na fila dessa chave e fica `waiting` (estado derivado), com
  `waitingFor: { key, holder: "T05", position, via }` (**[rev. 5]** `via` diz quando o bloqueio vem de uma pasta
  acima ou de um arquivo dentro: "`src/` está com T05", e não `src/x.ts`); a chamada espera até ser atendida ou até
  o prazo (`timeout`, código 11, com `holder` e `position`), e então o subagente decide: continuar esperando, fazer o
  que não depende daquele arquivo, ou `jtasks fail`. Se o pedido criaria um deadlock (T05 já espera por algo de T04),
  o jlock recusa com a cadeia (`deadlock`, código 12, campo `chain`), e a resposta diz quem deve ceder
  (**[rev. 5]** quem pediu por último). Todo `claim` vai para o log; no fim, a ferramenta sugere atualizar o plano
  com o que foi reclamado.
- **Guarda:** no Claude Code, `tool.call` em `Edit`/`Write`/`NotebookEdit` do subagente é recusado fora da posse,
  com a mensagem "fora da posse de T04; use `jtasks claim`". `Bash` de subagente é recusado quando o comando é
  mutador de git (`commit`, `checkout`, `reset`, `stash`, `add`) ou de arquivos (`rm`, `mv`, `>`, `sed -i`) fora
  da posse. Leitura, build e teste são livres. No OpenCode, um hook de permissão aplica as mesmas regras.
  **[rev. 5]** A guarda decide pela `tasks.json` (`files` + `claimed`), sem chamar o jlock a cada edição (um
  processo por edição seria lento e desnecessário): o jlock é o juiz entre processos, a `tasks.json` é a cópia local
  da posse, e o `done` reconcilia as duas (`jlock list --group <run> --json` tem de conter todas as chaves da posse
  da tarefa; se faltar alguma, a posse foi perdida e o `done` é recusado dizendo qual).
- **Builds e testes que colidem** (mesma pasta de saída, mesma porta): a tarefa declara `exclusive: true` ou a
  execução define um `serialize: ["bun test", "dotnet build"]`, e **[rev. 5]** a ferramenta roda cada um desses
  comandos como `jlock run name:gt/<repo-slug>/<comando-slug> -- <comando>`: só um roda por vez na máquina, os
  outros esperam na fila do jlock; nenhuma fila própria. Alternativa: uma tarefa final de integração, bloqueada por
  todas, roda a suíte uma vez.

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
o remédio determinístico é o que a própria `to-jtasks` já manda: pré-refatorar, dividindo o hub em módulos numa
tarefa prévia, para que a posse por arquivo volte a ser fina. Fora isso, as tarefas que tocam o hub rodam em
sequência e as outras em paralelo. A trava por função fica registrada como ideia para o futuro, só se um projeto real
mostrar contenção que a pré-refatoração não resolva.

### Commit por tarefa

No `done`, a ferramenta confere o `git status` e separa as mudanças em três grupos (**[rev. 5.2]**, porque as
tarefas paralelas trabalham no mesmo checkout): da posse da tarefa → vão para o commit; da posse de outra tarefa em
andamento da execução, ou de uma chave que outro dono segura no jlock sob o repositório → ficam no disco, fora do
commit; de ninguém → recusa, lista e pede `claim` ou `release`. Dentro da posse → `git add <arquivos>` e
`git commit -m "T04: título"` no branch da execução
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
  "holdTtl": "2h",                           // [rev. 5.2] prazo dos hold; a trava expira sozinha se ninguém a devolver
  "sessions": [ { "tool": "claude", "id": "a8ec2aca…", "boundAt": "…" } ]
}
```

### tasks.json

```json
{
  "version": 1, "run": "cursory-261023-k7f2", "revision": 41,
  "profiles": {
    "execute":      { "claude": { "model": "sonnet", "effort": "medium", "role": "backend-developer" }, "opencode": { "agent": "execute" } },
    "execute-deep": { "claude": { "model": "opus",   "effort": "high" },                                "opencode": { "agent": "execute-deep" } },
    "review":         { "claude": { "model": "sonnet", "effort": "high",   "role": "code-reviewer" },     "opencode": { "agent": "review" } }
  },
  "tasks": [
    { "id": "T01", "title": "Tornar o movimento substituível", "status": "done",
      "dependsOn": [], "profile": "execute",
      "files": ["src/humanizer/trajectory.ts", "src/humanizer/move.ts", "tests/humanizer/**"],
      "acceptance": [ { "text": "Automação local percorre movimento, hover e clique", "done": true } ],
      "attempts": 1, "owner": null, "startedAt": "…", "finishedAt": "…",
      "commit": "9f1c2ab", "evidence": "bun test: 93 passed; regressão local idêntica antes/depois" },
    { "id": "T02", "title": "Gerador de gravações nativo", "status": "in_progress",
      "dependsOn": ["T01"], "profile": "execute", "files": ["src/recorder/**"],
      "claimed": ["src/humanizer/types.ts"],
      "attempts": 2, "owner": "claude:a8ec2aca/agent:7f3a", "startedAt": "…" },
    { "id": "T03", "title": "Paridade completa", "status": "skipped", "dependsOn": ["T01"], "profile": "execute-deep",
      "files": ["src/humanizer/parity/**"], "reason": "coberto por T01 após a refatoração" },
    { "id": "T04", "title": "Mouse move", "status": "failed", "dependsOn": ["T02"], "profile": "execute",
      "files": ["src/humanizer/move.ts"], "attempts": 2, "error": "src/humanizer/types.ts em uso por T02" },
    { "id": "T05", "title": "Atraso e escala", "status": "pending", "dependsOn": ["T02"], "profile": "execute-deep",
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
| `in_progress` | tem `owner`, `startedAt`, a posse travada e **[rev. 5]** um ou mais `hold` vivos (`holds`) | → `done` (exige `evidence`; faz o commit), → `skipped`, → `failed` (exige `error`), → `pending` por `release` |
| `done` | concluída e commitada | final; `retry` reabre (o commit anterior fica no histórico) |
| `skipped` | pulada com motivo; libera as dependentes | `retry` → `pending` |
| `failed` | erro ou `maxAttempts`; bloqueia as dependentes | `retry` → `pending`; `skip` → `skipped` |

Derivados, nunca gravados: `ready` (pendente, dependências satisfeitas, posse livre), `blocked` (dependência aberta
ou falha, ou posse em uso) e `waiting` (em andamento, na fila de uma chave de outra tarefa). O painel mostra o
motivo: ⛔ T04, 🔒 T02 ou ⏳ T02: types.ts (**[rev. 5]** ou ⏳ T02: src/, quando o bloqueio vem da pasta).

### Regras do núcleo

- ids únicos e estáveis; dependências existentes; sem ciclos; posse sem conflito entre independentes.
- `start` falha se não pronta, com dono, posse em uso, ou execução pausada.
- `done` sem evidência é recusado; com arquivos modificados que não são de ninguém também (os da posse de outra
  tarefa em andamento ficam no disco, fora do commit; seção 4, "Commit por tarefa").
- Gravação atômica (`.tmp` + `rename`), releitura antes de escrever, `revision` incremental, e **[rev. 5.2]** uma
  trava curta por execução em volta de cada leitura-mudança-escrita (a pasta `.write.lock`, criada de forma
  exclusiva; com mais de 10 s é de um processo morto e é quebrada): sem ela, dois processos que leem a mesma revisão
  gravam os dois e uma mudança se perde. A `revision` continua recusando escrita baseada em leitura velha.
- **[rev. 5]** Cada tarefa em andamento guarda seus `hold`s (`holds: [{ keys, startedAt }]`); **[rev. 5.2]**
  qualquer sessão devolve a posse com `jlock release --group <run> --owner <dono>`; nenhum processo é encerrado por
  PID a partir de outra janela.
- **[rev. 5.2]** `attempts` conta no `start` (cada tentativa começada conta uma vez): um `start` que não chegou ao
  `release` (janela morta, posse perdida) também conta; `release`, `resume` e posse perdida comparam com
  `maxAttempts` e viram `failed` quando chega; `retry` zera a contagem (o histórico fica no `log.jsonl`).

---

## 6. A ferramenta `jtasks`

Mesmo nome e contrato nas três formas. Resposta em texto compacto e em JSON. Todas aceitam `run` opcional; sem ele,
a execução ligada à sessão.

| Grupo | Ação | O que faz |
|---|---|---|
| plano | `plan` | cria a execução a partir do JSON validado (inclusive conflito de posse); gera os tickets; cria o branch; liga à sessão; exclui `.scratch/` do git localmente (efeito no ledger) |
| | `plan --draft` / `--add <json>` / `--fix <id> <json>` / `--show` / `--commit` | **[rev. 5.1]** o mesmo, em lotes: rascunho, lote validado, correção de uma tarefa, resumo, validação completa e gravação |
| | `import <dir> [--check\|--yes]` | tickets Markdown antigos → nova execução (tarefas sem posse viram `exclusive`) |
| | `validate <json\|dir>` | valida sem gravar |
| execução | `runs` | lista as execuções do projeto com status e progresso |
| | `resume <run> [--keep-owners]` | liga a sessão, tira de `paused`, libera tarefas de agentes que já não existem, mostra status e fronteira |
| | `pause` / `unpause` | pausa: `start` recusado; o protocolo manda parar |
| | `status` | `feitas 7/12 (58%) · 1 pulada · 1 falha · 2 em andamento · restam 3` + fronteira + travas ativas (**[rev. 5]** de `jlock list --group <run> --json`) |
| tarefa | `next [limit]` | as prontas, com perfil, critérios, posse e caminho do ticket |
| | `start id` | → em andamento (`attempts+1`); trava a posse (**[rev. 5]** sobe `jlock hold <chaves…> --no-wait --json`; `queued` → "não estava pronta"; **[rev. 5.2]** `--detach --ttl` no CLI e no mod, `--release-on-eof --ttl` no plugin) |
| | `claim id <arquivo…>` | acrescenta à posse se livre; senão espera até `--timeout` ("em uso por Txx, posição N") ou recusa por deadlock com a cadeia (**[rev. 5]** um `jlock hold` por `claim`) |
| | `done id --evidence` | confere o status do git e a posse no jlock → commit só da posse → feita → libera a posse (**[rev. 5.2]** `jlock release --group --owner`) |
| | `skip id --reason` / `fail id --error` | pular ou registrar falha; libera a posse |
| | `retry id` / `retry --all-failed` | pulada ou falha → pendente |
| | `release id` | em andamento → pendente (no `maxAttempts` vira `failed`); edições não commitadas ficam no disco e são listadas |
| máquina | `doctor [--json] [--fix [--yes]]` | **[rev. 5.2]** diagnóstico da máquina (seção 22); `--fix --yes` instala o que falta, pelo ledger global |
| | `help [ação]`, `--lang <tag>` | **[rev. 5.2]** ajuda e idioma (seção 21) |
| ledger | `ledger [--all-projects]` | tudo que a ferramenta criou: tipo, caminho, execução, tarefa, hora, estado (ativo/desfeito) |
| | `undo <id> \| --run <run> \| --task id` | desfaz na ordem inversa (revert de commit, remoção de branch/worktree/junção/pasta, linha do exclude); recusa se houver trabalho não salvo |
| | `effects --check` | compara o ledger com o disco e o git: o que sumiu por fora, o que ficou |
| worktrees | `worktrees` | registro da execução × `git worktree list` × disco (só se a política usar) |
| | `gc --scan <raiz> [--yes]` | relatório: pastas, tamanho, idade, repositório dono, branch integrado?; só remove com caminho explícito e `--yes` |
| limpeza | `clean [run\|--all] [--yes]` | remove a pasta da execução; antes, lista os efeitos ainda ativos no ledger e pede confirmação |
| | `archive run` | move para `%USERPROFILE%\.jtasks\archive\<repo>\<run>`; `resume --from-archive` traz de volta |

---

## 7. Livro-razão e desfazer

Toda ação da ferramenta que deixa algo no disco ou no git fora do próprio código da tarefa escreve um registro em
`ledger.jsonl` da execução e no índice global `%USERPROFILE%\.jtasks\ledger.jsonl`:

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
- `jtasks ledger` responde "o que está sendo feito" em qualquer momento, por execução ou por projeto, inclusive de
  outras janelas, porque o índice global é um arquivo só.
- `jtasks undo` desfaz na ordem inversa e marca `state: "undone"`. Recusa quando o alvo tem mudanças não salvas
  (worktree suja, branch com commits não integrados) e diz o que fazer. Um `git revert` cria um commit novo, que
  também entra no ledger.
- `jtasks effects --check` acha o que foi removido por fora (pasta apagada à mão) e marca `state: "gone"`, e o que
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
- Interface: só a execução ligada; sem ligação, a lista de `jtasks runs`.
- Duas janelas na mesma execução dividindo a fronteira: funciona, por dono único, posse e `revision`.
- Duas execuções no mesmo projeto ao mesmo tempo: as travas do jlock são da máquina inteira (registro em
  `%LOCALAPPDATA%\jlock`), não da execução. Duas execuções, ou um Claude Code e um OpenCode em janelas diferentes,
  disputam os mesmos arquivos pela mesma fila; quem chegou depois espera. O painel mostra
  "aguardando auth-261024-p0q9/T03" (**[rev. 5]** lendo `jlock list --under <repo> --json` a cada 2 s, junto com a
  `tasks.json`).

---

## 9. Retomar, pausar, tentar de novo

- **Retomar:** `jtasks resume <run>` em qualquer janela. A posição é a fronteira; `next` devolve as primeiras não
  executadas. Tarefas em andamento de agentes mortos são liberadas (as edições não commitadas ficam no disco e são
  listadas para a próxima tentativa aproveitar ou descartar). **[rev. 5]** Como: `resume` compara cada tarefa
  `in_progress` com `jlock list --group <run> --json`: sem as suas travas → `release` automático (a tentativa já
  foi contada no `start`; no `maxAttempts` vira `failed`). **[rev. 5.2]** As travas da janela morta somem na hora
  no plugin (`--release-on-eof`) e no prazo `holdTtl` no CLI e no mod. Uma tarefa que ainda tem as travas (janela
  viva em outro lugar) fica como está; `--keep-owners` não libera nenhuma tarefa, nem as sem travas.
- **Pausar:** `jtasks pause`: `start` recusado; o resumo no prompt diz "pausada: não inicie tarefas"; os subagentes
  em andamento terminam.
- **Tentar de novo:** `jtasks retry T04`; histórico no `log.jsonl`; `attempts` conta.
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
  execução, nunca no seu checkout. Conflito → `failed`; `jtasks merge` depois de resolver.
- Dependências sem cópia (NTFS não tem copy-on-write): pnpm store com hard links; ou junção de `node_modules` para o
  checkout principal com lockfile igual; ou instalação própria só se o lockfile mudou. Estratégia registrada.
- Remoção após o merge; arquivo aberto no Windows → `remove-pending` e nova tentativa no `gc`. Nunca mata processos.
- Guarda de escopo: subagente só edita dentro da sua worktree.

O que já existe (Claude Code `EnterWorktree`/`Agent isolation`, OpenCode API worktree, herdr worktree) cria mas não
integra nem limpa; é daí que vêm as órfãs. Não vamos usar essas rotas para subagentes; quando a nossa política criar
worktree, é a ferramenta que cria, registra e remove.

---

## 11. Limpar e arquivar

- Tudo em `.scratch/jtasks/`, excluído do git em `.git/info/exclude` (local). Tickets antigos ficam onde estão.
- `jtasks clean <run>`: mostra os efeitos ainda ativos no ledger (branch, worktrees) e pergunta se desfaz junto;
  apaga a pasta da execução. `--all` remove `.scratch/jtasks/`. Os commits ficam (são código).
- `jtasks archive <run>`: move para fora do projeto; `resume --from-archive` traz de volta.
- Plano novo num projeto com N planos antigos: outra execução, ligada à sessão; os antigos só aparecem em
  `jtasks runs`.

---

## 12. O fluxo com o `/goal`

```
Planejar     to-jtasks (passos 1–4, agora com "quais arquivos") → jtasks plan
Claude Code  /goal todas as tarefas da execução cursory-261023-k7f2 estão done ou skipped
             (a ferramenta tasks responde "restam 0")
OpenCode     create_goal com o mesmo objetivo; update_goal com a saída de jtasks status
Retomar      em qualquer janela: jtasks resume cursory-261023-k7f2 → /goal de novo
```

Protocolo de execução (texto fixo, injetado no sistema enquanto houver execução ligada):

```
1. Chame jtasks next.
2. Para cada tarefa devolvida, abra um subagente com o perfil indicado, todos na mesma
   mensagem (paralelo). O prompt leva só: --run <id> --task <id>, título, critérios, posse
   (os arquivos que pode tocar), caminho do ticket, e "chame jtasks start no começo; se precisar
   de outro arquivo, jtasks claim; não rode git; no fim, jtasks done com evidência ou jtasks fail".
3. Quando terminarem, chame jtasks status. "restam 0" → goal cumprido com essa saída como
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

### Os perfis **[rev. 5.2]**

Nomes completos, no padrão dos agentes do OpenCode (`build`, `plan`): `execute` (sonnet, esforço médio, papel
`backend-developer`; agente `execute`), `execute-deep` (opus, esforço alto; agente `execute-deep`) e `review`
(sonnet, esforço alto, papel `code-reviewer`; agente `review`). `execute` é o padrão. O plano pode trazer os seus
próprios perfis, com qualquer nome, apontando qualquer agente que já exista.

### OpenCode

Agentes do `opencode.json` ou de `~/.config/opencode/agents/<nome>.md`, com `model: { providerID, modelID, variant }`.
O orquestrador chama `subagent`; a chamada de uma tarefa (`--task <id>` no prompt) recebe o agente do perfil dela, e
perfil desconhecido recusa a chamada. **[rev. 5.2]** A API do plugin não cria agentes (o editor de `agent.transform`
não tem `add`): os perfis apontam agentes existentes, e o pacote traz os três agentes prontos em
`opencode/agents/<nome>.md` (`mode: subagent`, o protocolo da tarefa no corpo), que o `jtasks doctor --fix` instala em
`~/.config/opencode/agents/` (efeito `install` no ledger global). Um perfil com `opencode.model` dá esse modelo ao
agente por `agent.transform`, só durante a sessão; não há efeito `agent-config`. Depois de `plan --commit` e
`resume`, o plugin avisa se um perfil aponta um agente que não existe.

---

## 14. Claude Code: o mod

```
.claude-plugin/plugin.json   { name: "jtasks", version, description, types: "./types/index.d.ts" }
hooks/hooks.json             { "modules": ["./register.tsx"] }
hooks/register.tsx           o módulo (importa ../core/core.js)
types/index.d.ts             PluginState: { "jtasks": { run?: string, collapsed: boolean, view, agents } }
skills/<skill>/SKILL.md      [rev. 5.2] to-jtasks e jtasks, cópias de skills/claude-code/ feitas pelo build
core/core.js                 a cópia do núcleo (e dos catálogos de idioma)
```

| Peça | API do mod | Função |
|---|---|---|
| ferramenta | `$.tool.register` em `session.start` | a `jtasks`; arquivos via `$.fs`; git e jlock via `$.process.run`; **[rev. 5.2]** `jlock hold --detach --ttl` via `$.process.run` (uma chamada, resposta na mão; o jlock segura a trava); renomear, apagar e criar pasta por `$.process.run` (`cmd` no Windows, `mv`/`rm`/`mkdir` fora dele), porque `$.fs` não os tem |
| ligação | `$.state` (`run`) | execução da sessão; subagentes compartilham |
| painel | `$.ui.open({ id: "tasks" })` + `ui.render` em `{ component: "Pane" }` | checklist + barra; abre sozinho com execução ligada e largura suficiente |
| toggle | `$.command.register({ name: "jtasks" })` + `command.run`; botão "▾/▸" via `ui.press` | **[rev. 5.2]** `/jtasks` abre/fecha (o Claude Code já tem `/tasks`); o botão recolhe para uma linha; `collapsed` em `$.store` |
| atualização | `$.clock.every(2000)` + `$.fs.stat/read`; `atom/update` | acompanha escritas de outro processo |
| contexto | **[rev. 5.2]** `prompt.compose`: a seção `jtasks:protocol` acrescentada a cada requisição enquanto há execução ligada | resumo sempre no prompt; volta sozinho depois da compactação (não existe `prompt.section`) |
| perfil | `on("agent.spawn")` | modelo do subagente pelo perfil |
| guarda de posse | `on("tool.call", { tool: "Edit" \| "Write" \| "NotebookEdit" \| "Bash" })` com `e.agentId` | recusa edição fora da posse; recusa git mutador e escrita por shell fora da posse; recusa edição direta de `tasks.json` |
| agente morto | `on("turn.complete")` com `e.agentId` | `release` da tarefa que ficou em andamento (**[rev. 5]** e `release` aos seus `hold`s) |

```
▾ Tasks · cursory-261023-k7f2
████████▌░░░░░░░  58% · 7/12 · 1 pulada · 1 falha
☑ T01 Movimento substituível      9f1c2ab
☑ T02 Gerador nativo              3be77d0
⊘ T03 Paridade completa
✗ T04 Mouse move                  types.ts em uso por T02
◐ T05 Atraso e escala             execute-deep·opus
☐ T06 Fill/clear                  ⛔ T04
☐ T07 Insert text                 🔒 T05
…
```

Recolhido: `▸ Tasks 7/12 · 58%`. Pausado: `Tasks · pausada`. Sem ligação: a lista de `jtasks runs`.

---

## 15. OpenCode: o plugin

| Peça | API | Função |
|---|---|---|
| ferramenta | **[rev. 5.2]** `ctx.tool.transform(editor => editor.add(…))` | a `jtasks`, lado servidor; `jlock hold --release-on-eof --ttl` em primeiro plano, entrada padrão aberta (a janela cair solta a trava) |
| ligação | `ctx.storage` por sessão raiz (`binding/<raiz>`), achada subindo os `parentID` | execução da sessão; a sessão filha que fez `start`/`claim` fica ligada à tarefa (`task/<sessão>`) |
| contexto | `ctx.session.hook("context")` e `("compaction")` | resumo em cada requisição |
| seção | `context.ui.slot({ append: "sidebar.content" })` | "▾ Tasks · run", barra e checklist; clique dobra. **[rev. 5.2]** A barra é nossa (`src/view.ts`), no visual do `Meter` do `opencode-hud` (oitavos de célula, cor principal do tema, trilho apagado), sem depender do HUD instalado |
| dados | RPC `jtasks.state` (`ctx.rpc.register`; o id do RPC é o do plugin) + releitura após `session.tool.success` e a cada 2 s com tarefa em andamento | a TUI nunca toca o arquivo |
| perfis | `agent.transform` (modelo do perfil) + `tool.hook("execute.before")` (agente da tarefa na chamada `subagent`) | agentes `execute`/`execute-deep`/`review` existentes (seção 13) |
| guarda de posse | `ctx.permission.hook("evaluate")` (`edit` e `shell`) | mesmas regras do mod, pela regra do núcleo |
| agente morto | **[rev. 5.2]** `ctx.event.subscribe` em `session.idle` (sessão filha) e `session.deleted` | tarefa ainda em andamento → `release`, log `agent-ended` |
| goal | sem espelhar em `update_goal_plan` | objetivo + evidência; o paralelismo é nosso |

---

## 16. Onde fica o determinismo

**Determinístico (código):** esquema e validação do plano (inclusive conflito de posse), geração dos tickets,
transições, fronteira com posse (**[rev. 5]** pela regra de hierarquia do jlock), posse viva pelos `hold`s,
ciclos, dono único, `revision`, gravação atômica, progresso, ligação sessão →
execução, pausa, retomada, falha por `maxAttempts`, guarda de posse e de git, commit por tarefa, ledger e desfazer,
worktrees quando pedidas, `gc` como relatório, limpeza e arquivamento, desenho das interfaces, reinjeção após
compactação, modelo do subagente pelo perfil, liberação de tarefa de agente morto.

**Interpretativo (modelo):** quebrar o plano em tarefas e dizer quais arquivos cada uma toca (`to-jtasks`),
executar cada tarefa, pedir um arquivo a mais (`claim`), decidir que está feita e escrever a evidência, pular com
motivo.

---

## 17. Testes

- **Núcleo (`bun test`):** esquema e mensagens do `plan`, inclusive conflito de posse; geração dos tickets e
  `import` de volta; importação dos 24 tickets reais (viram `exclusive`); fronteira com posse, puladas e falhas;
  `claim` negado e concedido; interseção de globs; ciclos; dois `start` na mesma tarefa; `revision` concorrente;
  `resume`; `maxAttempts`; progresso; ledger e `undo` em ordem inversa.
- **jlock real [rev. 5]** (binário instalado no `PATH`; `JLOCK_HOME` temporário por teste; tempos curtos por
  `JLOCK_HEARTBEAT_MS`/`JLOCK_STALE_MS`): `start` sobe o `hold` e a trava aparece em `jlock list --group`; matar o
  processo que faz as vezes da janela (filho nosso, por PID) → trava expira e `resume` libera a tarefa; `claim` de
  arquivo em uso → `waiting` com `holder`/`position`/`via`; `claim` que fecharia ciclo → recusado com `chain`;
  `done` com trava perdida → recusado; `serialize` roda dois comandos em sequência pelo `jlock run`; `plan` recusa
  `src/*.ts` e aceita `src/**`.
- **Plano em lotes [rev. 5.1]:** três lotes com dependência cruzada passam no `--commit`; ciclo entre lotes e
  conflito de posse entre lotes só aparecem no `--commit`, com a mensagem exata; `--fix` corrige uma tarefa e o
  `--commit` passa; o rascunho não aparece em `runs` nem no painel e some depois do `--commit`; `plan <json>` numa
  chamada só dá o mesmo `tasks.json` que os lotes.
- **Git** (repositório temporário em `D:\claude-cache`): branch da execução, commit só da posse, `done` recusado
  com arquivo fora da posse, `undo` de commit (revert) e de branch; e, para a política opcional, worktree, merge
  limpo, conflito, remoção, `remove-pending`, `gc --scan` achando uma órfã fabricada e não tocando nela sem `--yes`.
- **OpenCode:** sandbox com modelo falso roteirizado chamando `jtasks next/start/claim/done` e emitindo duas chamadas
  `subagent` na mesma resposta; a TUI real mostra a seção mudando; a guarda recusa uma edição fora da posse.
- **Claude Code:** `claude plugin validate`, `tsc -p`, `claude plugin test` com desenho do painel, `/jtasks`, e a
  guarda recusando `Edit` fora da posse e `Bash git commit`.
- **[rev. 5.2] Idiomas, doctor, skills e READMEs:** os catálogos têm as mesmas chaves e marcadores; a mesma ação
  em dois idiomas dá textos diferentes e o mesmo `--json`; `help` cabe em 100 colunas em cada idioma; `doctor` num
  ambiente sadio, com `JTASKS_HOME` inválido, sem jlock e sem agentes; `doctor --fix --yes` numa casa temporária
  (o instalador do jlock substituído por um script falso); as seis skills com as mesmas seções; os onze READMEs com
  a mesma forma e os exemplos reexecutados.
- **[rev. 5.2] O único teste que gasta tokens**, fora do `bun test`: o mod num Claude Code real, dirigido pelo
  herdr, com haiku e um roteiro curto (ticket 30), porque `claude plugin test` roda numa máquina falsa.
- Sem gastar tokens de modelo real.

---

## 18. Ordem de entrega

1. **jlock** (plano e repositório próprios): o CLI de travas com fila, heartbeat, deadlock, lista e force unlock,
   com seus testes de corrida. Pré-requisito de tudo que segue; o jtasks o chama como processo.
   **[rev. 5] Feito:** 0.1.0 em 24/10/2026, validado no Windows; a fase 2 (idiomas, help, doctor, instalador,
   update) está em andamento e não muda o protocolo.
2. **Núcleo + CLI + ledger.** Formato com posse (adquirida no jlock instalado), `plan`/`validate`/`import`, tickets,
   transições, fronteira com posse, `claim`, `runs`/`resume`/`pause`/`retry`, commit por tarefa,
   `ledger`/`undo`/`effects`, `clean`/`archive`, testes. Já dá para rodar um goal pelo terminal, com tudo rastreado.
3. **OpenCode.** Ferramenta, ligação, contexto, seção, perfis, guarda de posse. Barra própria no visual do HUD.
4. **Claude Code.** Mod com ferramenta, ligação, painel, `/jtasks`, reinjeção, perfil no spawn, guarda de posse e
   de git, liberação de agente morto.
5. **Skill.** A pergunta "quais arquivos" no passo 4 e a chamada de `jtasks plan` no passo 5 da `to-jtasks`; esquema
   anexado; cópia dentro do plugin para o Claude Code.
6. **`gc --scan` como relatório.** Para olhar as órfãs atuais sem tocar nelas; a remoção, quando os três projetos
   terminarem.
   **[rev. 5.2] Feito:** itens 2 a 6 entregues nos tickets 01 a 18 (24/10/2026).
7. **Worktrees sob demanda** (política `per-task`), só se uma execução real precisar.
8. **Depois.** Codex e pi pelo CLI; ralph v1 como executor externo, se quiser rodar sem janela aberta.

**[rev. 5.2]** A segunda leva, tickets 19 a 30 (e 18 no jlock):

9. **Plano 5.2 e desvios didáticos** (ticket 19): este documento; `DEVIATIONS.md` no formato "o que mudou,
   consequência, o que fazer".
10. **Nomes completos** (20): perfis e agentes `execute`/`execute-deep`/`review`; os agentes prontos no pacote do
    OpenCode; aviso de agente inexistente.
11. **Posse pelo jlock nativo** (J18 no jlock, 21, 22): `hold --release-on-eof` no jlock; `--detach --ttl` no CLI e
    no mod, `--release-on-eof --ttl` no plugin, `holdTtl` no plano; fim de subagente no OpenCode devolve a tarefa.
12. **Barra no estilo do HUD** (23).
13. **Idiomas** (24, 25, 26): núcleo e CLI em `en`/`pt-BR`; mod e plugin; os outros nove catálogos.
14. **Skills e doctor** (27, 28): `to-jtasks` e `jtasks` para Claude Code, OpenCode e Codex; `jtasks doctor` e
    `--fix --yes` (jlock, agentes, skills, pelo ledger global).
15. **READMEs em onze idiomas e o teste real do mod** (29, 30).

---

## 19. Riscos e pontos a confirmar

| Ponto | Como resolver |
|---|---|
| Posse declarada no plano fica incompleta (o modelo descobre arquivos durante a tarefa) | `claim` em tempo de execução, logado; no fim, a ferramenta sugere atualizar o plano. Fatias verticais da `to-jtasks` já tendem a ter posse bem definida. |
| Guarda de Bash por padrão de comando é imperfeita | Cobre git mutador e os escritores comuns; o `done` confere o `git status` inteiro e recusa qualquer alteração fora da posse, então o que escapar da guarda é pego antes do commit. |
| Testes/builds em paralelo na mesma pasta | `serialize` na execução ou tarefa `exclusive` de integração. |
| Subagentes do Claude Code enxergam a ferramenta do mod? O `tool.call` traz `e.agentId`? | Primeiro teste; os tipos indicam que sim. Alternativas no plano. |
| Espera na fila que nunca termina (dono travado, longo ou morto) | Heartbeat do dono: morto → trava quebrada e registrada; vivo e longo → `--timeout` no `claim` e a tarefa decide; o painel mostra há quanto tempo espera e quem segura. |
| Órfãs e efeitos das execuções de hoje | Fora do alcance do ledger por construção; só relatório via `gc --scan`, remoção quando você quiser e com `--yes`. |
| O avaliador do `/goal` só vê a conversa | A saída de `jtasks status` é texto na conversa. Alternativa sem avaliador: Stop hook clássico lendo o arquivo. |
| Largura do painel do Claude Code | Abre sozinho só a partir de ~110–144 colunas; abaixo, `/jtasks` à mão. |
| **[rev. 5.2]** Um Claude Code que cai deixa a trava até o `holdTtl` | O mod não sabe o PID do Claude Code e `$.process.spawn` fecha a entrada padrão na partida, então nem `--release-on-eof` nem `--parent` servem; o prazo (`2h` por padrão) é a rede. Se pesar, um `jlock hold --parent <pid>` no plano do jlock. |
| **[rev. 5.2]** `doctor --fix` instala o jlock pelo instalador oficial | O instalador do jlock acrescenta a pasta ao `PATH` do usuário (comportamento dele, documentado); o jtasks não mexe no `PATH` por conta própria e registra o binário instalado no ledger global para o desfazer. |
| **[rev. 5]** Windows primeiro | O jlock só foi validado no Windows; o jtasks nasce com a mesma restrição, dita no README. Linux e macOS vêm quando o plano Linux/macOS do jlock for executado; nada no jtasks depende de API do Windows. |
| **[rev. 5]** Um processo `hold` por tarefa e por `claim` | Dezenas de processos de ~1 MB, dormindo; aceitável. Se pesar, o jlock pode ganhar depois um `hold` que renove várias chaves de donos diferentes; o jtasks não muda. |
| **[rev. 5]** Posse perdida no meio (`hold` saiu com 14) | A tarefa volta a `pending` com `attempts+1`; as edições ficam no disco e são listadas; o painel mostra "posse perdida"; o log diz quem forçou (vem do `log.jsonl` do jlock, campo `by`). |

Fontes consultadas em 23/10/2026: tipos dos mods do Claude Code (build 2.1.309) e as ferramentas
`EnterWorktree`/`ExitWorktree`/`Agent`; API de plugin do OpenCode 2.1.3; plugin de goal do OpenCode 0.1.68; Codex
CLI (goal, `update_plan`); pi-goal e rpiv-todo; ralph (`files_allowed`) e ralph-v2; skill `to-tickets` (Matt Pocock) e os 24
tickets do spybrowser; herdr worktree; artigos sobre worktrees para agentes paralelos.

---

## 20. Como o jtasks fala com o jlock **[rev. 5]**

Tudo pelo CLI instalado (`jlock` no `PATH`), sempre com `--json`, sempre com caminhos absolutos. O jtasks nunca
lê nem escreve em `%LOCALAPPDATA%\jlock`.

| Ação do jtasks | Comando jlock | O que importa na resposta |
|---|---|---|
| `next` (posse livre?) | `jlock list --under <repo> --json` | `locks[].key`, `holder.owner`, `queue[]`; a regra de hierarquia decide o conflito localmente |
| `start T04` | `jlock hold <chave…> --no-wait --ttl <holdTtl> --owner gt:<run>/T04 --group <run> --intent "<título>" --meta task=T04 --meta run=<run> --meta tool=<claude\|opencode\|cli> --json`, **[rev. 5.2]** com `--detach` (CLI, mod: responde e volta; o jlock segura) ou `--release-on-eof` (plugin: processo residente com a entrada padrão aberta) | primeira linha: `granted` ou `queued` + código 10 ("não estava pronta"); `exclusive` usa a chave `*` |
| `claim T04 <arquivo>` | `jlock hold <abs> --timeout <t> --ttl <holdTtl> --owner gt:<run>/T04 --group <run> --intent "<título>" --json`, com o mesmo `--detach`/`--release-on-eof` do host | `granted` (0); `timeout` (11) com `holder`, `position`, `via`; `deadlock` (12) com `chain` |
| `done` / `skip` / `fail` / `release` | **[rev. 5.2]** `jlock release --group <run> --owner gt:<run>/T04 --json` (o `hold` termina com 0) | `released` (0); `not_owner` (13) = a posse já não era nossa |
| início de cada processo | **[rev. 5.2]** `jlock --version` uma vez (cacheado) | ≥ 0.1.1 para `--release-on-eof`; abaixo de 0.1.0 a ferramenta recusa e sugere `jlock update` |
| `done` (conferência) | `jlock list --group <run> --json` | todas as chaves da posse da tarefa presentes com `holder.owner` = o nosso; senão, recusa |
| `status` | `jlock list --group <run> --json` | travas ativas da execução |
| painel (a cada 2 s) | `jlock list --under <repo> --json` | tudo travado no repositório, por qualquer janela ou programa |
| `resume` | `jlock list --group <run> --json` | tarefa `in_progress` sem suas travas → `release` automático |
| `serialize` | `jlock run name:gt/<repo-slug>/<comando-slug> -- <comando>` | código de saída do comando; 11 se `--timeout` for dado e vencer |
| emergência (pessoa) | `jlock unlock --group <run> --force --by gt:<run> --reason "…"`; `jlock graph`; `jlock list --watch` | o `hold` afetado sai com 14 e a tarefa volta a `pending` |

Códigos do jlock que o jtasks traduz: 0 ok; 10 ocupado; 11 prazo; 12 deadlock; 13 não é o dono; 14 posse
perdida; 20 erro de disco (vira erro da ferramenta, com a mensagem do jlock); 2 uso errado (bug nosso: registrar).

Tempos: o jtasks não mexe em `JLOCK_HEARTBEAT_MS`/`JLOCK_STALE_MS` em produção (5 s / 30 s); só os testes usam
valores curtos. **[rev. 5.2]** Todo processo `jlock` recebe `JLOCK_LANG` com o idioma escolhido (seção 21), para as
mensagens dele que citamos saírem no mesmo idioma.

---

## 21. Idiomas **[rev. 5.2]**

Os mesmos onze do jlock: `en` (referência e reserva para chave que falte), `pt-BR`, `es`, `fr`, `de`, `it`, `zh-CN`,
`ja`, `ru`, `ar`, `hi`. Catálogos em `locales/<tag>.json`, embutidos no `core.js` pelo build (o mod e o plugin os
carregam com o núcleo); `_glossary` no topo de cada um (tarefa, execução, posse, trava, fila, tentativa, ticket,
efeito, desfazer), coerente com o glossário do jlock. Escolha: `--lang <tag>` > `JTASKS_LANG` > `JLOCK_LANG` >
idioma do sistema (`Intl`; o host informa o seu quando a API dá) > `en`, com os apelidos do jlock (`pt` → `pt-BR`,
`zh` → `zh-CN`, `es-MX` → `es`). `{marcadores}` e plural por `_one`/`_other` com `{n}`.

O que não muda com o idioma: nomes de ações e opções, `--json`, ids de tarefa e execução, `tasks.json`, `run.json`,
`log.jsonl`, o ledger, os títulos de seção dos tickets gerados (o formato do jlock: `What to build`, `Blocked by`,
`Status`, `Files`, `Scope boundary`), e o que é para o modelo: a descrição da ferramenta e o protocolo injetado no
prompt (inglês). `jtasks help` sai no idioma e cabe em 100 colunas (largura dupla conta 2). `CONTRIBUTING.md` diz
como adicionar um idioma e que revisão de texto é bem-vinda em qualquer um; cinco idiomas entram "revisão nativa
pendente", como no jlock.

---

## 22. `jtasks doctor` **[rev. 5.2]**

`jtasks doctor [--json]` diz se a máquina está pronta, no modelo do `jlock doctor`: (1) versão do jtasks e
`bun`; (2) `git`; (3) `jlock` no `PATH`, versão mínima, e o `jlock doctor --json` resumido; (4) `JTASKS_HOME`
e o ledger global; (5) OpenCode: pasta de configuração, os três agentes, o plugin citado (informativo); (6) Claude
Code: `claude` e o mod (informativo); (7) as skills nas pastas dos três agentes; (8) o idioma e de onde veio. Cada
`warn`/`fail` diz o que fazer; saída 0 sem `fail`, 20 com. Só lê.

`jtasks doctor --fix` lista o que instalaria; `--fix --yes` age: o jlock pelo instalador oficial do release
(`install.ps1`/`install.sh`), os três agentes em `~/.config/opencode/agents/`, as skills em `~/.claude/skills`,
`~/.config/opencode/skills` e `~/.agents/skills`. Nunca sobrescreve um arquivo existente com conteúdo diferente
(mantém e avisa), nunca mexe no `PATH`, nunca instala o mod no Claude Code nem o plugin no OpenCode (diz como).
Cada arquivo criado é um efeito `install` no ledger global, e `jtasks undo --effect <id>` o remove.

---

## 23. Skills e READMEs **[rev. 5.2]**

`skills/<agente>/<skill>/`, como no jlock, para `claude-code`, `opencode` e `codex`: `to-jtasks` (planejar: a
pergunta "quais arquivos", o JSON em lotes pela ferramenta) e `jtasks` (executar pelo CLI quando não há mod nem
plugin: identidade `--run`/`--task`, o laço `next` → `start` → trabalho na posse → `claim` → `done`/`fail` →
`status`, o que fazer em `timeout`/`deadlock`/posse perdida, ser o orquestrador com ou sem `/goal`). Cada versão usa
o nome da ferramenta no seu host; `skills/README.md` traz a tabela de pastas e os comandos de uma linha; o build
copia as do Claude Code para `claude/skills/`; o `doctor --fix` instala.

Com o mod ou o plugin, o protocolo vem injetado e a skill `jtasks` não é necessária: `to-jtasks` planeja,
`/goal` (ou `create_goal`) recebe "todas as tarefas da execução `<run>` estão done ou skipped", e a cada volta o
modelo chama `next`, abre os subagentes e chama `status`. Sem mod nem plugin (um terminal, o Codex), a skill
`jtasks` é o protocolo: o agente repete `next` até "restam 0" ele mesmo.

`README.md` didático, no modelo do jlock (por quê, o problema, como funciona com um diagrama Mermaid, instalar com
`jtasks doctor`, cinco minutos com saídas reais, com Claude Code, com OpenCode, de um terminal ou Codex, garantias e
limites, configuração, contribuir, autor, licença), e `README.<tag>.md` nos outros dez idiomas com a mesma barra de
idiomas; um teste reexecuta os blocos marcados e confere a forma dos onze arquivos.
