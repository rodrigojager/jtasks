# goal-tasks — regras para quem trabalha neste repositório

Este repositório é o `goal-tasks`: lista de tarefas determinística com dependências e paralelismo por posse de
arquivos, como ferramenta `tasks` (mod do Claude Code, plugin do OpenCode e CLI). O plano completo está em
`docs/PLAN.md`; é a fonte de verdade. Em dúvida, o plano manda. `docs/reference/` guarda os HTML originais, só
como histórico.

## Estado

Fase de planejamento. Não há código nem tickets ainda. Quando houver, os tickets ficam em
`.scratch/goal-tasks/issues/NN-slug.md` e seguem o mesmo processo do jlock: fronteira (menor ticket cujos bloqueios
estão `done`), `**Status:**` no arquivo, critérios `- [ ]`, um commit por ticket (`NN: <título>`).

## Relação com o jlock

A posse de arquivos é imposta pelo `jlock`, um CLI de travas da máquina inteira, com repositório próprio em
`D:\jlock` e instalado em `~\.cargo\bin\jlock.exe`. O goal-tasks o chama como processo (`--json` e códigos de saída);
não existe segunda implementação do protocolo. Referência de uso: `D:\jlock\docs\USAGE.md`; projeto:
`D:\jlock\docs\PLAN.md`. Nunca editar arquivos em `D:\jlock` a partir deste repositório; o que o goal-tasks precisar
do jlock vira pedido no plano do jlock.

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
