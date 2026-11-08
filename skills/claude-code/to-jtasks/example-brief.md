# Login por link mágico

**Problema.** Senhas esquecidas são a maior parte dos chamados de suporte. O usuário passa a poder entrar sem
senha: pede um link por email e entra por ele.

**Decisões (não reabrir).**

- Token de uso único, 32 bytes aleatórios em base64url, válido por 15 minutos, guardado no servidor só como hash
  sha256 (tabela `login_tokens`: `hash`, `user_id`, `expires_at`, `used_at`). Nada de JWT.
- Um email desconhecido recebe a mesma resposta que um conhecido (202, sem dizer se a conta existe).
- O login por senha continua como está; nada nele muda.

**Interfaces que as tarefas compartilham.**

- `src/session/types.ts` (criado em T01): `type LoginToken = { hash: string; userId: string; expiresAt: Date; usedAt: Date | null }`.
- `issueToken(userId): Promise<string>` e `consumeToken(token): Promise<string | null>` em `src/session/token.ts`
  (T02); `consumeToken` devolve o `userId`, ou `null` se vencido ou já usado.
- URL do link: `${APP_URL}/login/email/<token>`.

**Convenções.**

- Código, nomes e mensagens de commit em inglês; textos para o usuário em português.
- Testes com `bun test`, ao lado do código em `tests/`, sem rede: o serviço de email é sempre o falso de
  `tests/fakes/mail.ts`.
