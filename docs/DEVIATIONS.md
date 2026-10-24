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
