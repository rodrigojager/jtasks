# jtasks — regras para quem trabalha neste repositório

Este repositório é o `jtasks`: lista de tarefas determinística com dependências e paralelismo por posse de
arquivos, como ferramenta `jtasks` (mod do Claude Code, plugin do OpenCode e CLI). O plano completo está em
`docs/PLAN.md`; é a fonte de verdade. Em dúvida, o plano manda. `docs/reference/` guarda os HTML originais, só
como histórico.

## Estado

Itens 2 a 6 da seção 18 do plano entregues (núcleo + CLI + ledger, plugin do OpenCode, mod do Claude Code, skill
`to-jtasks`, `gc --scan`); itens 7 (worktrees per-task) e 8 (Codex, pi, ralph) ficaram de fora. Os tickets ficam em
`.scratch/jtasks/issues/NN-slug.md` (fora do git) e seguem o mesmo processo do jlock: fronteira (menor ticket
cujos bloqueios estão `done`), `**Status:**` no arquivo, critérios `- [ ]`, um commit por ticket (`NN: <título>`).
Uso em `docs/USAGE.md`; desvios em `docs/DEVIATIONS.md`. Segunda leva (plano rev. 5.2, seção 18 itens 9 a 15):
tickets 19 a 30 (nomes completos dos perfis, posse pelo `hold --detach`/`--release-on-eof`, barra no estilo do HUD,
onze idiomas, `jtasks doctor`, skills por agente, READMEs, teste real do mod), mais o ticket 18 no jlock. Revisão
5.3 (seção 18 item 16, ticket 44): a retomada do orquestrador ocioso (`src/keepalive.ts`, fim de turno no mod e no
plugin, `jtasks keepalive on|off`). Revisão 5.4 (item 17, ticket 45): as travas de tarefas longas são renovadas
pelo mod e pelo plugin (`src/renew.ts`), e o `done` retoma as próprias chaves vencidas. Revisão 5.5 (item 18,
ticket 46): com o jlock 0.2.0, a renovação é `jlock renew`, no lugar, sem soltar a trava. Revisão 5.6 (item 19,
ticket 47): `jtasks yield` cede só os arquivos disputados num deadlock, com as edições guardadas como patch
(`src/patches.ts`, `src/keep.ts`) e reaplicadas com `git apply --3way` quando o arquivo volta; ticket 48: liberar
(release, fim de subagente, resume, posse perdida, fail, skip) também guarda as edições, o `start` as reaplica
(`--fresh` não) e o `done` não é bloqueado pelo que uma tarefa liberada deixou no disco; ticket 49: `shared`,
`touchesShared` e `sharedPolicy` no plano (avisos no `validate`, mutex na fronteira com `serialize`) e
`status --claims`; ticket 50: a guarda de shell lê o comando como o shell (aspas, heredoc, descritores, variáveis
atribuídas no comando, `~`, `cd`, `sed -i`, `cp`) e recusa com `guard.unresolved` o caminho que não dá para conferir.

Layout: `src/` (núcleo, sem dependências; `node-host.ts` é o host do Node), `cli/jtasks.ts`, `dist/` e as cópias em
`opencode/core/` e `claude/core/` (geradas por `bun scripts/build.ts`; `test/build.test.ts` falha se estiverem
velhas), `opencode/` (plugin), `claude/` (mod; tipos em `vendor/claude-code.d.ts`, `tsconfig.claude.json`),
`skills/<agente>/<skill>/` (gerados de `skills/source/` pelo build, que também copia os do Claude Code para o mod). Verificação: `bun test`, `cd opencode && bun test`,
`claude plugin validate claude`, `claude plugin test claude`, `bun run typecheck`, `bun scripts/demo.ts`.

## Relação com o jlock

A posse de arquivos é imposta pelo `jlock`, um CLI de travas da máquina inteira, com repositório próprio em
`D:\jlock` e instalado em `~\.cargo\bin\jlock.exe`. O jtasks o chama como processo (`--json` e códigos de saída);
não existe segunda implementação do protocolo. Referência de uso: `D:\jlock\docs\USAGE.md`; projeto:
`D:\jlock\docs\PLAN.md`. O que o jtasks precisar do jlock é feito lá, pelo processo do jlock: um ticket em
`D:\jlock\.scratch\jlock\issues`, `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, help e
READMEs dos onze idiomas atualizados, um commit por ticket, e `cargo install --path .` para o binário instalado
acompanhar. Nunca editar `D:\jlock` à mão a partir daqui, fora desse processo.

## Regras

- Núcleo em TypeScript sem dependências, compilado para um `core.js` versionado; `bun` para CLI e testes. O módulo
  de hooks do Claude Code roda sem Node e sem `node_modules`.
- O modelo nunca edita `tasks.json`, tickets ou o git à mão: tudo passa pela ferramenta. Isso vale também para quem
  desenvolve esta ferramenta quando a usar em si mesma.
- Tudo que a ferramenta cria fora do código entra no ledger e tem desfazer; nada roda sozinho em projetos
  existentes (`gc --scan` é só relatório; agir exige caminho explícito e `--yes`).
- Testes não gastam tokens de modelo real; repositórios temporários de teste ficam em `D:\claude-cache` e são
  removidos no fim. Processos filhos só os nossos, encerrados por PID.
- Nunca tocar em processos, pastas ou repositórios fora de `D:\goal-tasks` (exceto as pastas temporárias de teste e
  o que o próprio plano manda instalar, quando chegar a hora).
- Mensagens para o usuário em português nos textos de plano e tickets; o código, nomes e comentários em inglês.
- Se algo do plano se mostrar inviável, registrar em `docs/DEVIATIONS.md` (o quê, por quê, o que foi feito no lugar)
  e seguir.
